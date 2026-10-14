import MarkdownIt from './vendor/markdown-it.js';

// Bot replies are untrusted: raw HTML stays text and unsafe link schemes are rejected.
const markdown = new MarkdownIt({ html: false });
// The site's CSP blocks inline styles. Convert the parser's table alignment to CSS classes.
function tableCell(tokens, index, options, env, renderer) {
  const token = tokens[index];
  const align = token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1];
  if (align) {
    token.attrs.splice(token.attrIndex('style'), 1);
    token.attrJoin('class', `markdown-align-${align}`);
  }
  return renderer.renderToken(tokens, index, options);
}
markdown.renderer.rules.th_open = tableCell;
markdown.renderer.rules.td_open = tableCell;

export function renderMarkdown(text) {
  return markdown.render(text);
}
