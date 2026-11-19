// Full-text search engine. Ground truth is exact substring matching over the RAW text (punctuation and all),
// so pasted commands like `git push --force-with-lease` or `User::query()` are found exactly.
// On top: smart case, diacritic folding, BM25-like ranking with proximity + filename/heading boosts,
// Markdown context classification, filters, and a typo-tolerant fallback.
// Pure TS (no DOM). Runs in a Web Worker in the app; directly in Node for tests.
import { languageById } from '@shared/languages';
import type { MatchRange, SearchDoc, SearchMatch, SearchOptions, SearchResponse, SearchResult, HeadingHit, MatchContext } from './types';
import { parseQuery, compileRegex, type Atom, type Clause, type Filter, type ParsedQuery, type TextAtom } from './query';
import { classifyAt, parseStructure, K_FM, K_HEADING, type DocStructure, type InlineSpan, type Classification } from './markdown';
import { foldDiacritics, foldTerm, hasDiacritics, isAscii, isWholeWord, lineOfOffset, lowerAligned, normalizeEol, type FoldedText } from './text';
import { Vocabulary, type Suggestion, type VocabCandidate } from './typo';

const NO_TOKENS = new Uint32Array(0);
import { fuzzyMatch, fuzzyMatchPath } from './fuzzy';

export interface Entry {
  id: number;
  path: string;
  pathLower: string;
  baseStart: number; // offset of the basename within path
  content: string;
  lower: string;
  ascii: boolean;
  folded?: FoldedText;
  s: DocStructure;
  /** Vocabulary ids of the document's unique words. */
  tokens: Uint32Array;
  mtime?: number;
}

/** A hit: absolute offsets into the doc, plus which clause produced it. */
export interface Hit {
  start: number;
  end: number;
  clause: number;
}

interface Compiled {
  atom: Atom;
  /** Calls cb(start, end) for each non-overlapping hit in content; stop when cb returns false. */
  scan(e: Entry, cb: (s: number, en: number) => boolean | void): void;
  /** Ranges in the path (case-insensitive), or null. */
  pathRanges(e: Entry): MatchRange[] | null;
}

export interface Plan {
  pq: ParsedQuery;
  positive: Array<{ clause: Clause; atoms: Compiled[]; index: number }>;
  negative: Compiled[];
  fileFilter: (e: Entry) => boolean;
  /** null = every context allowed (no classification needed for filtering). */
  ctxFilter: ((e: Entry, c: Classification) => boolean) | null;
  allowPath: boolean;
  verbatim?: Compiled;
  /** Per positive clause: required for a file to match, but its hits are not listed (see plan()). */
  quiet?: boolean[];
}

type Cand = { e: Entry; hits: Hit[][]; pathHits: (MatchRange[] | null)[]; verbatim: boolean; total: number; score: number; extra?: Hit[]; exact?: boolean };

/** Matching half of a search (one shard's share): candidates + exact document frequencies, unscored. */
export interface MatchRun {
  plan: Plan;
  passing: Cand[];
  df: number[];
  totalFiles: number;
  totalMatches: number;
}

/** Corpus statistics BM25 needs; summed over all shards so every shard scores like one index. */
export interface CorpusStats {
  N: number;
  totalLen: number;
  df: number[];
}

/** A result with its unrounded score (merging shards must compare exactly what one index sorts by). */
export type RankedResult = SearchResult & { raw: number };

/** Per-shard vocabulary facts for one word (see Vocabulary.candidates / mergeSuggest). */
export interface VocabInfo {
  df: number;
  cands: VocabCandidate[];
}

const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 200;
const DEFAULT_ROWS = 60;
const MAX_HITS_PER_CLAUSE = 2000;
const LONG_LINE = 360;

export class SearchEngine {
  private docs = new Map<string, Entry>();
  private nextId = 1;
  private totalLen = 0;
  readonly vocab = new Vocabulary();

  get size() {
    return this.docs.size;
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }

  has(path: string) {
    return this.docs.has(path);
  }

  getContent(path: string): string | undefined {
    return this.docs.get(path)?.content;
  }

  getStructure(path: string): DocStructure | undefined {
    return this.docs.get(path)?.s;
  }

  clear() {
    this.docs.clear();
    this.vocab.clear();
    this.totalLen = 0;
  }

  /** Replace the whole index (workspace opened). */
  reset(docs: SearchDoc[]) {
    this.clear();
    for (const d of docs) this.upsert(d);
  }

  upsert(doc: SearchDoc) {
    const content = normalizeEol(doc.content);
    const prev = this.docs.get(doc.path);
    if (prev && prev.content === content) {
      prev.mtime = doc.mtime ?? prev.mtime;
      return;
    }
    if (prev) this.drop(prev);
    const lower = lowerAligned(content);
    const ascii = isAscii(content);
    const e: Entry = {
      id: this.nextId++,
      path: doc.path,
      pathLower: lowerAligned(doc.path),
      baseStart: doc.path.lastIndexOf('/') + 1,
      content,
      lower,
      ascii,
      s: parseStructure(doc.path, content),
      tokens: NO_TOKENS,
      mtime: doc.mtime,
    };
    // Vocabulary is folded so typo suggestions also work across accents.
    const vocabSrc = ascii ? lower : foldedOf(e).text;
    e.tokens = this.vocab.addText([vocabSrc, isAscii(e.pathLower) ? e.pathLower : foldTerm(e.pathLower)]);
    this.docs.set(doc.path, e);
    this.totalLen += content.length;
  }

