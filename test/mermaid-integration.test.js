import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { renderArtifactPage } from "../src/lib/render.js";
import { editorVendorPath } from "../src/lib/editor-assets.js";

const source = "flowchart TD\n  시작[사용자 요청] --> 검토{검토 완료?}\n  검토 -->|예| 완료[공유 완료]\n  검토 -->|아니요| 시작";

function renderedFrame() {
  const version = { version: 1, format: "mermaid", metadata: {}, sha256: "0".repeat(64), sizeBytes: 100 };
  const page = renderArtifactPage({ artifact: { id: "diagram", title: "다이어그램", tags: [], versions: [version] }, version, content: source, baseUrl: "http://localhost" });
  const encoded = page.match(/class="artifact-frame artifact-mermaid-frame" sandbox="allow-scripts" srcdoc="([^"]*)"/)[1];
  return encoded.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

test("Mermaid frame preserves strict isolation and classic defaults when calling renderer", async () => {
  const frame = renderedFrame();
  const sourceJson = frame.match(/id="artifacty-mermaid-source">([^<]*)<\/script>/)[1];
  let options;
  let renderedSource;
  const target = {};
  const mermaid = { initialize(value) { options = value; }, async render(id, value) { renderedSource = value; return { svg: "<svg>다이어그램</svg>" }; } };
  const script = frame.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import mermaid from [^;]+;/, "");
  await vm.runInNewContext(`(async () => {${script}})()`, {
    mermaid, document: { getElementById: (id) => id === "artifacty-mermaid-source" ? { textContent: sourceJson } : target, documentElement: {}, body: {} },
    parent: { postMessage() {} }, window: { addEventListener() {} }, setTimeout() {}
  });
  assert.equal(renderedSource, source);
  assert.equal(options.securityLevel, "strict");
  assert.equal(options.layout, "dagre");
  assert.equal(options.theme, "default");
  assert.equal(options.look, "classic");
  assert.equal(target.innerHTML, "<svg>다이어그램</svg>");
});

test("Mermaid browser entry and every relative module import stay locally vendorable", async () => {
  const root = process.cwd();
  const entry = "mermaid/dist/mermaid.esm.min.mjs";
  const seen = new Set();
  const visit = async (specifier) => {
    if (seen.has(specifier)) return;
    seen.add(specifier);
    const file = editorVendorPath(specifier, root);
    assert.ok(file, `${specifier} must pass local vendor allowlist`);
    const source = await readFile(file, "utf8");
    // Covers static imports, re-exports and lazy chunks from the shipped ESM build.
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+\.mjs)["']/g)].map((match) => match[1]);
    for (const relative of imports) await visit(path.posix.join(path.posix.dirname(specifier), relative));
  };
  await visit(entry);
  assert.ok(seen.size > 20, "diagram and layout chunks were traversed");
});
