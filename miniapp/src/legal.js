// The Privacy policy and Terms of use: the same files Pleat shows (docs/legal/*.txt; Pleat's lib/legal_text.dart is
// a checked copy). Format: '# ' the title, '## ' a section, '- ' a list item, anything else a paragraph; one per line.
export const LEGAL_DOCS = {
  privacy: { title: 'Privacy policy' },
  terms: { title: 'Terms of use' },
};

export function parseLegal(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    if (raw.startsWith('## ')) out.push({ kind: 'heading', text: raw.slice(3).trim() });
    else if (raw.startsWith('# ')) out.push({ kind: 'title', text: raw.slice(2).trim() });
    else if (raw.startsWith('- ')) out.push({ kind: 'item', text: raw.slice(2).trim() });
    else out.push({ kind: 'paragraph', text: raw.trim() });
  }
  return out;
}