  upsertMany(docs: SearchDoc[]) {
    for (const d of docs) this.upsert(d);
  }

  remove(path: string) {
    const e = this.docs.get(path);
    if (!e) return;
    this.drop(e);
    this.docs.delete(path);
  }

  /** Rename a file or a folder (prefix). */
  rename(from: string, to: string) {
    const moves: Array<[string, Entry]> = [];
    for (const [p, e] of this.docs) {
      if (p === from) moves.push([to, e]);
      else if (p.startsWith(from + '/')) moves.push([to + p.slice(from.length), e]);
    }
    for (const [np, e] of moves) {
      this.remove(e.path);
      this.upsert({ path: np, content: e.content, mtime: e.mtime });
    }
  }

  private drop(e: Entry) {
    this.vocab.removeDoc(e.tokens);
    this.totalLen -= e.content.length;
  }

  // ------------------------------------------------------------------ search

  search(query: string, opts: SearchOptions = {}): SearchResponse {
    const g = this.searchSteps(query, opts);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
    }
  }

  /** Generator form: yields periodically so a worker can interleave cancellation messages. */
  *searchSteps(query: string, opts: SearchOptions = {}): Generator<void, SearchResponse, void> {
    const t0 = now();
    const pq = this.parse(query, opts);
    const empty = (extra: Partial<SearchResponse> = {}): SearchResponse => ({ results: [], totalFiles: 0, totalMatches: 0, tookMs: now() - t0, warnings: pq.warnings.length ? pq.warnings : undefined, indexed: this.docs.size, ...extra });
    if (pq.error) return empty({ error: pq.error });
    if (!searchable(pq)) return empty();

    const limit = opts.limit ?? DEFAULT_LIMIT;
    let run = yield* this.matchSteps(this.plan(pq, opts));
    let fuzzy = false;
    let corrections: SearchResponse['corrections'];
    if (wantsFuzzy(run, limit, opts)) {
      const fz = fuzzyClauses(pq, run.df, (t) => this.correct(t));
      if (fz) {
        run = yield* this.matchSteps(this.plan(fz.pq, opts));
        if (hasResults(run, limit)) {
          fuzzy = true;
          corrections = fz.corrections;
        }
      }
    }
    const ranked = yield* this.rankSteps(run, { N: this.docs.size, totalLen: this.totalLen, df: run.df }, opts);
    const results = finishResults(ranked, fuzzy);
    // Few exact hits but a far more common near-spelling exists → "Did you mean …?"
    let suggestions: SearchResponse['suggestions'];
    if (!fuzzy && wantsSuggestions(run, opts)) {
      for (const w of suggestionWords(pq)) {
        const best = this.vocab.suggest(foldTerm(w), 1)[0];
        if (best && best.df >= Math.max(3, run.totalFiles * 3)) (suggestions ??= []).push({ from: w, to: best.token });
      }
    }
    return {
      results,
      totalFiles: run.totalFiles,
      totalMatches: run.totalMatches,
      tookMs: now() - t0,
      truncated: run.totalFiles > results.length || undefined,
      fuzzy: fuzzy || undefined,
      corrections,
      suggestions,
      warnings: pq.warnings.length ? pq.warnings : undefined,
      indexed: this.docs.size,
    };
  }

  parse(query: string, opts: SearchOptions): ParsedQuery {
    return parseQuery(query, { regex: opts.regex, literal: opts.literal, caseSensitive: opts.caseSensitive ?? 'smart' });
  }

  get corpus(): { N: number; totalLen: number } {
    return { N: this.docs.size, totalLen: this.totalLen };
  }

  /** The plan a shard runs: the query as typed, or its typo-corrected form (variants decided globally). */
  planFor(query: string, opts: SearchOptions, fuzzy?: { df: number[]; variants: Record<string, string[]> }): Plan | null {
    const pq = this.parse(query, opts);
    if (pq.error || !searchable(pq)) return null;
    if (!fuzzy) return this.plan(pq, opts);
    const fz = fuzzyClauses(pq, fuzzy.df, (t) => fuzzy.variants[t] ?? []);
    return fz ? this.plan(fz.pq, opts) : null;
  }

  /** Vocabulary facts for typo correction, mergeable across shards. */
  vocabInfo(words: string[]): VocabInfo[] {
    return words.map((w) => ({ df: this.vocab.docFreq(w), cands: this.vocab.candidates(w) }));
  }

  private compile(a: Atom, opts: SearchOptions): Compiled {
    const ww = !!opts.wholeWord;
    if (a.kind === 'regex') {
      const re = compileRegex(a);
      const run = (hay: string, cb: (s: number, en: number) => boolean | void) => {
        re.lastIndex = 0;
        let guard = 0;
        for (let m = re.exec(hay); m; m = re.exec(hay)) {
          const s = m.index;
          const en = s + m[0].length;
          if (en === s) {
            re.lastIndex++;
            if (++guard > 1e6) return;
            continue;
          }
          if (ww && !isWholeWord(hay, s, en)) continue;
          if (cb(s, en) === false) return;
        }
      };
      return {
        atom: a,
        scan: (e, cb) => run(e.content, cb),
        pathRanges: (e) => {
          const out: MatchRange[] = [];
          run(e.path, (s, en) => void out.push({ start: s, end: en }));
          return out.length ? out : null;
        },
      };
    }
    const cs = a.caseSensitive;
    const fold = !cs && opts.diacritics !== false && !hasDiacritics(a.value);
    const needle = cs ? a.value : fold ? foldTerm(a.value) : lowerAligned(a.value);
    const len = needle.length;
    // A phrase is also found across inline Markdown markers: "build before pushing" matches "`npm run build` before pushing".
    const loose = a.quoted && /\S\s+\S/.test(a.value) ? loosePhrase(cs ? a.value : lowerAligned(a.value)) : null;
    const scanIn = (hay: string, map: Int32Array | undefined, raw: string, cb: (s: number, en: number) => boolean | void) => {
      if (!len) return;
      let i = hay.indexOf(needle);
      while (i !== -1) {
        let s = i;
        let en = i + len;
        if (map) {
          s = map[i];
          en = map[i + len];
        }
        if (ww && !isWholeWord(raw, s, en)) {
          i = hay.indexOf(needle, i + 1);
          continue;
        }
        if (cb(s, en) === false) return;
        i = hay.indexOf(needle, i + len);
      }
    };
    return {
      atom: a,
      scan: (e, cb0) => {
        let any = false;
        const cb = loose ? (s: number, en: number) => ((any = true), cb0(s, en)) : cb0;
        if (cs) scanIn(e.content, undefined, e.content, cb);
        else if (fold && !e.ascii) {
          const f = foldedOf(e);
          scanIn(f.text, f.map, e.content, cb);
        } else scanIn(e.lower, undefined, e.content, cb);
        if (!loose || any || e.s.mode !== 'markdown') return;
        const hay = cs ? e.content : e.lower;
        if (hay.indexOf(loose.first) === -1) return; // cheap reject before running the regex
        loose.re.lastIndex = 0;
        for (let m = loose.re.exec(hay); m; m = loose.re.exec(hay)) {
          const en = m.index + m[0].length;
          if (ww && !isWholeWord(e.content, m.index, en)) continue;
          if (cb0(m.index, en) === false) return;
        }
      },
      pathRanges: (e) => {
        const out: MatchRange[] = [];
        const lowerNeedle = fold ? needle : lowerAligned(a.value);
        if (fold && !isAscii(e.path)) {
          const f = foldDiacritics(e.pathLower);
          let i = f.text.indexOf(lowerNeedle);
          while (i !== -1) {
            const s = f.map ? f.map[i] : i;
            const en = f.map ? f.map[i + lowerNeedle.length] : i + lowerNeedle.length;
            if (!ww || isWholeWord(e.path, s, en)) out.push({ start: s, end: en });
            i = f.text.indexOf(lowerNeedle, i + Math.max(1, lowerNeedle.length));
          }
        } else {
          let i = e.pathLower.indexOf(lowerNeedle);
          while (i !== -1 && lowerNeedle) {
            if (!ww || isWholeWord(e.path, i, i + lowerNeedle.length)) out.push({ start: i, end: i + lowerNeedle.length });
            i = e.pathLower.indexOf(lowerNeedle, i + lowerNeedle.length);
          }
        }
        return out.length ? out : null;
      },
    };
  }

  private plan(pq: ParsedQuery, opts: SearchOptions): Plan {
    const positive: Plan['positive'] = [];
    const negative: Compiled[] = [];
    pq.clauses.forEach((c) => {
      if (c.negated) c.atoms.forEach((a) => negative.push(this.compile(a, opts)));
      else positive.push({ clause: c, atoms: c.atoms.map((a) => this.compile(a, opts)), index: positive.length });
    });
    const inF = pq.filters.filter((f) => f.key === 'in');
    const langF = pq.filters.filter((f) => f.key === 'lang');
    const allowPath = opts.matchPaths !== false && !opts.literal && (!inF.some((f) => !f.negated) || inF.some((f) => !f.negated && f.value.toLowerCase() === 'path'));
    const plan: Plan = { pq, positive, negative, fileFilter: buildFileFilter(pq.filters), ctxFilter: buildCtxFilter(inF, langF), allowPath };
    // A multi-word query that appears verbatim gets a big boost — and is rescued even if operators
    // (e.g. "-name" in `find . -name`) would have excluded it.
    // Bare punctuation from a pasted command (`.`, `|`, `>` in `grep -rn "TODO" . | wc -l`) must be present,
    // but listing every "." in the file as a hit would bury the real one.
    const punct = positive.map((pc) => pc.atoms.every((c) => c.atom.kind === 'text' && !c.atom.quoted && !/[\p{L}\p{N}]/u.test(c.atom.value)));
    if (punct.some(Boolean) && punct.some((x) => !x)) plan.quiet = punct;
    const text = pq.text.trim();
    if (!opts.regex && !opts.literal && /\s/.test(text) && text.length >= 3) {
      plan.verbatim = this.compile({ kind: 'text', value: text, quoted: true, caseSensitive: pq.forcedCase ?? false }, { ...opts, wholeWord: false });
    }
    return plan;
  }

  /** Finds every matching document of this index (no scoring: that needs corpus-wide statistics). */
  *matchSteps(plan: Plan): Generator<void, MatchRun, void> {
    const nClauses = plan.positive.length;
    const df = new Array<number>(nClauses).fill(0);
    const passing: Cand[] = [];
    let steps = 0;
    const rescueEnabled = !!plan.verbatim && plan.pq.hasOperators;

    for (const e of this.docs.values()) {
      if ((++steps & 63) === 0) yield;
      if (!plan.fileFilter(e)) continue;
      const spans = plan.ctxFilter ? new Map<number, InlineSpan[]>() : undefined;
      const ctxOk = plan.ctxFilter ? (s: number) => plan.ctxFilter!(e, classifyOffset(e, s, spans)) : null;
      const firstHit = (c: Compiled) => {
        let found = false;
        c.scan(e, (s) => (ctxOk && !ctxOk(s) ? true : ((found = true), false)));
        return found;
      };

      // Verbatim only matters up-front when it can rescue a doc that operators would exclude.
      let verbatim = rescueEnabled ? firstHit(plan.verbatim!) : false;

      let excluded = false;
      for (const n of plan.negative) {
        n.scan(e, () => ((excluded = true), false));
        if (excluded) break;
      }
      if (excluded && !verbatim) continue;

      // Phase 1: presence of every clause (early exit per clause) — also yields exact document frequencies.
      const pathHits: (MatchRange[] | null)[] = [];
      const present: boolean[] = [];
      let ok = true;
      for (const pc of plan.positive) {
        let ph: MatchRange[] | null = null;
        let has = false;
        for (const c of pc.atoms) {
          if (!has) has = firstHit(c);
          if (plan.allowPath) {
            const r = c.pathRanges(e);
            if (r) ph = ph ? ph.concat(r) : r;
          }
        }
        if (has || ph) df[pc.index]++;
        else ok = false;
        present.push(has);
        pathHits.push(ph);
      }
      if (!ok && !verbatim) continue;

      // Phase 2: collect all hits of a passing doc.
      const hits: Hit[][] = [];
      for (const pc of plan.positive) {
        const list: Hit[] = [];
        if (present[pc.index] && !plan.quiet?.[pc.index]) {
          for (const c of pc.atoms) {
            c.scan(e, (s, en) => {
              if (ctxOk && !ctxOk(s)) return;
              list.push({ start: s, end: en, clause: pc.index });
              if (list.length >= MAX_HITS_PER_CLAUSE) return false;
            });
          }
          if (pc.atoms.length > 1) list.sort((a, b) => a.start - b.start);
        }
        hits.push(list);
      }
      if (!rescueEnabled && plan.verbatim && nClauses > 1) verbatim = firstHit(plan.verbatim);
      // Verbatim occurrences are highlighted as one continuous range (spaces included).
      let extra: Hit[] | undefined;
      if (verbatim) {
        extra = [];
        plan.verbatim!.scan(e, (s, en) => {
          if (ctxOk && !ctxOk(s)) return;
          extra!.push({ start: s, end: en, clause: -1 });
          if (extra!.length >= MAX_HITS_PER_CLAUSE) return false;
        });
      }
      // filter-only queries (e.g. `tag:idea`, `ext:php`): synthesize hits for display
      if (!nClauses) hits.push(filterOnlyHits(e, plan.pq.filters));
      // The file contains the query word for word (a pasted command): list those occurrences only —
      // other lines that merely share a word ("kubectl …") are noise next to the exact hit.
      const exact = !!extra?.length;
      const total = exact ? extra!.length : hits.reduce((n, h) => n + h.length, 0);
      passing.push({ e, hits, pathHits, verbatim, total, score: 0, extra, exact });
    }

    let totalMatches = 0;
    for (const c of passing) totalMatches += c.total || (c.pathHits.some(Boolean) ? 1 : 0);
    return { plan, passing, df, totalFiles: passing.length, totalMatches };
  }

  /** Scores a match run with corpus-wide stats; returns this index's best `limit` results (raw scores kept). */
  *rankSteps(run: MatchRun, stats: CorpusStats, opts: SearchOptions): Generator<void, RankedResult[], void> {
    const { plan, passing } = run;
    const nClauses = plan.positive.length;
    let steps = 0;
    const N = Math.max(1, stats.N);
    const avgLen = Math.max(1, stats.totalLen / N);
    const idf = stats.df.map((d) => Math.log(1 + (N - d + 0.5) / (d + 0.5)));
    const avgIdf = idf.length ? idf.reduce((a, b) => a + b, 0) / idf.length : 1;
    const qText = plan.pq.text.trim();
    for (const c of passing) {
      if ((++steps & 63) === 0) yield;
      c.score = this.scoreDoc(c.e, c.hits, c.pathHits, idf, avgIdf, avgLen, nClauses, c.verbatim, qText);
    }
    passing.sort(byRank);

    const limit = opts.limit ?? DEFAULT_LIMIT;
    const rowsMax = opts.maxMatchesPerFile ?? DEFAULT_ROWS;
    const results: RankedResult[] = [];
    for (const c of passing.slice(0, limit)) {
      const all = (c.exact ? c.extra! : c.extra ? c.hits.flat().concat(c.extra) : c.hits.flat()).sort((a, b) => a.start - b.start || a.end - b.end);
      const r: RankedResult = { path: c.e.path, score: round(c.score), raw: c.score, matches: buildRows(c.e, all, rowsMax), totalMatches: c.total };
      const ph = mergeRanges(c.pathHits.flatMap((x) => x ?? []));
      if (ph.length) r.pathRanges = ph;
      if (c.e.s.title) r.title = c.e.s.title;
      if (!c.total && ph.length) {
        r.matches = [{ line: 0, start: ph[0].start, end: ph[0].end, ranges: ph, lineText: c.e.path, context: 'path', col: 0, offset: 0 }];
        r.totalMatches = 0;
      }
      results.push(r);
    }
    return results;
  }

  private scoreDoc(e: Entry, hits: Hit[][], pathHits: (MatchRange[] | null)[], idf: number[], avgIdf: number, avgLen: number, nClauses: number, verbatim: boolean, qText: string): number {
    const len = e.content.length || 1;
    const norm = K1 * (1 - B + (B * len) / avgLen);
    let score = 0;
    const base = e.path.slice(e.baseStart).toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    for (let i = 0; i < nClauses; i++) {
      let tf = 0;
      const hs = hits[i];
      const weighCap = Math.min(hs.length, 200);
      for (let k = 0; k < weighCap; k++) tf += weightOf(e, hs[k].start);
      tf += hs.length - weighCap;
      const ph = pathHits[i];
      let pathBoost = 0;
      if (ph) {
        const inBase = ph.some((r) => r.start >= e.baseStart);
        pathBoost = inBase ? 2 : 0.6;
        // whole file name (sans extension) equals the term → strongest signal
        if (inBase && ph.some((r) => r.start === e.baseStart && r.end - r.start >= stem.length)) pathBoost = 4;
        tf += pathBoost * 1.5;
      }
      score += idf[i] * ((tf * (K1 + 1)) / (tf + norm)) + idf[i] * pathBoost;
    }
    if (nClauses > 1) {
      const span = minWindow(hits);
      if (span) {
        const sameLine = e.content.lastIndexOf('\n', span.end - 1) < span.start;
        score += avgIdf * (1.5 / (1 + span.width / 40)) + (sameLine ? avgIdf * 1.2 : 0);
      }
    }
    if (verbatim) score += avgIdf * 3;
    // file-name fuzzy affinity for single-word queries (tie-shaper; meaningless for long commands)
    if (qText && qText.length <= 32 && !/\s/.test(qText)) {
      const fm = fuzzyMatch(qText, stem);
      if (fm) score += Math.min(2, fm.score / (16 * Math.max(4, qText.length)));
    }
    return score;
  }

  /** Corrected variants of a term (each word chunk corrected independently, punctuation kept). */
  correct(term: string, maxVariants = 6): string[] {
    return correctWith(term, (w) => this.vocab.docFreq(w), (w, n) => this.vocab.suggest(w, n), maxVariants);
  }

  // ------------------------------------------------------------------ headings

  /** Headings across the workspace (or in `path`), fuzzy-ranked. `fileQuery` narrows by file (quick open `file#heading`). */
  headings(query: string, opts: { limit?: number; path?: string; fileQuery?: string } = {}): HeadingHit[] {
    const out: HeadingHit[] = [];
    const docs = opts.path ? [this.docs.get(opts.path)].filter(Boolean) as Entry[] : [...this.docs.values()];
    for (const e of docs) {
      if (!e.s.headings.length) continue;
      let fileScore = 0;
      if (opts.fileQuery) {
        const fm = fuzzyMatchPath(opts.fileQuery, e.path);
        if (!fm) continue;
        fileScore = fm.score;
      }
      for (const h of e.s.headings) {
        if (!h.text) continue;
        const m = query ? fuzzyMatch(query, h.text) : { score: 0, positions: [] };
        if (!m) continue;
        out.push({ path: e.path, line: h.line, level: h.level, text: h.text, score: m.score + fileScore * 0.25 - h.level * 0.5, positions: m.positions });
      }
    }
    out.sort(compareHeadings);
    return out.slice(0, opts.limit ?? 100);
  }

  /** Hits of a parsed query in one document (used by replace). */
  matchDoc(path: string, content: string, query: string, opts: SearchOptions): { hits: Array<{ start: number; end: number }>; error?: string; atom?: Atom } {
    const tmp = new SearchEngine();
    tmp.upsert({ path, content });
    const pq = parseQuery(query, { regex: opts.regex, literal: opts.literal, caseSensitive: opts.caseSensitive ?? 'smart' });
    if (pq.error) return { hits: [], error: pq.error };
    const plan = tmp.plan(pq, { ...opts, matchPaths: false });
    const e = tmp.docs.get(path)!;
    if (!plan.fileFilter(e)) return { hits: [] };
    for (const n of plan.negative) {
      let ex = false;
      n.scan(e, () => ((ex = true), false));
      if (ex) return { hits: [] };
    }
    const spans = new Map<number, InlineSpan[]>();
    const hits: Array<{ start: number; end: number }> = [];
    for (const pc of plan.positive) {
      for (const c of pc.atoms) {
        c.scan(e, (s, en) => {
          if (plan.ctxFilter && !plan.ctxFilter(e, classifyOffset(e, s, spans))) return;
          hits.push({ start: s, end: en });
        });
      }
    }
    hits.sort((a, b) => a.start - b.start);
    // drop overlaps (keep first)
    const out: typeof hits = [];
    for (const h of hits) if (!out.length || h.start >= out[out.length - 1].end) out.push(h);
    return { hits: out, atom: plan.positive[0]?.atoms[0]?.atom };
  }
}

