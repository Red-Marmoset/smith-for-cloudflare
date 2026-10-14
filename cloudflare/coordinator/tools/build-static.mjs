import * as esbuild from 'esbuild';
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Builds dist/, the tree Wrangler deploys as the dashboard's static assets (see wrangler.jsonc), from
// public/. Like senet's tools/build-static.js, every JS and CSS file is minified on its own with esbuild
// (no bundling, so every import path stays exactly as written) and everything else is copied as is.
// public/ stays readable for diffs and local edits; only dist/ is minified. Wrangler runs this before
// `wrangler dev` and `wrangler deploy` (the "build" entry in wrangler.jsonc), and `npm test` runs it too.
const SOURCE = 'public', OUT = 'dist';

async function files(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await files(join(dir, entry.name), rel + '/'));
    else found.push(rel);
  }
  return found;
}

// Leading indentation and comments only: inline elements on separate lines keep the newline (a space
// when rendered). <pre> blocks (help.html's code examples) are whitespace-sensitive, so they pass through
// untouched; a non-empty <textarea> stops the build.
function minifyHtml(html, rel) {
  if (/<textarea\b[^>]*>[^<]/.test(html)) throw new Error(`${rel}: a <textarea> has content; teach build-static to keep its whitespace`);
  return html.split(/(<pre\b[\s\S]*?<\/pre>)/).map((part, index) => index % 2 ? part
    : part.replace(/<!--(?!\[)[\s\S]*?-->/g, '').replace(/\n\s+/g, '\n')).join('').trim() + '\n';
}

await rm(OUT, { recursive: true, force: true });
let before = 0, after = 0;
for (const rel of await files(SOURCE)) {
  const from = join(SOURCE, rel), to = join(OUT, rel);
  await mkdir(dirname(to), { recursive: true });
  const minifiable = /\.(js|css|html)$/.test(rel) && !rel.startsWith('vendor/');   // vendor/ ships pre-minified
  if (!minifiable) { await copyFile(from, to); continue; }
  const source = await readFile(from, 'utf8');
  const output = rel.endsWith('.html') ? minifyHtml(source, rel)
    : (await esbuild.transform(source, { loader: rel.endsWith('.css') ? 'css' : 'js', minify: true, legalComments: 'none', sourcefile: rel,
      ...(rel.endsWith('.js') ? { format: 'esm', treeShaking: false } : {}) })).code;
  await writeFile(to, output);
  before += Buffer.byteLength(source); after += Buffer.byteLength(output);
}
console.log(`build-static: minified ${(before / 1024).toFixed(0)} KiB of JS/CSS/HTML to ${(after / 1024).toFixed(0)} KiB in ${OUT}/`);
