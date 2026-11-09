// Builds the Mini App into ../worker/public, which the Worker serves as static assets (wrangler.jsonc "assets").
// One bundle (Preact + the app), one stylesheet, one page, its fonts. No file is fetched from outside at build or run time,
// except Telegram's own telegram-web-app.js, which the page loads optionally (it also works from the URL hash).
import { build } from 'esbuild';
import { mkdir, copyFile, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const out = new URL('../worker/public/', import.meta.url).pathname;
await rm(out, { recursive: true, force: true });
await mkdir(out + 'app', { recursive: true });
const r = await build({
  entryPoints: ['src/main.jsx'], bundle: true, minify: true, format: 'esm', target: 'es2020',
  jsx: 'automatic', jsxImportSource: 'preact', outfile: out + 'app/app.js', legalComments: 'none', metafile: true,
});
await copyFile('src/styles.css', out + 'app/styles.css');
// fonts ship with the page (Google Fonts is filtered in Iran): Plus Jakarta Sans for Latin, Vazirmatn only for Persian names
await mkdir(out + 'app/fonts', { recursive: true });
const fs = 'node_modules/@fontsource/';
for (const w of [500, 600, 700]) await copyFile(`${fs}plus-jakarta-sans/files/plus-jakarta-sans-latin-${w}-normal.woff2`, `${out}app/fonts/pjs-${w}.woff2`);
for (const w of [500, 700]) await copyFile(`${fs}vazirmatn/files/vazirmatn-arabic-${w}-normal.woff2`, `${out}app/fonts/vazir-${w}.woff2`);
// file names stay fixed; a content hash in the query string makes Telegram's web view pick up a new build
const ver = createHash('sha256').update(await readFile(out + 'app/app.js')).update(await readFile(out + 'app/styles.css')).digest('hex').slice(0, 10);
await writeFile(out + 'app/index.html', (await readFile('src/index.html', 'utf8')).replaceAll('__V__', ver));
await copyFile('src/_headers', out + '_headers');
const kb = Object.values(r.metafile.outputs).reduce((n, o) => n + o.bytes, 0) / 1024;
console.log(`Mini App built: ${kb.toFixed(1)} KB of JS, version ${ver}`);