// ------------------------------------------------------------------ shared by one index and shards

/** Sort order of ranked documents: score, then path (unique → total order, identical across shards). */
function byRank(a: { score: number; e: Entry }, b: { score: number; e: Entry }) {
  return b.score - a.score || (a.e.path < b.e.path ? -1 : a.e.path > b.e.path ? 1 : 0);
}

/** Same order for merged shard results. */
export function compareRanked(a: RankedResult, b: RankedResult) {
  return b.raw - a.raw || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Drops the merge-only raw score. */
export function finishResults(ranked: RankedResult[], fuzzy: boolean): SearchResult[] {
  return ranked.map(({ raw: _raw, ...r }) => (fuzzy ? { ...r, fuzzy: true } : r));
}

export const searchable = (pq: ParsedQuery) => pq.clauses.some((c) => !c.negated) || pq.filters.some((f) => !f.negated && f.key !== 'case' && f.key !== 'in');
export const hasResults = (run: { totalFiles: number }, limit: number) => Math.min(limit, run.totalFiles) > 0;
export const wantsFuzzy = (run: { totalFiles: number }, limit: number, opts: SearchOptions) => !hasResults(run, limit) && opts.fuzzy !== false && !opts.regex && !opts.literal;
export const wantsSuggestions = (run: { totalFiles: number }, opts: SearchOptions) => run.totalFiles > 0 && run.totalFiles < 3 && opts.fuzzy !== false && !opts.regex && !opts.literal;

/** Query words that may get a "Did you mean" (in order). */
export function suggestionWords(pq: ParsedQuery): string[] {
  const out: string[] = [];
  for (const c of pq.clauses) {
    if (c.negated) continue;
    for (const a of c.atoms) if (a.kind === 'text' && /^[\p{L}\p{N}_]{4,}$/u.test(a.value)) out.push(a.value);
  }
  return out;
}

/** Typo fallback: replace zero-hit terms with OR-groups of vocabulary corrections. */
export function fuzzyClauses(pq: ParsedQuery, df: number[], correct: (term: string) => string[]): { pq: ParsedQuery; corrections: NonNullable<SearchResponse['corrections']> } | null {
  const corrections: NonNullable<SearchResponse['corrections']> = [];
  let changed = false;
  let pi = 0;
  const clauses: Clause[] = pq.clauses.map((c) => {
    if (c.negated) return c;
    const idx = pi++;
    if (df[idx] > 0) return c;
    const atoms: Atom[] = [];
    for (const a of c.atoms) {
      if (a.kind !== 'text') {
        atoms.push(a);
        continue;
      }
      const variants = correct(a.value);
      if (variants.length) {
        changed = true;
        corrections.push({ from: a.value, to: variants });
        for (const v of variants) atoms.push({ kind: 'text', value: v, quoted: a.quoted, caseSensitive: false } as TextAtom);
      } else atoms.push(a);
    }
    return { atoms, negated: c.negated };
  });
  if (!changed) return null;
  return { pq: { ...pq, clauses, hasOperators: true }, corrections };
}

/** Terms whose corrections a fuzzy fallback may need (so shards can be asked for vocabulary facts). */
export function fuzzyTerms(pq: ParsedQuery, df: number[]): string[] {
  const out: string[] = [];
  let pi = 0;
  for (const c of pq.clauses) {
    if (c.negated) continue;
    if (df[pi++] > 0) continue;
    for (const a of c.atoms) if (a.kind === 'text') out.push(a.value);
  }
  return out;
}

/** The vocabulary words `correctWith(term)` looks up. */
export function correctionWords(term: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}_]+/gu;
  const folded = foldTerm(term);
  for (let m = re.exec(folded); m; m = re.exec(folded)) if (m[0].length >= 3) out.push(m[0]);
  return out;
}

