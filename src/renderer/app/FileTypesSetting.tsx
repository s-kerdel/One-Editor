// Settings → Files → File type associations (setting `files.associations`): one row per pattern with its
// language and Remove, and an add row that checks what you type as you type it. Lazy: part of the Settings
// chunk. Writes go through ./file-types (rows of another build's languages stay in the file untouched).
import { useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { LANGUAGES, languageById, type LanguageInfo } from '@shared/languages';
import { MAX_ASSOCIATIONS, describePattern, patternFromInput } from '@shared/associations';
import { fileAssociations, setFileAssociation } from './file-types';
import './file-types.css';

/** Plain text, then what the editor can highlight, A→Z: the status bar's language list. */
const choices = (): LanguageInfo[] => [languageById('text')!, ...LANGUAGES.filter((l) => l.cm).sort((a, b) => a.name.localeCompare(b.name))];

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function FileTypesControl({ id }: { id: string }) {
  const rows = fileAssociations();
  const langs = choices();
  const [draft, setDraft] = useState('');
  const [lang, setLang] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLSelectElement>(null);

  const full = rows.length >= MAX_ASSOCIATIONS;
  const parsed = draft.trim() ? patternFromInput(draft) : null;
  const taken = parsed?.ok ? rows.find((r) => r.pattern === parsed.pattern) : undefined;
  const error = full ? `At most ${MAX_ASSOCIATIONS} associations: remove one first` : parsed && !parsed.ok ? parsed.error : taken ? `${taken.pattern} is already in the list` : null;
  const ready = !!parsed?.ok && !error;
  const name = (langId: string) => languageById(langId)?.name ?? langId;

  const add = () => {
    if (!parsed?.ok || error) return void input.current?.focus();
    if (!lang) return void picker.current?.focus();
    setFileAssociation(parsed.pattern, lang);
    setDraft('');
    input.current?.focus();
  };

  return (
    <div class="se-assoc" data-setting="files.associations">
      {rows.length > 0 && (
        <ul class="se-assoc-list" aria-label="File type associations">
          {rows.map((r) => (
            <li key={r.pattern} class="se-assoc-item" data-pattern={r.pattern}>
              <code class="se-assoc-pattern" title={sentence(describePattern(r.pattern))}>
                {r.pattern}
              </code>
              <span class="se-assoc-arrow" aria-hidden="true">
                →
              </span>
              <select class="se-select" aria-label={`Language for ${r.pattern}`} value={r.language} onChange={(e) => setFileAssociation(r.pattern, (e.currentTarget as HTMLSelectElement).value)}>
                {/* A hand-edited settings file may name a language the list does not offer: show it rather than lie. */}
                {!langs.some((l) => l.id === r.language) && <option value={r.language}>{name(r.language)}</option>}
                {langs.map((l) => (
                  <option value={l.id}>{l.name}</option>
                ))}
              </select>
              <button class="se-icon-btn small" aria-label={`Remove ${r.pattern}`} title="Remove" onClick={() => setFileAssociation(r.pattern, null)}>
                <Icon name="close" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="se-assoc-add">
        <input
          ref={input}
          id={id}
          class="se-input mono"
          placeholder="ctp"
          aria-label="Extension or file name"
          aria-invalid={error && draft.trim() ? 'true' : undefined}
          aria-describedby={`${id}-note`}
          spellcheck={false}
          autocomplete="off"
          maxLength={80}
          disabled={full}
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add();
          }}
        />
        <span class="se-assoc-arrow" aria-hidden="true">
          →
        </span>
        <select ref={picker} class="se-select" aria-label="Language" data-testid="assoc-language" disabled={full} value={lang} onChange={(e) => setLang((e.currentTarget as HTMLSelectElement).value)}>
          <option value="" disabled>
            Language…
          </option>
          {langs.map((l) => (
            <option value={l.id}>{l.name}</option>
          ))}
        </select>
        <button class="se-btn small" data-testid="assoc-add" disabled={!ready || !lang} onClick={add}>
          Add
        </button>
      </div>
      <div id={`${id}-note`} class={`se-assoc-note${error && (draft.trim() || full) ? ' err' : ''}`} role="status">
        {error && (draft.trim() || full)
          ? error
          : parsed?.ok
            ? `${sentence(describePattern(parsed.pattern))}${lang ? ` open as ${name(lang)}` : ''}.`
            : 'An extension (ctp, .tpl.php) or a file name (nginx.conf, Dockerfile.*). For a name without a dot, use the language in the status bar.'}
      </div>
    </div>
  );
}
