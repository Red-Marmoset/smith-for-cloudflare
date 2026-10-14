import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';

// Commit a self-contained browser module so Wrangler serves it without a CDN or build step.
await mkdir('public/vendor', { recursive: true });
const browser = await readFile('node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs', 'utf8');
await writeFile('public/vendor/markdown-it.js', browser.replace(/^\/\/# sourceMappingURL=.*$/m, ''));
await copyFile('node_modules/markdown-it/LICENSE', 'public/vendor/markdown-it.LICENSE');