/** Corrected variants of a term against any vocabulary (one index, or shards merged). */
export function correctWith(term: string, docFreq: (w: string) => number, suggest: (w: string, limit: number) => Suggestion[], maxVariants = 6): string[] {
  const folded = foldTerm(term);
  const chunks: Array<{ start: number; end: number; alts: Array<{ t: string; d: number; df: number }> }> = [];
  const re = /[\p{L}\p{N}_]+/gu;
  let need = false;
  for (let m = re.exec(folded); m; m = re.exec(folded)) {
    const w = m[0];
    if (w.length < 3 || docFreq(w) > 0) continue;
    const sugg = suggest(w, 3);
    if (!sugg.length) continue;
    need = true;
    chunks.push({ start: m.index, end: m.index + w.length, alts: sugg.map((x) => ({ t: x.token, d: x.distance, df: x.df })) });
  }
  if (!need) return [];
  let combos: Array<{ parts: string[]; d: number; df: number }> = [{ parts: [], d: 0, df: Infinity }];
  for (const ch of chunks) {
    const next: typeof combos = [];
    for (const c of combos) for (const a of ch.alts) next.push({ parts: [...c.parts, a.t], d: c.d + a.d, df: Math.min(c.df, a.df) });
    next.sort((a, b) => a.d - b.d || b.df - a.df);
    combos = next.slice(0, maxVariants);
  }
  return combos.map((c) => {
    let out = '';
    let pos = 0;
    chunks.forEach((ch, i) => {
      out += folded.slice(pos, ch.start) + c.parts[i];
      pos = ch.end;
    });
    return out + folded.slice(pos);
  });
}

