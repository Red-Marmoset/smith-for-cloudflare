import { it, expect } from 'vitest';
import { renderMarkdown } from '../public/markdown.js';

it('renders reply headings, emphasis, lists, links, quotes, and tables', () => {
  const html = renderMarkdown('# Summary\n\n**Bold** and *italic* with `code` and [docs](https://example.com).\n\n- First\n- Second\n\n1. Step\n2. Next\n\n> Quote\n\n| Name | Value |\n| --- | --- |\n| One | Two |');
  for (const tag of ['<h1>Summary</h1>', '<strong>Bold</strong>', '<em>italic</em>', '<code>code</code>', '<a href="https://example.com">docs</a>', '<ul>', '<ol>', '<blockquote>', '<table>', '<td>Two</td>']) expect(html).toContain(tag);
});

it('preserves code whitespace and escapes code instead of interpreting it', () => {
  const html = renderMarkdown('```html\n<div>\n  **literal**\n</div>\n```');
  expect(html).toContain('<pre><code class="language-html">&lt;div&gt;\n  **literal**\n&lt;/div&gt;\n</code></pre>');
});

it('escapes raw HTML and refuses executable link schemes', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[encoded](jav&#x61;script:alert(1))\n\n[data](data:text/html;base64,PHNjcmlwdD4=)');
  expect(html).not.toMatch(/<script|<img|href="(?:javascript|data):/);
  expect(html).toContain('&lt;script&gt;');
});

it('handles incomplete fenced code and escaped Markdown in replies', () => {
  expect(renderMarkdown('```js\nconst value = 1;')).toContain('<pre><code class="language-js">const value = 1;</code></pre>');
  expect(renderMarkdown('\\*literal\\*')).toContain('<p>*literal*</p>');
});

it('uses CSS classes for table alignment under the site security policy', () => {
  const html = renderMarkdown('| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |');
  for (const align of ['left', 'center', 'right']) {
    expect(html).toContain(`<th class="markdown-align-${align}">`);
    expect(html).toContain(`<td class="markdown-align-${align}">`);
  }
  expect(html).not.toContain('style=');
});
