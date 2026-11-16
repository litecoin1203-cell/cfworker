import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

// LEG-06: the fonts the page serves are under the SIL Open Font License, which asks that the licence travels with
// the font files. The build puts each family's licence text next to its .woff2 files.
test('the build ships each font with its OFL licence text', () => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
  const dir = new URL('../../worker/public/app/fonts/', import.meta.url).pathname;
  const files = readdirSync(dir);
  for (const [prefix, lic] of [['pjs-', 'OFL-plus-jakarta-sans.txt'], ['vazir-', 'OFL-vazirmatn.txt']]) {
    assert.ok(files.some((f) => f.startsWith(prefix) && f.endsWith('.woff2')), prefix + ' fonts are built');
    assert.ok(existsSync(dir + lic), lic + ' is next to them');
    const text = readFileSync(dir + lic, 'utf8');
    assert.match(text, /SIL Open Font License, Version 1\.1/);
    assert.match(text, /Copyright \d{4} The .+ Project Authors/);
  }
});