/** Sort order of heading hits (shared by one index and merged shards). */
export function compareHeadings(a: HeadingHit, b: HeadingHit) {
  return b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line);
}

// ------------------------------------------------------------------ helpers

const INLINE_MARKS = '[`*_~=]{0,3}';

/** Regex for a phrase whose word gaps may also contain inline Markdown markers (`code`, **bold**, _em_, ==hl==). */
function loosePhrase(needle: string): { re: RegExp; first: string } {
  const words = needle.trim().split(/\s+/);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  return { re: new RegExp(words.map(esc).join(`${INLINE_MARKS}[ \\t]+${INLINE_MARKS}`), 'g'), first: words[0] };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function foldedOf(e: Entry): FoldedText {
  if (!e.folded) e.folded = foldDiacritics(e.lower);
  return e.folded;
}

function lineText(e: Entry, line: number): string {
  const ls = e.s.lineStarts;
  const start = ls[line];
  const end = line + 1 < ls.length ? ls[line + 1] - 1 : e.content.length;
  return e.content.slice(start, end);
}

function classifyOffset(e: Entry, offset: number, spans?: Map<number, InlineSpan[]>): Classification {
  if (e.s.mode === 'code') return { context: 'code', lang: e.s.fileLang, langId: e.s.fileLang };
  if (e.s.mode === 'text') return { context: 'text' };
  const line = lineOfOffset(e.s.lineStarts, offset);
  return classifyAt(e.s, line, offset - e.s.lineStarts[line], lineText(e, line), spans);
}

function weightOf(e: Entry, offset: number): number {
  if (e.s.mode !== 'markdown') return 1;
  const line = lineOfOffset(e.s.lineStarts, offset);
  const k = e.s.kinds[line];
  if (k === K_HEADING) {
    const h = e.s.headings.find((x) => x.line === line);
    return h && h.level === 1 ? 4 : h && h.level === 2 ? 3 : 2.5;
  }
  if (k === K_FM) return 1.5;
  return 1;
}

function mergeRanges(rs: MatchRange[]): MatchRange[] {
  if (rs.length < 2) return rs;
  const s = [...rs].sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [{ ...s[0] }];
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1];
    if (s[i].start <= last.end) last.end = Math.max(last.end, s[i].end);
    else out.push({ ...s[i] });
  }
  return out;
}

