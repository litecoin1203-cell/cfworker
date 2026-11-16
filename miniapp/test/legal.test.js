// PRV-03: the Mini App shows the same Privacy policy and Terms of use as Pleat (docs/legal/*.txt), and says what
// creating an account agrees to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLegal, LEGAL_DOCS } from '../src/legal.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the policy files parse into a title, sections and items', () => {
  for (const [id, title] of [['privacy', 'Privacy policy'], ['terms', 'Terms of use']]) {
    const blocks = parseLegal(read(`../../docs/legal/${id}.txt`));
    assert.deepEqual(blocks[0], { kind: 'title', text: title });
    assert.ok(blocks.some((b) => b.kind === 'heading'));
    assert.ok(blocks.some((b) => b.kind === 'item'));
    assert.equal(LEGAL_DOCS[id].title, title);
  }
  assert.deepEqual(parseLegal('# T\n\n## S\n- one\ntext\n'), [
    { kind: 'title', text: 'T' }, { kind: 'heading', text: 'S' }, { kind: 'item', text: 'one' }, { kind: 'paragraph', text: 'text' },
  ]);
});

test('the bundle takes the texts from docs/legal, the files Pleat checks against', () => {
  assert.match(read('../src/legal-text.js'), /from '\.\.\/\.\.\/docs\/legal\/privacy\.txt'/);
  assert.match(read('../src/legal-text.js'), /from '\.\.\/\.\.\/docs\/legal\/terms\.txt'/);
  assert.match(read('../build.mjs'), /'\.txt': 'text'/);
});

test('Create account says what it agrees to; Home links both documents', () => {
  const main = read('../src/main.jsx');
  assert.match(main, /By creating an account you agree to the/);
  assert.match(main, /onDoc\('terms'\)/);
  assert.match(main, /onDoc\('privacy'\)/);
  assert.match(main, /title="Privacy policy"/);
  assert.match(main, /title="Terms of use"/);
});
