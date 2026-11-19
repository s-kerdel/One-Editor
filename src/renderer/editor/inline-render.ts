// Minimal inline Markdown → DOM renderer for widgets (table cells). Builds nodes with textContent,
// never innerHTML, so cell content can't inject markup.

const TOKEN = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|~~([^~]+)~~|==([^=]+)==|!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])|\\([\\`*_{}[\]()#+\-.!|=~])/g;

export function renderInline(text: string, parent: HTMLElement) {
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index! + m[0].length;
    const el = (tag: string, cls?: string, inner?: string) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (inner !== undefined) renderInline(inner, e);
      parent.appendChild(e);
      return e;
    };
    if (m[1]) el('code', 'se-code-chip').textContent = m[2];
    else if (m[3] ?? m[4]) el('strong', undefined, m[3] ?? m[4]);
    else if (m[5] ?? m[6]) el('em', undefined, m[5] ?? m[6]);
    else if (m[7]) el('s', undefined, m[7]);
    else if (m[8]) el('mark', 'se-t-highlight', m[8]);
    else if (m[9]) {
      const a = el('a', 'se-mdlink se-wikilink');
      a.dataset.wiki = m[9];
      a.dataset.live = '1';
      a.textContent = m[10] ?? m[9];
    } else if (m[11]) {
      const a = el('a', 'se-mdlink', m[11]);
      a.dataset.href = m[12];
      a.dataset.live = '1';
      a.title = m[12];
    } else if (m[13]) {
      const a = el('a', 'se-mdlink');
      a.dataset.href = m[13];
      a.dataset.live = '1';
      a.textContent = m[13];
    } else if (m[14]) parent.appendChild(document.createTextNode(m[14]));
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