/** Smallest char window containing at least one hit of every clause. */
function minWindow(hits: Hit[][]): { start: number; end: number; width: number } | null {
  const k = hits.length;
  if (hits.some((h) => !h.length)) return null;
  const merged: Hit[] = [];
  for (const h of hits) for (let i = 0; i < Math.min(h.length, 300); i++) merged.push(h[i]);
  merged.sort((a, b) => a.start - b.start);
  const count = new Array<number>(k).fill(0);
  let have = 0;
  let best: { start: number; end: number; width: number } | null = null;
  let l = 0;
  for (let r = 0; r < merged.length; r++) {
    if (count[merged[r].clause]++ === 0) have++;
    while (have === k) {
      const end = Math.max(merged[r].end, merged[l].end);
      const w = end - merged[l].start;
      if (!best || w < best.width) best = { start: merged[l].start, end, width: w };
      if (--count[merged[l].clause] === 0) have--;
      l++;
    }
  }
  return best;
}

function buildRows(e: Entry, hits: Hit[], max: number): SearchMatch[] {
  const rows: SearchMatch[] = [];
  const spans = new Map<number, InlineSpan[]>();
  let i = 0;
  while (i < hits.length && rows.length < max) {
    const line = lineOfOffset(e.s.lineStarts, hits[i].start);
    const ls = e.s.lineStarts[line];
    const full = lineText(e, line);
    const lineEnd = ls + full.length;
    const ranges: MatchRange[] = [];
    const first = hits[i];
    while (i < hits.length && hits[i].start <= lineEnd) {
      const h = hits[i];
      ranges.push({ start: h.start - ls, end: Math.min(h.end, lineEnd) - ls });
      i++;
    }
    const merged = mergeRanges(ranges);
    const cls = classifyAt(e.s, line, first.start - ls, full, spans);
    let text = full;
    let off = 0;
    if (full.length > LONG_LINE) {
      off = Math.max(0, merged[0].start - 80);
      text = full.slice(off, off + LONG_LINE);
    }
    const rel = merged.map((r) => ({ start: r.start - off, end: Math.min(r.end - off, text.length) })).filter((r) => r.start >= 0 && r.start < text.length);
    const row: SearchMatch = {
      line,
      start: rel[0]?.start ?? 0,
      end: rel[0]?.end ?? 0,
      ranges: rel,
      lineText: text,
      context: cls.context,
      col: merged[0].start,
      // Select what is highlighted: a verbatim command is one merged range, not just its first word.
      length: merged[0].end - merged[0].start,
      offset: first.start,
    };
    if (off) row.lineTextOffset = off;
    if (cls.lang) row.lang = cls.lang;
    if (cls.headingLevel) row.headingLevel = cls.headingLevel;
    rows.push(row);
  }
  return rows;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re, 'i');
}

