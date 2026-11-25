import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact } from "../src/lib/storage.js";

async function renderMarkdown(t, content) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-markdown-"));
  const app = await startServer({ home, port: 0 });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const artifact = await createArtifact(app.store, { title: "Markdown", content, format: "markdown", sourceAgent: "test" });
  const page = await (await fetch(`${app.url}/artifacts/${artifact.id}`)).text();
  return /<article class="artifact-doc">([\s\S]*?)<\/article>/.exec(page)[1];
}

test("Markdown renders every heading level with linkable anchors", async (t) => {
  const html = await renderMarkdown(t, "# One\n\n## Two\n\n### Three\n\n#### 범위와 사용\n\n##### Five\n\n###### Six\n\n#### 범위와 사용\n\n[Jump](#범위와-사용)");
  for (const level of [1, 2, 3, 5, 6]) assert.match(html, new RegExp(`<h${level} id="[^"]+">`), `h${level}`);
  assert.match(html, /<h4 id="범위와-사용">범위와 사용<\/h4>/);
  assert.match(html, /<h4 id="범위와-사용-1">범위와 사용<\/h4>/, "duplicate headings get unique anchors");
  assert.match(html, /<a href="#범위와-사용">Jump<\/a>/);
  assert.doesNotMatch(html, /####/);
});

test("Markdown renders emphasis, lists, quotes, rules, and inline code", async (t) => {
  const html = await renderMarkdown(t, "**bold** *italic* ~~gone~~ `code`\n\n1. first\n2. second\n   - nested\n\n> quoted **text**\n\n---\n\nend");
  assert.match(html, /<strong>bold<\/strong> <em>italic<\/em> <del>gone<\/del> <code>code<\/code>/);
  assert.match(html, /<ol>\s*<li>first<\/li>\s*<li>second<ul>\s*<li>nested<\/li>/);
  assert.match(html, /<blockquote>\s*<p>quoted <strong>text<\/strong><\/p>\s*<\/blockquote>/);
  assert.match(html, /<hr>/);
});

test("Markdown keeps raw HTML and unsafe URLs inert", async (t) => {
  const html = await renderMarkdown(t, [
    "<script>alert(1)</script>",
    "",
    "Inline <img src=x onerror=alert(2)> html",
    "",
    "[js](javascript:alert(3)) [data](data:text/html,hi) [web](https://example.test/a?b=1) [mail](mailto:a@example.test) [local](/artifacts/x) [anchor](#top)",
    "",
    "![pic](javascript:alert(4)) ![ok](https://example.test/p.png \"Title\")"
  ].join("\n"));
  assert.doesNotMatch(html, /<script|<img src=x|href="(?:javascript|data):|src="(?:javascript|data):/, "no live tag or unsafe URL survives");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /js data /, "unsafe links keep only their text");
  assert.match(html, /<a href="https:\/\/example\.test\/a\?b=1" rel="noopener noreferrer" target="_blank">web<\/a>/);
  assert.match(html, /<a href="mailto:a@example\.test">mail<\/a>/);
  assert.match(html, /<a href="\/artifacts\/x">local<\/a>/);
  assert.match(html, /<a href="#top">anchor<\/a>/);
  assert.match(html, /<img src="https:\/\/example\.test\/p\.png" alt="ok" title="Title" loading="lazy">/);
});

test("Markdown keeps Artifacty's tables, task lists, code fences, and Mermaid embeds", async (t) => {
  const html = await renderMarkdown(t, "| Name | Count | Status |\n| --- | ---: | :---: |\n| a | **1** | ok |\n\n- [x] done\n- [ ] todo\n\n```js\nconsole.log('<b>')\n```\n\n```mermaid\nflowchart TD\n  A --> B\n```");
  assert.match(html, /<div class="artifact-table-scroll"><table class="artifact-table"><thead><tr><th>Name<\/th><th class="align-right">Count<\/th><th class="align-center">Status<\/th><\/tr><\/thead>/);
  assert.match(html, /<td class="align-right"><strong>1<\/strong><\/td>/);
  assert.match(html, /<li class="task-list-item"><label><input type="checkbox" disabled checked class="form-check-input"> done<\/label><\/li>/);
  assert.match(html, /<li class="task-list-item"><label><input type="checkbox" disabled class="form-check-input"> todo<\/label><\/li>/);
  assert.match(html, /<pre><code class="language-js">console\.log\(&#39;&lt;b&gt;&#39;\)<\/code><\/pre>/);
  assert.match(html, /data-artifacty-mermaid/);
});
