// Build the same offline help for both coordinators from the maintained Markdown.
import MarkdownIt from 'markdown-it';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sections = [['user-guide', 'Getting started & user guide'], ['smith-json', 'smith.json reference'], ['task-stubs', 'Planned user tasks']];
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sourceBase = 'https://github.com/Red-Marmoset/smith/blob/feature/cloudflare-experiment/';
const md = new MarkdownIt({ html: false, linkify: false });
md.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" aria-label="Scrollable reference table"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
const articles = [], toc = [];
for (const [id, label] of sections) {
  const tokens = md.parse(await readFile(path.join(root, 'docs', id + '.md'), 'utf8'), {});
  const counts = new Map();
  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const text = tokens[i + 1].content;
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const count = (counts.get(slug) || 0) + 1; counts.set(slug, count);
      const anchor = token.tag === 'h1' ? id : `${id}-${slug}${count > 1 ? '-' + count : ''}`;
      token.attrSet('id', anchor);
      if (token.tag === 'h2') toc.push(`<a href="#${anchor}">${escape(text)}</a>`);
    }
    for (const child of token.children || []) {
      if (child.type !== 'link_open') continue;
      const href = child.attrGet('href');
      if (!href || /^(?:[a-z]+:|#|\/)/i.test(href)) continue;
      const destination = path.posix.normalize('docs/' + href);
      const local = sections.find(([name]) => destination === `docs/${name}.md`);
      child.attrSet('href', local ? '#' + local[0] : sourceBase + destination);
    }
  }
  articles.push(`<article aria-label="${escape(label)}">${md.renderer.render(tokens, md.options, {})}</article>`);
}
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Smith Help</title><link rel="stylesheet" href="/help.css"></head>
<body><a class="skip" href="#content">Skip to help content</a><header><a href="/">← Back to Smith</a><strong>Smith Help</strong><span>Setup · Configuration · Troubleshooting</span></header>
<div class="layout"><nav aria-label="Help topics">${sections.map(([id, label]) => `<a class="group" href="#${id}">${escape(label)}</a>`).join('')}<details><summary>All topics</summary>${toc.join('')}</details><p>Use your browser’s Find (Ctrl+F / ⌘F) to search this guide.</p></nav><main id="content">${articles.join('\n')}</main></div></body></html>
`;
const css = await readFile(new URL('./help.css', import.meta.url), 'utf8');
for (const dir of ['cloudflare/coordinator/public', 'web']) {
  await writeFile(path.join(root, dir, 'help.html'), html);
  await writeFile(path.join(root, dir, 'help.css'), css);
}
console.log('Built hosted and native help from docs/user-guide.md, docs/smith-json.md and docs/task-stubs.md');