function pathMatcher(value: string): (s: string) => boolean {
  const v = value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (/[*?]/.test(v)) {
    const re = globToRegExp(v);
    return (s) => re.test(s);
  }
  return (s) => s.toLowerCase().includes(v);
}

function buildFileFilter(filters: Filter[]): (e: Entry) => boolean {
  const groups = new Map<string, { pos: Array<(e: Entry) => boolean>; neg: Array<(e: Entry) => boolean> }>();
  const add = (key: string, neg: boolean, fn: (e: Entry) => boolean) => {
    if (!groups.has(key)) groups.set(key, { pos: [], neg: [] });
    (neg ? groups.get(key)!.neg : groups.get(key)!.pos).push(fn);
  };
  for (const f of filters) {
    if (f.key === 'path') {
      const m = pathMatcher(f.value);
      add('path', f.negated, (e) => m(e.path));
    } else if (f.key === 'file') {
      const m = pathMatcher(f.value);
      add('file', f.negated, (e) => m(e.path.slice(e.baseStart)));
    } else if (f.key === 'ext') {
      const exts = f.value.split(',').map((x) => x.trim().toLowerCase().replace(/^\.?/, '.')).filter((x) => x.length > 1);
      add('ext', f.negated, (e) => exts.some((x) => e.pathLower.endsWith(x)));
    } else if (f.key === 'lang') {
      const ids = langIds(f.value);
      add('lang', f.negated, (e) => (e.s.mode === 'code' ? ids.includes(e.s.fileLang!) : [...e.s.langs].some((l) => ids.includes(l))));
    } else if (f.key === 'tag') {
      const t = f.value.replace(/^#/, '').toLowerCase();
      add('tag', f.negated, (e) => e.s.tags.some((x) => x === t || x.startsWith(t + '/')));
    }
  }
  if (!groups.size) return () => true;
  const gs = [...groups.values()];
  return (e) => {
    for (const g of gs) {
      if (g.pos.length && !g.pos.some((fn) => fn(e))) return false;
      if (g.neg.some((fn) => fn(e))) return false;
    }
    return true;
  };
}

function langIds(v: string): string[] {
  return v
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((x) => languageById(x)?.id ?? x);
}

const IN_MAP: Record<string, MatchContext[]> = {
  code: ['code', 'inline-code'],
  block: ['code'],
  fence: ['code'],
  inline: ['inline-code'],
  text: ['text'],
  heading: ['heading'],
  frontmatter: ['frontmatter'],
  fm: ['frontmatter'],
  meta: ['frontmatter'],
  yaml: ['frontmatter'],
  link: ['link'],
  path: [],
};

function buildCtxFilter(inF: Filter[], langF: Filter[]): Plan['ctxFilter'] {
  const pos = new Set<MatchContext>();
  const neg = new Set<MatchContext>();
  for (const f of inF) for (const c of IN_MAP[f.value.toLowerCase()] ?? []) (f.negated ? neg : pos).add(c);
  const onlyPath = inF.length > 0 && inF.every((f) => !f.negated && f.value.toLowerCase() === 'path');
  const langs = langF.filter((f) => !f.negated).flatMap((f) => langIds(f.value));
  if (!pos.size && !neg.size && !langs.length && !onlyPath) return null;
  return (e, c) => {
    if (onlyPath) return false;
    if (pos.size && !pos.has(c.context)) return false;
    if (neg.has(c.context)) return false;
    // lang: in Markdown restricts hits to fenced blocks of that language
    if (langs.length && e.s.mode === 'markdown' && !(c.context === 'code' && c.langId && langs.includes(c.langId))) return false;
    return true;
  };
}

function filterOnlyHits(e: Entry, filters: Filter[]): Hit[] {
  const out: Hit[] = [];
  for (const f of filters) {
    if (f.negated) continue;
    if (f.key === 'tag') {
      const t = '#' + f.value.replace(/^#/, '').toLowerCase();
      for (let i = e.lower.indexOf(t); i !== -1; i = e.lower.indexOf(t, i + t.length)) out.push({ start: i, end: i + t.length, clause: 0 });
      if (!out.length) {
        // frontmatter tag: highlight the bare word on the tags line
        const w = f.value.replace(/^#/, '').toLowerCase();
        const i = e.lower.indexOf(w);
        if (i !== -1) out.push({ start: i, end: i + w.length, clause: 0 });
      }
    } else if (f.key === 'lang' && e.s.mode === 'markdown') {
      const ids = langIds(f.value);
      for (const b of e.s.blocks) {
        if (!ids.includes(b.langId)) continue;
        const ls = e.s.lineStarts[b.startLine];
        const lt = lineText(e, b.startLine);
        const k = lt.toLowerCase().indexOf(b.lang);
        if (k !== -1) out.push({ start: ls + k, end: ls + k + b.lang.length, clause: 0 });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
