import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Exercise the browser's actual pure renderer without starting CodeMirror or a DOM.
const source = await readFile(new URL("../src/client/editor.js", import.meta.url), "utf8");
const preview = vm.runInNewContext(`${source.slice(source.indexOf("function markdownPreview(content)"))}\nmarkdownPreview`);

test("editor Markdown preview groups paragraphs, lists and disabled task controls", () => {
  const html = preview("# Title\n\nfirst line\nsecond line\n\n- one\n- [x] done\n- [ ] pending\nafter list\n\n1. first\n2. second");
  assert.match(html, /<p>first line second line<\/p>/);
  assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /type="checkbox" disabled> pending/);
  assert.match(html, /<\/ul>\n<p>after list<\/p>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
});

test("editor Markdown preview keeps fenced contents literal and handles unclosed and longer fences", () => {
  const html = preview('````js\n<script>bad()</script>\n```\n# literal\n````\n\n~~~mermaid\ngraph TD\nA-->B');
  assert.match(html, /<code class="language-js">&lt;script&gt;bad\(\)&lt;\/script&gt;\n```\n# literal<\/code>/);
  assert.match(html, /<code class="language-mermaid">graph TD\nA--&gt;B<\/code>/);
  assert.doesNotMatch(html, /<script|<h1>|<iframe/);
});

test("editor Markdown preview renders aligned tables and escapes all cells", () => {
  const html = preview('| Left | Center | Right |\n| --- | :---: | ---: |\n| `code` | <img src=x onerror=alert(1)> | 42 |\n\nAfter');
  assert.match(html, /<table class="artifact-table">/);
  assert.match(html, /<th style="text-align:center">Center<\/th>/);
  assert.match(html, /<td style="text-align:left"><code>code<\/code><\/td>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<td style="text-align:right">42<\/td>/);
  assert.match(html, /<\/table><\/div>\n<p>After<\/p>/);
  assert.doesNotMatch(preview('| a | b |\n| --- |'), /<table/);
});

test("editor Markdown preview never activates raw HTML, URLs or fence attributes", () => {
  const html = preview('# <svg onload=alert(1)>\n\n[x](javascript:alert(1))\n![x](data:text/html,bad)\n&NewLine;\n\n- [x] `<img onerror=bad>`\n\n```js\" onclick=bad\n</code><script>bad</script>\n```');
  assert.doesNotMatch(html, /<(?:a|img|svg|script)\b|(?:href|src|onclick)=/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /&amp;NewLine;/);
  assert.match(html, /<code>&lt;img onerror=bad&gt;<\/code>/);
  assert.match(html, /&lt;\/code&gt;&lt;script&gt;bad&lt;\/script&gt;/);
});
