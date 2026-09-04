import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { startServer } from "../src/server.js";
import { readServerState } from "../src/lib/server-state.js";
import { awaitEmbeddingIndexing, checkStoreIntegrity, createArtifact, createStore, createUser, listArtifacts, listUsers } from "../src/lib/storage.js";

test("serves HTTP API and browser artifact pages", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-"));
  const app = await startServer({ port: 0, home });

  try {
    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Demo",
        content: "<h1>Hello</h1>",
        format: "html",
        sourceAgent: "test"
      })
    });

    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.title, "Demo");
    assert.ok(created.url.startsWith(app.url));

    const listResponse = await fetch(`${app.url}/api/artifacts`);
    const list = await listResponse.json();
    assert.equal(list.artifacts.length, 1);

    const inferredHtmlResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Inferred HTML",
        content: "<article><h1>Rendered</h1><p>HTML fragment</p></article>",
        sourceAgent: "test"
      })
    });
    assert.equal(inferredHtmlResponse.status, 201);
    const inferredHtml = await inferredHtmlResponse.json();
    assert.equal(inferredHtml.version.format, "html");
    assert.equal(inferredHtml.artifactType, "html-page");

    const filteredResponse = await fetch(`${app.url}/?q=Demo&sourceAgent=test`);
    const filteredPage = await filteredResponse.text();
    assert.equal(filteredResponse.status, 200);
    assert.match(filteredPage, /name="q" value="Demo"/);
    assert.match(filteredPage, /Demo/);

    const pageResponse = await fetch(created.url);
    const page = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(page, /Artifacty|Demo/);
    assert.match(page, /<main class="artifact-view artifact-view-wide">/);

    const rawResponse = await fetch(created.rawUrl);
    assert.equal(await rawResponse.text(), "<h1>Hello</h1>");

    const markdownTableResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Markdown Table",
        content: [
          "| Name | Count | Status |",
          "|:-----|------:|:------:|",
          "| Codex | 2 | ok |",
          "| Artifacty | 10 | ready |"
        ].join("\n"),
        format: "markdown",
        sourceAgent: "test"
      })
    });
    const markdownTableArtifact = await markdownTableResponse.json();
    const markdownTablePage = await (await fetch(markdownTableArtifact.url)).text();
    assert.doesNotMatch(markdownTablePage, /artifact-view artifact-view-wide/);
    assert.match(markdownTablePage, /artifact-table-scroll/);
    assert.match(markdownTablePage, /<table class="artifact-table">/);
    assert.match(markdownTablePage, /<th class="align-left">Name<\/th>/);
    assert.match(markdownTablePage, /<th class="align-right">Count<\/th>/);
    assert.match(markdownTablePage, /<th class="align-center">Status<\/th>/);
    assert.doesNotMatch(markdownTablePage, /\|:-----\|------:\|/);

    const sarifContent = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "CodeQL",
              rules: [
                { id: "js/path-injection", shortDescription: { text: "Path injection" } },
                { id: "js/unused-var", shortDescription: { text: "Unused variable" } }
              ]
            }
          },
          results: [
            {
              ruleId: "js/path-injection",
              level: "warning",
              message: { text: "Validate the path before use." },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/app.js" },
                    region: { startLine: 42, startColumn: 7 }
                  }
                }
              ]
            },
            {
              ruleId: "js/unused-var",
              level: "error",
              message: { text: "Unused variable 'legacyToken'." },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/legacy.js" },
                    region: { startLine: 5, startColumn: 3 }
                  }
                }
              ]
            }
          ]
        }
      ]
    });
    const sarifResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "SARIF Report",
        content: sarifContent,
        format: "sarif",
        sourceAgent: "test"
      })
    });
    const sarifArtifact = await sarifResponse.json();
    assert.equal(sarifArtifact.artifactType, "analysis-report");
    const sarifPage = await (await fetch(sarifArtifact.url)).text();
    assert.match(sarifPage, /artifact-sarif/);
    assert.match(sarifPage, /<main class="artifact-view artifact-view-wide">/);
    assert.match(sarifPage, /js\/path-injection/);
    assert.match(sarifPage, /Validate the path before use\./);
    assert.match(sarifPage, /src\/app\.js:42:7/);
    assert.match(sarifPage, /Raw SARIF JSON/);
    assert.equal(await (await fetch(sarifArtifact.rawUrl)).text(), sarifContent);
    assert.match(sarifPage, /data-sarif-result/);
    assert.match(sarifPage, /data-sarif-sort="level"/);

    const sarifExportErrors = await fetch(`${app.url}/artifacts/${sarifArtifact.id}/export?format=sarif&level=error`);
    assert.equal(sarifExportErrors.status, 200);
    assert.equal(sarifExportErrors.headers.get("content-type"), "application/sarif+json; charset=utf-8");
    assert.match(sarifExportErrors.headers.get("content-disposition") || "", /^attachment; filename="/);
    const sarifExportErrorsBody = await sarifExportErrors.json();
    assert.equal(sarifExportErrorsBody.version, "2.1.0");
    const errorResults = sarifExportErrorsBody.runs.flatMap((run) => run.results);
    assert.equal(errorResults.length, 1);
    assert.equal(errorResults[0].ruleId, "js/unused-var");

    const sarifExportRule = await fetch(`${app.url}/artifacts/${sarifArtifact.id}/export?format=sarif&rule=path-injection`);
    assert.equal(sarifExportRule.status, 200);
    const sarifExportRuleBody = await sarifExportRule.json();
    const ruleResults = sarifExportRuleBody.runs.flatMap((run) => run.results);
    assert.equal(ruleResults.length, 1);
    assert.equal(ruleResults[0].ruleId, "js/path-injection");

    const sarifExportBadLevel = await fetch(`${app.url}/artifacts/${sarifArtifact.id}/export?format=sarif&level=critical`);
    assert.equal(sarifExportBadLevel.status, 400);
    assert.equal((await sarifExportBadLevel.json()).code, "invalid_export");

    const csvExportForSarif = await fetch(`${app.url}/artifacts/${sarifArtifact.id}/export?format=csv`);
    assert.equal(csvExportForSarif.status, 400);
    assert.equal((await csvExportForSarif.json()).code, "invalid_export");

    const sarifExportMissingFormat = await fetch(`${app.url}/artifacts/${sarifArtifact.id}/export`);
    assert.equal(sarifExportMissingFormat.status, 400);
    assert.equal((await sarifExportMissingFormat.json()).code, "invalid_export");

    const csvContent = "name,count,note\nCodex,2,\"Validate, then open\"\nArtifacty,10,\"<script>alert(1)</script>\"";
    const csvResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "CSV Table",
        content: csvContent,
        format: "csv",
        sourceAgent: "test"
      })
    });
    const csvArtifact = await csvResponse.json();
    assert.equal(csvArtifact.artifactType, "table");
    const csvPage = await (await fetch(csvArtifact.url)).text();
    assert.match(csvPage, /artifact-csv/);
    assert.match(csvPage, /<main class="artifact-view artifact-view-wide">/);
    assert.match(csvPage, /Validate, then open/);
    assert.match(csvPage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(csvPage, /<script>alert\(1\)<\/script>/);
    assert.equal(await (await fetch(csvArtifact.rawUrl)).text(), csvContent);
    assert.match(csvPage, /data-csv-table/);
    assert.match(csvPage, /data-csv-col="0"/);

    const csvExportSorted = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=csv&sort=count&dir=desc`);
    assert.equal(csvExportSorted.status, 200);
    assert.equal(csvExportSorted.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(csvExportSorted.headers.get("content-disposition") || "", /^attachment; filename="/);
    const sortedCsvBody = await csvExportSorted.text();
    const sortedLines = sortedCsvBody.trim().split("\n");
    assert.equal(sortedLines[0], "name,count,note");
    assert.equal(sortedLines[1].startsWith("Artifacty,10"), true);

    const csvExportFiltered = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=csv&filter=name:Codex`);
    assert.equal(csvExportFiltered.status, 200);
    const filteredCsvBody = await csvExportFiltered.text();
    assert.match(filteredCsvBody, /Codex/);
    assert.doesNotMatch(filteredCsvBody, /Artifacty/);

    const csvExportBadFormat = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=json`);
    assert.equal(csvExportBadFormat.status, 400);
    const csvExportBadFormatBody = await csvExportBadFormat.json();
    assert.equal(csvExportBadFormatBody.code, "invalid_export");

    const csvExportBadSort = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=csv&sort=nope`);
    assert.equal(csvExportBadSort.status, 400);
    assert.equal((await csvExportBadSort.json()).code, "invalid_export");

    const csvExportBadDir = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=csv&dir=sideways`);
    assert.equal(csvExportBadDir.status, 400);
    assert.equal((await csvExportBadDir.json()).code, "invalid_export");

    const sarifExportForCsv = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=sarif`);
    assert.equal(sarifExportForCsv.status, 400);
    assert.equal((await sarifExportForCsv.json()).code, "invalid_export");

    const pngBase64 = "iVBORw0KGgo=";
    const pngBytes = Buffer.from(pngBase64, "base64");
    const imageResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Screenshot",
        content: pngBase64,
        format: "image",
        contentType: "image/png",
        sourceAgent: "test",
        metadata: { mimeType: "image/png", encoding: "base64" }
      })
    });
    const imageArtifact = await imageResponse.json();
    assert.equal(imageArtifact.artifactType, "asset");
    const imagePage = await (await fetch(imageArtifact.url)).text();
    assert.match(imagePage, /artifact-image/);
    assert.match(imagePage, /<img src="\/artifacts\/screenshot-[^"]+\/raw\?version=1" alt="Image artifact">/);
    const imageRawResponse = await fetch(imageArtifact.rawUrl);
    assert.equal(imageRawResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await imageRawResponse.arrayBuffer()), pngBytes);

    const videoBytes = Buffer.from("webm-demo");
    const videoBase64 = videoBytes.toString("base64");
    const videoResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Demo Video",
        content: videoBase64,
        format: "video",
        contentType: "video/webm",
        sourceAgent: "test",
        metadata: { mimeType: "video/webm", encoding: "base64" }
      })
    });
    const videoArtifact = await videoResponse.json();
    assert.equal(videoArtifact.artifactType, "asset");
    const videoPage = await (await fetch(videoArtifact.url)).text();
    assert.match(videoPage, /artifact-video/);
    assert.match(videoPage, /<video controls preload="metadata" src="\/artifacts\/demo-video-[^"]+\/raw\?version=1"><\/video>/);
    const videoRawResponse = await fetch(videoArtifact.rawUrl);
    assert.equal(videoRawResponse.headers.get("content-type"), "video/webm");
    assert.deepEqual(Buffer.from(await videoRawResponse.arrayBuffer()), videoBytes);

    const codeResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Snippet",
        content: "export function ok() { return true; }",
        format: "code",
        artifactType: "snippet",
        metadata: { language: "javascript" },
        sourceAgent: "test"
      })
    });
    const codeArtifact = await codeResponse.json();
    const codePage = await (await fetch(codeArtifact.url)).text();
    assert.match(codePage, /data-artifacty-code-viewer/);
    assert.match(codePage, /\/assets\/viewer\.js/);
    assert.match(codePage, /type="importmap"/);
    assert.equal(await (await fetch(codeArtifact.rawUrl)).text(), "export function ok() { return true; }");

    const unsafeSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"><script>alert(1)</script><text>ok</text></svg>";
    const svgResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "SVG",
        content: unsafeSvg,
        format: "svg",
        artifactType: "diagram",
        sourceAgent: "test"
      })
    });
    const svgArtifact = await svgResponse.json();
    const svgPage = await (await fetch(svgArtifact.url)).text();
    assert.match(svgPage, /artifact-svg-frame/);
    assert.match(svgPage, /<iframe class="artifact-frame artifact-svg-frame" sandbox srcdoc="/);
    assert.doesNotMatch(svgPage, /allow-scripts/);
    assert.doesNotMatch(svgPage, /onload/);
    assert.doesNotMatch(svgPage, /&lt;script/);
    assert.equal(await (await fetch(svgArtifact.rawUrl)).text(), unsafeSvg);

    const mermaidSource = "flowchart TD\n  A[Codex] --> B[Artifacty]";
    const mermaidResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Mermaid",
        content: mermaidSource,
        format: "mermaid",
        artifactType: "diagram",
        sourceAgent: "test"
      })
    });
    const mermaidArtifact = await mermaidResponse.json();
    const mermaidPage = await (await fetch(mermaidArtifact.url)).text();
    assert.match(mermaidPage, /artifact-mermaid-frame/);
    assert.match(mermaidPage, /sandbox="allow-scripts"/);
    assert.doesNotMatch(mermaidPage, /allow-same-origin/);
    assert.match(mermaidPage, /\/vendor\/npm\/mermaid\/dist\/mermaid\.esm\.min\.mjs/);
    assert.match(mermaidPage, /artifacty-mermaid-source/);
    assert.equal(await (await fetch(mermaidArtifact.rawUrl)).text(), mermaidSource);

    const reactSource = "export default function Demo() { return <strong>ok</strong>; }";
    const reactResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "React",
        content: reactSource,
        format: "react",
        artifactType: "component",
        sourceAgent: "test"
      })
    });
    const reactArtifact = await reactResponse.json();
    const disabledReactPage = await (await fetch(reactArtifact.url)).text();
    assert.match(disabledReactPage, /React rendering is disabled/);
    assert.doesNotMatch(disabledReactPage, /artifact-react-frame/);
    const disabledReactFrame = await fetch(`${app.url}/artifacts/${reactArtifact.id}/react-frame`);
    assert.equal(disabledReactFrame.status, 403);

    const previousReactFlag = process.env.ARTIFACTY_ENABLE_REACT_RENDERER;
    process.env.ARTIFACTY_ENABLE_REACT_RENDERER = "true";
    try {
      const enabledReactPage = await (await fetch(reactArtifact.url)).text();
      assert.match(enabledReactPage, /artifact-react-frame/);
      assert.match(enabledReactPage, /sandbox="allow-scripts"/);
      assert.doesNotMatch(enabledReactPage, /allow-same-origin/);
      const reactFrameResponse = await fetch(`${app.url}/artifacts/${reactArtifact.id}/react-frame`);
      assert.equal(reactFrameResponse.status, 200);
      assert.match(reactFrameResponse.headers.get("content-security-policy"), /unsafe-eval/);
      const reactFrameHtml = await reactFrameResponse.text();
      assert.match(reactFrameHtml, /\/vendor\/npm\/react\/umd\/react\.production\.min\.js/);
      assert.match(reactFrameHtml, /\/vendor\/npm\/react-dom\/umd\/react-dom\.production\.min\.js/);
      assert.match(reactFrameHtml, /\/vendor\/npm\/@babel\/standalone\/babel\.min\.js/);
      assert.doesNotMatch(reactFrameHtml, /allow-same-origin/);
    } finally {
      if (previousReactFlag === undefined) {
        delete process.env.ARTIFACTY_ENABLE_REACT_RENDERER;
      } else {
        process.env.ARTIFACTY_ENABLE_REACT_RENDERER = previousReactFlag;
      }
    }

    const newPageResponse = await fetch(`${app.url}/new`);
    const newPage = await newPageResponse.text();
    assert.equal(newPageResponse.status, 200);
    assert.match(newPage, /<html lang="en">/);
    assert.match(newPage, /New Artifact/);
    assert.match(newPage, /type="importmap"/);
    assert.match(newPage, /data-artifacty-editor/);
    assert.match(newPage, /\/assets\/editor\.js/);
    assert.match(newPage, /window\.ARTIFACTY_I18N/);
    assert.match(newPage, /<option value="code">Code<\/option>/);
    assert.match(newPage, /<option value="svg">Svg<\/option>/);
    assert.match(newPage, /<option value="mermaid">Mermaid<\/option>/);
    assert.match(newPage, /<option value="react">React<\/option>/);
    assert.match(newPage, /<option value="sarif">Sarif<\/option>/);
    assert.match(newPage, /<option value="csv">Csv<\/option>/);
    assert.match(newPage, /<option value="image">Image<\/option>/);
    assert.match(newPage, /<option value="video">Video<\/option>/);
    assert.match(newPage, /<option value="diagram">diagram<\/option>/);
    assert.match(newPage, /<option value="component">component<\/option>/);
    assert.match(newPage, /<option value="snippet">snippet<\/option>/);
    assert.match(newPage, /<option value="analysis-report">analysis-report<\/option>/);
    assert.match(newPage, /<option value="table">table<\/option>/);

    const koreanNewPageResponse = await fetch(`${app.url}/new?lang=ko`);
    const koreanNewPage = await koreanNewPageResponse.text();
    assert.equal(koreanNewPageResponse.status, 200);
    assert.match(koreanNewPage, /<html lang="ko">/);
    assert.match(koreanNewPage, /새 아티팩트/);
    assert.match(koreanNewPage, /name="lang" value="ko"/);
    assert.match(koreanNewPage, /JSON 정리/);

    const editorAssetResponse = await fetch(`${app.url}/assets/editor.js`);
    assert.equal(editorAssetResponse.status, 200);
    assert.match(editorAssetResponse.headers.get("content-type"), /text\/javascript/);
    assert.equal(editorAssetResponse.headers.get("access-control-allow-origin"), null);
    assert.match(await editorAssetResponse.text(), /EditorView/);

    const viewerAssetResponse = await fetch(`${app.url}/assets/viewer.js`);
    assert.equal(viewerAssetResponse.status, 200);
    assert.match(viewerAssetResponse.headers.get("content-type"), /text\/javascript/);
    assert.equal(viewerAssetResponse.headers.get("access-control-allow-origin"), null);
    const viewerAssetText = await viewerAssetResponse.text();
    assert.match(viewerAssetText, /data-artifacty-code-viewer/);
    assert.match(viewerAssetText, /data-artifact-csv/);
    assert.match(viewerAssetText, /data-artifact-sarif/);
    assert.match(viewerAssetText, /addEventListener/);
    assert.doesNotMatch(viewerAssetText, /\son[a-z]+\s*=/i);

    const opaqueViewerAssetResponse = await fetch(`${app.url}/assets/viewer.js`, {
      headers: { origin: "null" }
    });
    assert.equal(opaqueViewerAssetResponse.status, 200);
    assert.equal(opaqueViewerAssetResponse.headers.get("access-control-allow-origin"), "null");
    assert.equal(opaqueViewerAssetResponse.headers.get("vary"), "Origin");

    const codeMirrorVendorResponse = await fetch(`${app.url}/vendor/npm/codemirror`);
    assert.equal(codeMirrorVendorResponse.status, 200);
    assert.match(await codeMirrorVendorResponse.text(), /basicSetup/);

    const styleModVendorResponse = await fetch(`${app.url}/vendor/npm/style-mod`);
    assert.equal(styleModVendorResponse.status, 200);
    assert.match(await styleModVendorResponse.text(), /StyleModule/);

    const mermaidVendorResponse = await fetch(`${app.url}/vendor/npm/mermaid/dist/mermaid.esm.min.mjs`);
    assert.equal(mermaidVendorResponse.status, 200);
    assert.equal(mermaidVendorResponse.headers.get("access-control-allow-origin"), null);
    assert.match(await mermaidVendorResponse.text(), /mermaid/);

    const opaqueMermaidVendorResponse = await fetch(`${app.url}/vendor/npm/mermaid/dist/mermaid.esm.min.mjs`, {
      headers: { origin: "null" }
    });
    assert.equal(opaqueMermaidVendorResponse.status, 200);
    assert.equal(opaqueMermaidVendorResponse.headers.get("access-control-allow-origin"), "null");
    assert.equal(opaqueMermaidVendorResponse.headers.get("vary"), "Origin");

    const reactVendorResponse = await fetch(`${app.url}/vendor/npm/react/umd/react.production.min.js`);
    assert.equal(reactVendorResponse.status, 200);
    assert.match(await reactVendorResponse.text(), /React/);

    const reactDomVendorResponse = await fetch(`${app.url}/vendor/npm/react-dom/umd/react-dom.production.min.js`);
    assert.equal(reactDomVendorResponse.status, 200);
    assert.match(await reactDomVendorResponse.text(), /ReactDOM/);

    const babelVendorResponse = await fetch(`${app.url}/vendor/npm/@babel/standalone/babel.min.js`);
    assert.equal(babelVendorResponse.status, 200);
    assert.match(await babelVendorResponse.text(), /Babel/);

    const blockedVendorSubpathResponse = await fetch(`${app.url}/vendor/npm/mermaid/../package.json`);
    assert.equal(blockedVendorSubpathResponse.status, 404);

    const blockedVendorResponse = await fetch(`${app.url}/vendor/npm/not-allowed`);
    assert.equal(blockedVendorResponse.status, 404);

    const formResponse = await fetch(`${app.url}/new`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "Web Created",
        lang: "ko",
        format: "markdown",
        artifactType: "handoff",
        sourceAgent: "artifacty",
        tags: "web, smoke",
        content: "# Web Created"
      })
    });
    assert.equal(formResponse.status, 303);
    assert.match(formResponse.headers.get("location"), /^\/artifacts\/web-created-/);
    assert.match(formResponse.headers.get("location"), /lang=ko$/);

    const importPageResponse = await fetch(`${app.url}/import`);
    const importPage = await importPageResponse.text();
    assert.equal(importPageResponse.status, 200);
    assert.match(importPage, /Import Artifact/);

    const koreanImportPage = await (await fetch(`${app.url}/import?lang=ko`)).text();
    assert.match(koreanImportPage, /아티팩트 가져오기/);

    const importFormResponse = await fetch(`${app.url}/import`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        agent: "gemini",
        fileName: "gemini-result.json",
        tags: "imported",
        content: JSON.stringify({ title: "Gemini Import", returnDisplay: "# Imported" })
      })
    });
    assert.equal(importFormResponse.status, 303);
    assert.match(importFormResponse.headers.get("location"), /^\/artifacts\/gemini-import-/);

    const editPageResponse = await fetch(`${created.url}/edit`);
    const editPage = await editPageResponse.text();
    assert.equal(editPageResponse.status, 200);
    assert.match(editPage, /Edit Demo/);

    const editResponse = await fetch(`${created.url}/edit`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "Demo",
        format: "html",
        sourceAgent: "test",
        tags: "edited",
        content: "<h1>Hello edited</h1>"
      })
    });
    assert.equal(editResponse.status, 303);

    const diffResponse = await fetch(`${created.url}/diff`);
    const diffPage = await diffResponse.text();
    assert.equal(diffResponse.status, 200);
    assert.match(diffPage, /Demo Diff/);
    assert.match(diffPage, /Hello edited/);

    const archiveResponse = await fetch(`${app.url}/api/artifacts/${created.id}/archive`, {
      method: "POST"
    });
    assert.equal(archiveResponse.status, 200);
    const archived = await archiveResponse.json();
    assert.ok(archived.archivedAt);

    const hiddenList = await (await fetch(`${app.url}/api/artifacts`)).json();
    assert.equal(hiddenList.artifacts.some((artifact) => artifact.id === created.id), false);

    const visibleList = await (await fetch(`${app.url}/api/artifacts?includeArchived=true`)).json();
    assert.equal(visibleList.artifacts.some((artifact) => artifact.id === created.id), true);

    const importResponse = await fetch(`${app.url}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude",
        fileName: "status.html",
        content: "<html><head><title>Status</title></head><body>ok</body></html>"
      })
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();
    assert.equal(imported.title, "Status");
    assert.equal(imported.converted.format, "html");
    assert.equal(imported.version.format, "html");

    const codexImportResponse = await fetch(`${app.url}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "auto",
        content: JSON.stringify({
          agent: "codex",
          title: "Implementation Handoff",
          goal: "Finish the release checklist",
          changedFiles: [
            { path: "README.md", status: "modified", summary: "Add handoff scenario" }
          ],
          nextSteps: ["Run npm run release:check"]
        })
      })
    });
    assert.equal(codexImportResponse.status, 201);
    const codexImported = await codexImportResponse.json();
    assert.equal(codexImported.artifactType, "handoff");
    assert.equal(codexImported.converted.sourceAgent, "codex");
    assert.equal(codexImported.converted.metadata.originalPayloadShape, "codex-continuation");
    assert.match(codexImported.content, /Finish the release checklist/);

    const pagedList = await (await fetch(`${app.url}/api/artifacts?limit=2&offset=1`)).json();
    assert.equal(pagedList.artifacts.length, 2);
    assert.ok(pagedList.pagination.total > 2);
    assert.equal(pagedList.pagination.limit, 2);
    assert.equal(pagedList.pagination.offset, 1);
    assert.equal(pagedList.pagination.previousOffset, 0);
    assert.ok(pagedList.search.backend);

    const pagedDashboard = await (await fetch(`${app.url}/?limit=2`)).text();
    assert.match(pagedDashboard, /1-2 of \d+ artifacts/);
    assert.match(pagedDashboard, /offset=2/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("requires API token when configured and blocks secrets", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-auth-"));
  const app = await startServer({ port: 0, home, apiToken: "test-token" });

  try {
    const rejectedList = await fetch(`${app.url}/api/artifacts`);
    assert.equal(rejectedList.status, 401);

    const acceptedList = await fetch(`${app.url}/api/artifacts`, {
      headers: { "x-artifacty-token": "test-token" }
    });
    assert.equal(acceptedList.status, 200);

    const fakeGithubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const secretResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token"
      },
      body: JSON.stringify({
        title: "Secret",
        content: `token ${fakeGithubToken}`,
        format: "text"
      })
    });
    assert.equal(secretResponse.status, 400);
    const secretBody = await secretResponse.json();
    assert.equal(secretBody.code, "SECRET_DETECTED");
    assert.equal(secretBody.findings[0].type, "github-token");

    const secretImportResponse = await fetch(`${app.url}/api/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-artifacty-token": "test-token"
      },
      body: JSON.stringify({
        agent: "gemini",
        content: JSON.stringify({
          title: "Secret import",
          returnDisplay: `# Secret\n\n${fakeGithubToken}`
        })
      })
    });
    assert.equal(secretImportResponse.status, 400);
    const secretImportBody = await secretImportResponse.json();
    assert.equal(secretImportBody.code, "SECRET_DETECTED");
    assert.equal(secretImportBody.findings[0].type, "github-token");

    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-artifacty-token": "test-token"
      },
      body: JSON.stringify({
        title: "Token Demo",
        content: "ok",
        format: "text",
        sourceAgent: "test"
      })
    });
    assert.equal(createResponse.status, 201);

    const auditResponse = await fetch(`${app.url}/api/audit`, {
      headers: { "x-artifacty-token": "test-token" }
    });
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.ok(audit.events.some((event) => event.action === "create"));

    // GET /artifacts/:id/export is not under /api/, but it renders a fresh
    // export file server-side (not just re-serving stored bytes like /raw),
    // so it must require the same token when one is configured rather than
    // being reachable by anyone who can hit the artifact page.
    const csvArtifact = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-artifacty-token": "test-token" },
      body: JSON.stringify({ title: "Export Auth CSV", content: "a,b\n1,2", format: "csv", sourceAgent: "test" })
    })).json();

    const unauthedExport = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=csv`);
    assert.equal(unauthedExport.status, 401);

    const authedExport = await fetch(`${app.url}/artifacts/${csvArtifact.id}/export?format=csv`, {
      headers: { "x-artifacty-token": "test-token" }
    });
    assert.equal(authedExport.status, 200);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("supports token-protected admin backup API", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-backup-api-"));
  const app = await startServer({ port: 0, home, apiToken: "test-token" });
  const store = createStore({ home });

  try {
    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-artifacty-token": "test-token"
      },
      body: JSON.stringify({
        title: "API Backup Kept",
        content: "kept",
        format: "text",
        sourceAgent: "test"
      })
    });
    assert.equal(createResponse.status, 201);
    const kept = await createResponse.json();

    const exportResponse = await fetch(`${app.url}/api/admin/backup`, {
      headers: { "x-artifacty-token": "test-token" }
    });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-disposition"), /attachment; filename="artifacty-/);
    const backup = await exportResponse.json();
    assert.equal(backup.artifacts[0].id, kept.id);

    const createRemovedResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-artifacty-token": "test-token"
      },
      body: JSON.stringify({
        title: "API Backup Removed",
        content: "removed",
        format: "text",
        sourceAgent: "test"
      })
    });
    assert.equal(createRemovedResponse.status, 201);
    assert.equal((await listArtifacts(store)).length, 2);

    const restoreResponse = await fetch(`${app.url}/api/admin/backup/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-artifacty-token": "test-token"
      },
      body: JSON.stringify(backup)
    });
    assert.equal(restoreResponse.status, 200);
    assert.equal((await restoreResponse.json()).artifactCount, 1);
    assert.deepEqual((await listArtifacts(store)).map((artifact) => artifact.id), [kept.id]);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("supports login, user token management, and admin users", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-users-"));
  const app = await startServer({ port: 0, home });

  try {
    const loginPage = await (await fetch(`${app.url}/login`)).text();
    assert.match(loginPage, /Create admin account/);

    const setupResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "admin@example.com",
        name: "Admin",
        password: "password-123"
      })
    });
    assert.equal(setupResponse.status, 303);
    const cookie = setupResponse.headers.get("set-cookie");
    assert.match(cookie, /artifacty_session=/);

    const accountResponse = await fetch(`${app.url}/account`, {
      headers: { cookie }
    });
    assert.equal(accountResponse.status, 200);
    assert.match(await accountResponse.text(), /admin@example\.com/);

    const tokenResponse = await fetch(`${app.url}/account/tokens`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ name: "Codex central token" })
    });
    assert.equal(tokenResponse.status, 200);
    const tokenPage = await tokenResponse.text();
    const token = /arty_[A-Za-z0-9_-]+/.exec(tokenPage)?.[0];
    assert.ok(token);

    const rejected = await fetch(`${app.url}/api/artifacts`);
    assert.equal(rejected.status, 401);

    const createdResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "User Auth Demo",
        content: "owned",
        format: "text",
        sourceAgent: "codex"
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.title, "User Auth Demo");
    assert.equal(created.publisherId, "admin@example.com");
    assert.equal(created.publisherName, "Admin");
    assert.ok(created.publisherUserId);

    const versionedResponse = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "User Auth Demo",
        content: "accidental edit",
        format: "text",
        sourceAgent: "codex"
      })
    });
    assert.equal(versionedResponse.status, 200);
    assert.equal((await versionedResponse.json()).latestVersion, 2);

    const artifactPageResponse = await fetch(`${app.url}/artifacts/${created.id}`, {
      headers: { cookie }
    });
    assert.equal(artifactPageResponse.status, 200);
    assert.match(await artifactPageResponse.text(), /Versions/);

    const versionsPageResponse = await fetch(`${app.url}/admin/artifacts/${created.id}/versions?version=1`, {
      headers: { cookie }
    });
    assert.equal(versionsPageResponse.status, 200);
    const versionsPage = await versionsPageResponse.text();
    assert.match(versionsPage, /Manage versions/);
    assert.match(versionsPage, /v1 content/);

    const repairResponse = await fetch(`${app.url}/admin/artifacts/${created.id}/versions/1/repair`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        format: "text",
        content: "owned fixed",
        reason: "Correct imported content"
      })
    });
    assert.equal(repairResponse.status, 303);

    const repairedResponse = await fetch(`${app.url}/api/artifacts/${created.id}?version=1`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(repairedResponse.status, 200);
    assert.equal((await repairedResponse.json()).content, "owned fixed");

    const deleteVersionResponse = await fetch(`${app.url}/admin/artifacts/${created.id}/versions/2/delete`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        reason: "Remove accidental edit"
      })
    });
    assert.equal(deleteVersionResponse.status, 303);

    const cleanedResponse = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(cleanedResponse.status, 200);
    const cleaned = await cleanedResponse.json();
    assert.equal(cleaned.latestVersion, 1);
    assert.equal(cleaned.content, "owned fixed");

    const listResponse = await fetch(`${app.url}/api/artifacts?q=admin@example.com`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0].publisherId, "admin@example.com");

    const auditResponse = await fetch(`${app.url}/api/audit`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const audit = await auditResponse.json();
    assert.ok(audit.events.some((event) => event.action === "create" && event.actor === "admin@example.com"));

    const usersResponse = await fetch(`${app.url}/admin/users`, {
      headers: { cookie }
    });
    assert.equal(usersResponse.status, 200);
    const usersPage = await usersResponse.text();
    assert.match(usersPage, /Create user/);
    assert.match(usersPage, /Import users from CSV/);

    const createUserResponse = await fetch(`${app.url}/admin/users`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        email: "user@example.com",
        name: "User",
        role: "user",
        password: "password-456"
      })
    });
    assert.equal(createUserResponse.status, 303);

    const importUsersResponse = await fetch(`${app.url}/admin/users/import`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        csv: "email,name,role\nreset@example.com,Reset User,user"
      })
    });
    assert.equal(importUsersResponse.status, 200);
    const importUsersPage = await importUsersResponse.text();
    const temporaryPassword = /tmp_[A-Za-z0-9_-]+/.exec(importUsersPage)?.[0];
    assert.ok(temporaryPassword);
    assert.match(importUsersPage, /Reset required/);

    const resetLoginResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "reset@example.com",
        password: temporaryPassword
      })
    });
    assert.equal(resetLoginResponse.status, 303);
    assert.equal(resetLoginResponse.headers.get("location"), "/account/password?required=1");
    const resetCookie = resetLoginResponse.headers.get("set-cookie");

    const blockedAccountResponse = await fetch(`${app.url}/account`, {
      redirect: "manual",
      headers: { cookie: resetCookie }
    });
    assert.equal(blockedAccountResponse.status, 303);
    assert.equal(blockedAccountResponse.headers.get("location"), "/account/password?required=1");

    const passwordPage = await fetch(`${app.url}/account/password?required=1`, {
      headers: { cookie: resetCookie }
    });
    assert.equal(passwordPage.status, 200);
    assert.match(await passwordPage.text(), /Password change is required/);

    const changePasswordResponse = await fetch(`${app.url}/account/password`, {
      method: "POST",
      headers: {
        cookie: resetCookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        currentPassword: temporaryPassword,
        newPassword: "changed-password-123",
        confirmPassword: "changed-password-123"
      })
    });
    assert.equal(changePasswordResponse.status, 200);
    assert.match(await changePasswordResponse.text(), /Password changed/);

    const resetAccountResponse = await fetch(`${app.url}/account`, {
      headers: { cookie: resetCookie }
    });
    assert.equal(resetAccountResponse.status, 200);
    assert.match(await resetAccountResponse.text(), /reset@example\.com/);

    const loginUserResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "user@example.com",
        password: "password-456"
      })
    });
    assert.equal(loginUserResponse.status, 303);
    assert.match(loginUserResponse.headers.get("set-cookie"), /artifacty_session=/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("lets admins download and restore artifact backups from the browser", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-backup-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });

  try {
    const setupResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "admin@example.com",
        name: "Admin",
        password: "password-123"
      })
    });
    assert.equal(setupResponse.status, 303);
    const cookie = setupResponse.headers.get("set-cookie");

    const createKeptResponse = await fetch(`${app.url}/new`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        title: "Backup Kept",
        content: "kept",
        format: "text",
        artifactType: "document",
        sourceAgent: "artifacty"
      })
    });
    assert.equal(createKeptResponse.status, 303);
    const keptId = createKeptResponse.headers.get("location").split("/").pop();

    const backupPageResponse = await fetch(`${app.url}/admin/backup`, {
      headers: { cookie }
    });
    assert.equal(backupPageResponse.status, 200);
    const backupPage = await backupPageResponse.text();
    assert.match(backupPage, /Download backup/);
    assert.match(backupPage, /Restore backup/);
    assert.match(backupPage, /name="scope"/);
    assert.match(backupPage, /name="confirm"/);
    assert.match(backupPage, /name="forceUsers"/);

    const exportResponse = await fetch(`${app.url}/admin/backup/export`, {
      headers: { cookie }
    });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-disposition"), /attachment; filename="artifacty-/);
    const backupJson = await exportResponse.text();
    const backup = JSON.parse(backupJson);
    assert.equal(backup.artifacts.length, 1);
    assert.equal(backup.artifacts[0].id, keptId);

    const createRemovedResponse = await fetch(`${app.url}/new`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        title: "Backup Removed",
        content: "removed",
        format: "text",
        artifactType: "document",
        sourceAgent: "artifacty"
      })
    });
    assert.equal(createRemovedResponse.status, 303);
    assert.equal((await listArtifacts(store)).length, 2);

    const restoreResponse = await fetch(`${app.url}/admin/backup/import`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ backup: backupJson })
    });
    assert.equal(restoreResponse.status, 200);
    assert.match(await restoreResponse.text(), /Restore complete/);

    const artifacts = await listArtifacts(store);
    assert.deepEqual(artifacts.map((artifact) => artifact.id), [keptId]);
    const integrity = await checkStoreIntegrity(store);
    assert.equal(integrity.ok, true);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("full-scope backup and restore round trip through the admin API", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-backup-full-"));
  const app = await startServer({ port: 0, home, apiToken: "test-token" });
  const store = createStore({ home });
  const authHeaders = { "x-artifacty-token": "test-token" };

  try {
    await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "admin@example.com",
        name: "Admin",
        password: "password-123"
      })
    });

    const exportResponse = await fetch(`${app.url}/api/admin/backup?scope=full`, {
      headers: authHeaders
    });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-disposition"), /attachment; filename="artifacty-full-/);
    const bundle = await exportResponse.json();
    assert.equal(bundle.scope, "full");
    assert.ok(bundle.full);
    assert.equal(bundle.full.users.length, 1);
    assert.equal(bundle.full.sessions, undefined);

    // Missing confirm is refused.
    const missingConfirm = await fetch(`${app.url}/api/admin/backup/import`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ bundle })
    });
    assert.equal(missingConfirm.status, 400);

    // Existing users are refused without forceUsers.
    const noForce = await fetch(`${app.url}/api/admin/backup/import`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ bundle, confirm: "replace-all" })
    });
    assert.equal(noForce.status, 409);

    const restoreResponse = await fetch(`${app.url}/api/admin/backup/import`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ bundle, confirm: "replace-all", forceUsers: true })
    });
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json();
    assert.equal(restored.scope, "full");
    assert.equal(restored.tableCounts.users, 1);

    const users = await listUsers(store);
    assert.deepEqual(users.map((user) => user.email), ["admin@example.com"]);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("serves token-protected MCP over HTTP when enabled", async () => {
  const disabledHome = await mkdtemp(path.join(tmpdir(), "artifacty-server-mcp-disabled-"));
  const disabledApp = await startServer({ port: 0, home: disabledHome });
  try {
    const disabledResponse = await fetch(`${disabledApp.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    assert.equal(disabledResponse.status, 404);
  } finally {
    await disabledApp.close();
    await rm(disabledHome, { recursive: true, force: true });
  }

  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-mcp-"));
  const app = await startServer({ port: 0, home, apiToken: "mcp-token", mcpHttp: true });

  async function mcpRequest(method, params = {}, id = 1) {
    const response = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mcp-token"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, id);
    assert.equal(body.error, undefined);
    return body.result;
  }

  try {
    const rejected = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    assert.equal(rejected.status, 401);

    const initialized = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mcp-token"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });
    assert.equal(initialized.status, 202);

    const init = await mcpRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "http-test", version: "0.0.0" }
    });
    assert.equal(init.protocolVersion, "2025-06-18");

    const listed = await mcpRequest("tools/list", {}, 2);
    assert.ok(listed.tools.some((tool) => tool.name === "artifacty_create"));

    const created = await mcpRequest("tools/call", {
      name: "artifacty_create",
      arguments: {
        title: "HTTP MCP Demo",
        content: "central",
        format: "text",
        sourceAgent: "http-mcp-test"
      }
    }, 3);
    assert.equal(created.isError, false);
    assert.match(created.structuredContent.url, new RegExp(`^${escapeRegExp(app.url)}/artifacts/`));

    const fetched = await mcpRequest("tools/call", {
      name: "artifacty_get",
      arguments: { id: created.structuredContent.id }
    }, 4);
    assert.equal(fetched.structuredContent.content, "central");
    assert.equal(fetched.structuredContent.transport, undefined);

    const info = await mcpRequest("tools/call", {
      name: "artifacty_info",
      arguments: {}
    }, 5);
    assert.equal(info.structuredContent.transport, "streamable-http");
    assert.equal(info.structuredContent.url, app.url);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("rejects non-local host without explicit share mode and token", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-lan-"));
  try {
    await assert.rejects(
      startServer({ host: "0.0.0.0", port: 0, home }),
      /Non-local host requires ARTIFACTY_SHARE_MODE/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps explicit port failures but supports intentional fallback", async () => {
  const blockerHome = await mkdtemp(path.join(tmpdir(), "artifacty-port-blocker-"));
  const fallbackHome = await mkdtemp(path.join(tmpdir(), "artifacty-port-fallback-"));
  const blocker = await startServer({ port: 0, home: blockerHome });
  let fallback;

  try {
    await assert.rejects(
      startServer({ port: blocker.port, home: fallbackHome }),
      /EADDRINUSE|address already in use/i
    );

    fallback = await startServer({
      port: blocker.port,
      portFallback: true,
      home: fallbackHome
    });
    assert.notEqual(fallback.port, blocker.port);
    assert.equal(fallback.portFallback, true);

    const state = await readServerState(fallback.store);
    assert.equal(state.url, fallback.url);
    assert.equal(state.port, fallback.port);
    assert.equal(state.requestedPort, blocker.port);
  } finally {
    if (fallback) {
      await fallback.close();
    }
    await blocker.close();
    await rm(blockerHome, { recursive: true, force: true });
    await rm(fallbackHome, { recursive: true, force: true });
  }
});

test("allows null-origin CORS only for vendored JS assets, not sensitive routes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-cors-"));
  const app = await startServer({ port: 0, home });

  // Vendored ES modules (e.g. the Mermaid renderer) are imported from a sandboxed
  // iframe with no `allow-same-origin`, so its requests carry `Origin: null`. The
  // asset route must echo `Access-Control-Allow-Origin: null` or the import is
  // blocked by CORS and the diagram renders blank. Guards that regression headlessly.
  const vendorPath = "/vendor/npm/mermaid/dist/mermaid.esm.min.mjs";

  try {
    const nullOrigin = await rawRequest(app.url, "HEAD", vendorPath, { Origin: "null" });
    assert.equal(nullOrigin.status, 200);
    assert.match(nullOrigin.headers["content-type"], /javascript/);
    assert.equal(nullOrigin.headers["access-control-allow-origin"], "null");
    assert.equal(nullOrigin.headers["vary"], "Origin");

    const noOrigin = await rawRequest(app.url, "HEAD", vendorPath, {});
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);

    const otherOrigin = await rawRequest(app.url, "HEAD", vendorPath, { Origin: "https://evil.example" });
    assert.equal(otherOrigin.headers["access-control-allow-origin"], undefined);

    // The allowance is scoped to static JS assets — sensitive routes never echo it.
    const api = await rawRequest(app.url, "GET", "/api/artifacts", { Origin: "null" });
    assert.equal(api.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("allows same-origin browser writes from central hosts and rejects cross-origin writes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-origin-"));
  const app = await startServer({ port: 0, home });

  try {
    const createdResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Central Edit",
        content: "before",
        format: "text",
        sourceAgent: "test"
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const centralHost = "10.0.0.50:8787";
    const form = new URLSearchParams({
      title: "Central Edit",
      format: "text",
      sourceAgent: "test",
      tags: "central",
      content: "after"
    }).toString();

    const sameOrigin = await rawRequestWithBody(app.url, "POST", `/artifacts/${created.id}/edit`, {
      Host: centralHost,
      Origin: `http://${centralHost}`,
      "content-type": "application/x-www-form-urlencoded"
    }, form);
    assert.equal(sameOrigin.status, 303);

    const updated = await (await fetch(`${app.url}/api/artifacts/${created.id}`)).json();
    assert.equal(updated.content, "after");

    const crossOrigin = await rawRequestWithBody(app.url, "POST", `/artifacts/${created.id}/edit`, {
      Host: centralHost,
      Origin: "https://evil.example",
      "content-type": "application/x-www-form-urlencoded"
    }, form);
    assert.equal(crossOrigin.status, 403);
    assert.match(crossOrigin.body, /NON_LOCAL_ORIGIN/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("serves the OpenAPI document and HTML API reference with no auth required", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-openapi-"));
  const app = await startServer({ port: 0, home, apiToken: "secret-token" });

  try {
    const specResponse = await fetch(`${app.url}/openapi.json`);
    assert.equal(specResponse.status, 200);
    assert.match(specResponse.headers.get("content-type") || "", /application\/json/);
    assert.equal(specResponse.headers.get("cache-control"), "no-store");
    const spec = await specResponse.json();
    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.paths["/api/artifacts"]);
    assert.ok(spec.paths["/api/artifacts"].get);
    assert.ok(spec.paths["/api/artifacts"].post);

    const docsResponse = await fetch(`${app.url}/docs/api`);
    assert.equal(docsResponse.status, 200);
    assert.match(docsResponse.headers.get("content-type") || "", /text\/html/);
    const html = await docsResponse.text();
    assert.match(html, /Artifacty API reference/);
    assert.match(html, /\/api\/artifacts/);
    assert.match(html, /openapi\.json/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("enforces optimistic concurrency on the API and browser edit form", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-concurrency-"));
  const app = await startServer({ port: 0, home });

  try {
    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Concurrent Doc",
        content: "v1",
        format: "text",
        sourceAgent: "test"
      })
    });
    const created = await createResponse.json();
    assert.equal(created.latestVersion, 1);

    const getResponse = await fetch(`${app.url}/api/artifacts/${created.id}`);
    assert.equal(getResponse.status, 200);
    const etag = getResponse.headers.get("etag");
    assert.equal(etag, `"${created.id}:1"`);

    const notModified = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      headers: { "if-none-match": etag }
    });
    assert.equal(notModified.status, 304);

    const weakMatch = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      headers: { "if-none-match": `W/${etag}` }
    });
    assert.equal(weakMatch.status, 304);

    const updateOk = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": etag },
      body: JSON.stringify({ content: "v2", format: "text" })
    });
    assert.equal(updateOk.status, 200);
    const updated = await updateOk.json();
    assert.equal(updated.latestVersion, 2);

    const conflictResponse = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "v3-conflict", format: "text", expectedVersion: 1 })
    });
    assert.equal(conflictResponse.status, 409);
    const conflictBody = await conflictResponse.json();
    assert.equal(conflictBody.error, "Version conflict");
    assert.equal(conflictBody.code, "version_conflict");
    assert.equal(conflictBody.details.latestVersion, 2);

    const stillV2 = await (await fetch(`${app.url}/api/artifacts/${created.id}`)).json();
    assert.equal(stillV2.latestVersion, 2);
    assert.equal(stillV2.content, "v2");

    const editPage = await (await fetch(`${created.url}/edit`)).text();
    assert.match(editPage, /name="expectedVersion" value="2"/);

    const conflictEditResponse = await fetch(`${created.url}/edit`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "Concurrent Doc",
        format: "text",
        sourceAgent: "test",
        content: "unsaved edit",
        expectedVersion: "1"
      })
    });
    assert.equal(conflictEditResponse.status, 409);
    const conflictEditHtml = await conflictEditResponse.text();
    assert.match(conflictEditHtml, /changed since you started editing/);
    assert.match(conflictEditHtml, new RegExp(`/artifacts/${created.id}/diff`));
    assert.match(conflictEditHtml, />unsaved edit</);

    const afterFailedEdit = await (await fetch(`${app.url}/api/artifacts/${created.id}`)).json();
    assert.equal(afterFailedEdit.latestVersion, 2);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("exposes artifact relations over the HTTP API", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-relations-"));
  const app = await startServer({ port: 0, home });

  try {
    const a = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A", content: "a", sourceAgent: "test" })
    })).json();

    const b = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "B",
        content: "b",
        sourceAgent: "test",
        relations: [{ toId: a.id, relation: "derived-from" }]
      })
    })).json();

    const aWithRelations = await (await fetch(`${app.url}/api/artifacts/${a.id}`)).json();
    assert.equal(aWithRelations.relations.incoming.length, 1);
    assert.equal(aWithRelations.relations.incoming[0].relation, "derives");
    assert.equal(aWithRelations.relations.incoming[0].artifactId, b.id);

    const listRelationsResponse = await fetch(`${app.url}/api/artifacts/${b.id}/relations`);
    assert.equal(listRelationsResponse.status, 200);
    const listedRelations = await listRelationsResponse.json();
    assert.equal(listedRelations.outgoing.length, 1);
    assert.equal(listedRelations.outgoing[0].relation, "derived-from");

    const linkResponse = await fetch(`${app.url}/api/artifacts/${b.id}/relations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toId: a.id, relation: "references" })
    });
    assert.equal(linkResponse.status, 201);
    const linkBody = await linkResponse.json();
    assert.equal(linkBody.fromId, b.id);
    assert.equal(linkBody.toId, a.id);
    assert.equal(linkBody.relation, "references");
    assert.ok(linkBody.id);

    const relatedListResponse = await fetch(`${app.url}/api/artifacts?relatedTo=${encodeURIComponent(a.id)}`);
    const relatedList = await relatedListResponse.json();
    assert.equal(relatedList.artifacts.length, 1);
    assert.equal(relatedList.artifacts[0].id, b.id);

    const relatedFilteredResponse = await fetch(`${app.url}/api/artifacts?relatedTo=${encodeURIComponent(a.id)}&relation=references`);
    const relatedFiltered = await relatedFilteredResponse.json();
    assert.equal(relatedFiltered.artifacts.length, 1);
    assert.equal(relatedFiltered.artifacts[0].id, b.id);

    const badRelationResponse = await fetch(`${app.url}/api/artifacts/${b.id}/relations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toId: a.id, relation: "not-a-relation" })
    });
    assert.equal(badRelationResponse.status, 400);
    const badRelationBody = await badRelationResponse.json();
    assert.equal(badRelationBody.code, "INVALID_RELATION");

    const deleteResponse = await fetch(`${app.url}/api/artifacts/${b.id}/relations/${linkBody.id}`, {
      method: "DELETE"
    });
    assert.equal(deleteResponse.status, 200);

    const afterDelete = await (await fetch(`${app.url}/api/artifacts/${b.id}/relations`)).json();
    assert.equal(afterDelete.outgoing.length, 1);
    assert.equal(afterDelete.outgoing[0].relation, "derived-from");

    const viewerPage = await (await fetch(`${app.url}/artifacts/${a.id}`)).text();
    assert.match(viewerPage, /relations/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("exposes comments and review status over the HTTP API, and escapes comment bodies in the viewer", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-comments-"));
  const app = await startServer({ port: 0, home });

  try {
    const created = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Doc", content: "hello", format: "text", sourceAgent: "test" })
    })).json();

    const addResponse = await fetch(`${app.url}/api/artifacts/${created.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "<script>alert(1)</script> please fix", anchor: { line: 1 } })
    });
    assert.equal(addResponse.status, 201);
    const comment = await addResponse.json();
    assert.ok(comment.id);
    assert.equal(comment.status, "open");
    assert.deepEqual(comment.anchor, { line: 1 });

    const listResponse = await fetch(`${app.url}/api/artifacts/${created.id}/comments`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.comments.length, 1);
    assert.equal(listed.comments[0].id, comment.id);

    const resolveResponse = await fetch(`${app.url}/api/artifacts/${created.id}/comments/${comment.id}/resolve`, {
      method: "POST"
    });
    assert.equal(resolveResponse.status, 200);
    const resolved = await resolveResponse.json();
    assert.equal(resolved.status, "resolved");

    const openAfterResolve = await (await fetch(`${app.url}/api/artifacts/${created.id}/comments?status=open`)).json();
    assert.equal(openAfterResolve.comments.length, 0);

    const reviewStatusResponse = await fetch(`${app.url}/api/artifacts/${created.id}/review-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" })
    });
    assert.equal(reviewStatusResponse.status, 200);
    const withStatus = await reviewStatusResponse.json();
    assert.equal(withStatus.reviewStatus, "approved");

    const deleteResponse = await fetch(`${app.url}/api/artifacts/${created.id}/comments/${comment.id}`, {
      method: "DELETE"
    });
    assert.equal(deleteResponse.status, 200);
    const afterDelete = await (await fetch(`${app.url}/api/artifacts/${created.id}/comments`)).json();
    assert.equal(afterDelete.comments.length, 0);
    const withDeleted = await (await fetch(`${app.url}/api/artifacts/${created.id}/comments?includeDeleted=true`)).json();
    assert.equal(withDeleted.comments.length, 1);

    // The comment body must never render as raw, executable HTML in the
    // viewer page: the sanitized markdown pipeline should escape it.
    const secondComment = await (await fetch(`${app.url}/api/artifacts/${created.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "<script>alert(2)</script>" })
    })).json();
    const viewerPage = await (await fetch(`${app.url}/artifacts/${created.id}`)).text();
    assert.doesNotMatch(viewerPage, /<script>alert\(2\)<\/script>/);
    assert.match(viewerPage, /alert\(2\)/);
    assert.match(viewerPage, /Comments|comments/);
    assert.ok(secondComment.id);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("renders a structured diff page with escaping and serves the diff API as JSON", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-diff-"));
  const app = await startServer({ port: 0, home });

  try {
    const created = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Diff Demo",
        content: JSON.stringify({ items: [{ id: "a", label: "one" }] }),
        format: "json",
        sourceAgent: "test"
      })
    })).json();

    const updated = await (await fetch(`${app.url}/api/artifacts/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: JSON.stringify({ items: [{ id: "a", label: "<script>alert(1)</script>" }] }),
        format: "json",
        expectedVersion: created.latestVersion
      })
    })).json();
    assert.equal(updated.latestVersion, 2);

    // Structured view is the default for JSON artifacts.
    const diffPageResponse = await fetch(`${created.url}/diff`);
    const diffPage = await diffPageResponse.text();
    assert.equal(diffPageResponse.status, 200);
    assert.match(diffPage, /\$\.items\[0\]\.label/);
    assert.doesNotMatch(diffPage, /<script>alert\(1\)<\/script>/);
    assert.match(diffPage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

    // Explicit view=lines falls back to the plain line-diff table.
    const linesPageResponse = await fetch(`${created.url}/diff?view=lines`);
    const linesPage = await linesPageResponse.text();
    assert.equal(linesPageResponse.status, 200);
    assert.doesNotMatch(linesPage, /<script>alert\(1\)<\/script>/);

    const apiDiffResponse = await fetch(`${app.url}/api/artifacts/${created.id}/diff`);
    assert.equal(apiDiffResponse.status, 200);
    const apiDiff = await apiDiffResponse.json();
    assert.equal(apiDiff.view, "structured");
    assert.equal(apiDiff.format, "json");
    assert.equal(apiDiff.structuredDiff.kind, "json");
    const changed = apiDiff.structuredDiff.entries.find((entry) => entry.op === "changed");
    assert.ok(changed);
    assert.equal(changed.path, "$.items[0].label");
    assert.equal(changed.after, "<script>alert(1)</script>");

    const apiLinesResponse = await fetch(`${app.url}/api/artifacts/${created.id}/diff?view=lines`);
    const apiLines = await apiLinesResponse.json();
    assert.equal(apiLines.view, "lines");
    assert.ok(Array.isArray(apiLines.diffRows));
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("filters /api/artifacts by artifactType, publisher, date range, and reviewStatus", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-filters-"));
  const app = await startServer({ port: 0, home });

  try {
    const handoff = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Handoff", content: "a", artifactType: "handoff", sourceAgent: "agent-a" })
    })).json();
    await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Doc", content: "b", artifactType: "document", sourceAgent: "agent-b" })
    })).json();

    const byType = await (await fetch(`${app.url}/api/artifacts?artifactType=handoff`)).json();
    assert.equal(byType.artifacts.length, 1);
    assert.equal(byType.artifacts[0].id, handoff.id);

    const byPublisher = await (await fetch(`${app.url}/api/artifacts?publisher=nobody`)).json();
    assert.equal(byPublisher.artifacts.length, 0);

    const inRange = await (await fetch(`${app.url}/api/artifacts?createdAfter=2000-01-01&createdBefore=2999-01-01`)).json();
    assert.equal(inRange.artifacts.length, 2);

    const invalidDate = await fetch(`${app.url}/api/artifacts?createdAfter=not-a-date`);
    assert.equal(invalidDate.status, 400);
    const invalidBody = await invalidDate.json();
    assert.equal(invalidBody.code, "invalid_filter");

    const byReviewStatus = await (await fetch(`${app.url}/api/artifacts?reviewStatus=none`)).json();
    assert.equal(byReviewStatus.artifacts.length, 2);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("/api/artifacts supports mode=keyword|semantic|hybrid and falls back without a provider", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-mode-"));
  const app = await startServer({ port: 0, home });

  try {
    await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Deploy report", content: "deploy failed", sourceAgent: "agent-a" })
    })).json();

    const fallback = await (await fetch(`${app.url}/api/artifacts?q=deploy&mode=semantic`)).json();
    assert.equal(fallback.search.mode, "keyword");
    assert.equal(fallback.search.fallback, true);

    const keyword = await (await fetch(`${app.url}/api/artifacts?q=deploy&mode=keyword`)).json();
    assert.equal(keyword.search.mode, "keyword");

    const invalidMode = await fetch(`${app.url}/api/artifacts?q=deploy&mode=nonsense`);
    assert.equal(invalidMode.status, 400);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("/api/artifacts mode=semantic and mode=hybrid use a configured embedding provider", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-mode-provider-"));
  const previousCommand = process.env.ARTIFACTY_EMBEDDINGS_COMMAND;
  process.env.ARTIFACTY_EMBEDDINGS_COMMAND = `node ${JSON.stringify(path.resolve("scripts/fixtures/embeddings-command.js"))}`;
  const app = await startServer({ port: 0, home });

  try {
    await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Deploy report", content: "deploy failed", sourceAgent: "agent-a" })
    })).json();
    // Wait for the background embedding indexing scheduled after create.
    await awaitEmbeddingIndexing();

    const semantic = await (await fetch(`${app.url}/api/artifacts?q=deploy&mode=semantic`)).json();
    assert.equal(semantic.search.mode, "semantic");
    assert.equal(semantic.artifacts.length, 1);
    assert.ok(typeof semantic.artifacts[0].searchScore === "number");

    const hybrid = await (await fetch(`${app.url}/api/artifacts?q=deploy&mode=hybrid`)).json();
    assert.equal(hybrid.search.mode, "hybrid");

    const defaultMode = await (await fetch(`${app.url}/api/artifacts?q=deploy`)).json();
    assert.equal(defaultMode.search.mode, "hybrid");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
    if (previousCommand === undefined) {
      delete process.env.ARTIFACTY_EMBEDDINGS_COMMAND;
    } else {
      process.env.ARTIFACTY_EMBEDDINGS_COMMAND = previousCommand;
    }
  }
});

test("saved views: create, list, delete over /api/views, and ?view= expansion with explicit overrides", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-views-"));
  const app = await startServer({ port: 0, home });

  try {
    const handoff = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Handoff", content: "a", artifactType: "handoff" })
    })).json();
    await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Doc", content: "b", artifactType: "document" })
    })).json();

    const createResponse = await fetch(`${app.url}/api/views`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Handoffs", filters: { artifactType: "handoff" } })
    });
    assert.equal(createResponse.status, 201);
    const view = await createResponse.json();
    assert.equal(view.name, "Handoffs");
    assert.deepEqual(view.filters, { artifactType: "handoff" });

    const rejected = await fetch(`${app.url}/api/views`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad", filters: { notAllowed: "x" } })
    });
    assert.equal(rejected.status, 400);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.code, "invalid_filter");

    const listResponse = await fetch(`${app.url}/api/views`);
    const listed = await listResponse.json();
    assert.equal(listed.views.length, 1);
    assert.equal(listed.views[0].id, view.id);

    const expanded = await (await fetch(`${app.url}/api/artifacts?view=${encodeURIComponent(view.id)}`)).json();
    assert.equal(expanded.artifacts.length, 1);
    assert.equal(expanded.artifacts[0].id, handoff.id);

    // Explicit query param overrides the saved view's filter.
    const overridden = await (await fetch(`${app.url}/api/artifacts?view=${encodeURIComponent(view.id)}&artifactType=document`)).json();
    assert.equal(overridden.artifacts.length, 1);
    assert.equal(overridden.artifacts[0].artifactType, "document");

    // Resolvable by name too.
    const byName = await (await fetch(`${app.url}/api/artifacts?view=${encodeURIComponent("Handoffs")}`)).json();
    assert.equal(byName.artifacts.length, 1);

    const deleteResponse = await fetch(`${app.url}/api/views/${encodeURIComponent(view.id)}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    const afterDelete = await (await fetch(`${app.url}/api/views`)).json();
    assert.equal(afterDelete.views.length, 0);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("dashboard renders groupBy section headers and the saved-views sidebar", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-groupby-"));
  const app = await startServer({ port: 0, home });

  try {
    await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Handoff One", content: "a", artifactType: "handoff" })
    });
    await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Doc One", content: "b", artifactType: "document" })
    });

    await fetch(`${app.url}/views`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "My View" }).toString()
    });

    const groupedResponse = await fetch(`${app.url}/?groupBy=artifactType`);
    const groupedPage = await groupedResponse.text();
    assert.equal(groupedResponse.status, 200);
    assert.match(groupedPage, /artifact-group-heading">handoff</);
    assert.match(groupedPage, /artifact-group-heading">document</);

    const dashboardPage = await (await fetch(`${app.url}/`)).text();
    assert.match(dashboardPage, /My View/);
    assert.match(dashboardPage, /dashboard-sidebar/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("dashboard passes relatedTo/relation filters through to the artifact list, and the saved-view form and pager round-trip them", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-dashboard-related-"));
  const app = await startServer({ port: 0, home });

  try {
    const a = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Related Target", content: "a", sourceAgent: "test" })
    })).json();
    await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Related Source",
        content: "b",
        sourceAgent: "test",
        relations: [{ toId: a.id, relation: "derived-from" }]
      })
    });
    await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Unrelated", content: "c", sourceAgent: "test" })
    });

    const filteredPage = await (await fetch(`${app.url}/?relatedTo=${a.id}&relation=derived-from`)).text();
    assert.match(filteredPage, /Related Source/);
    assert.doesNotMatch(filteredPage, /Unrelated/);
    // The saved-view "save current filters" form must capture relatedTo and
    // relation as hidden fields so a saved view built from a relation-
    // filtered dashboard doesn't silently drop the filter.
    assert.match(filteredPage, new RegExp(`name="relatedTo" value="${a.id}"`));
    assert.match(filteredPage, /name="relation" value="derived-from"/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

function bundleWithDocuments() {
  return JSON.stringify({
    schemaVersion: 1,
    artifactType: "bundle",
    title: "Doc bundle",
    text: "a bundle with document assets",
    files: [
      {
        path: "report.pdf",
        contentType: "application/pdf",
        encoding: "base64",
        content: Buffer.from("%PDF-1.4 fake pdf bytes").toString("base64"),
        sizeBytes: 23
      },
      {
        path: "notes.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        encoding: "base64",
        content: Buffer.from("fake docx bytes").toString("base64"),
        sizeBytes: 16
      }
    ]
  });
}

test("serves bundle document files at /raw?file= with type-appropriate headers, and 404s unknown files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-bundle-raw-"));
  const app = await startServer({ port: 0, home });

  try {
    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Doc bundle",
        artifactType: "bundle",
        format: "json",
        sourceAgent: "test",
        content: bundleWithDocuments()
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    const pdfResponse = await fetch(`${app.url}/artifacts/${created.id}/raw?file=report.pdf`);
    assert.equal(pdfResponse.status, 200);
    assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
    assert.equal(pdfResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(pdfResponse.headers.get("cache-control"), "no-store");
    assert.equal(pdfResponse.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'self'");
    assert.match(pdfResponse.headers.get("content-disposition"), /^inline;/);
    const pdfBody = Buffer.from(await pdfResponse.arrayBuffer()).toString("utf8");
    assert.match(pdfBody, /%PDF-1.4/);

    const docxResponse = await fetch(`${app.url}/artifacts/${created.id}/raw?file=notes.docx`);
    assert.equal(docxResponse.status, 200);
    assert.equal(
      docxResponse.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    assert.match(docxResponse.headers.get("content-disposition"), /^attachment;/);

    const missingResponse = await fetch(`${app.url}/artifacts/${created.id}/raw?file=missing.pdf`);
    assert.equal(missingResponse.status, 404);

    const viewerHtml = await (await fetch(`${app.url}/artifacts/${created.id}`)).text();
    assert.match(viewerHtml, /class="bundle-files"/);
    const pdfFrameMatch = /<iframe class="artifact-frame bundle-file-frame" sandbox src="([^"]+)">/.exec(viewerHtml);
    assert.ok(pdfFrameMatch, "expected a sandboxed iframe for the PDF entry");
    // The viewed version must be part of the bundle file URL so an older
    // bundle version's files are fetched from that version's own content.
    assert.match(pdfFrameMatch[1], /raw\?version=1&amp;file=report\.pdf/);
    // No allow-same-origin, no scripts: the sandbox attribute must be empty/bare.
    assert.doesNotMatch(pdfFrameMatch[0], /allow-same-origin/);
    assert.doesNotMatch(pdfFrameMatch[0], /allow-scripts/);
    assert.match(viewerHtml, /bundle-file-link" href="[^"]*raw\?version=1&amp;file=notes\.docx"/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("denies bundle raw file access to non-owners of a private bundle", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-bundle-private-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });

  try {
    const owner = await createUser(store, {
      email: "bundle-owner@example.com",
      name: "Owner",
      role: "user",
      password: "password-123"
    });

    const created = await createArtifact(store, {
      title: "Private doc bundle",
      artifactType: "bundle",
      format: "json",
      sourceAgent: "test",
      content: bundleWithDocuments(),
      visibility: "private",
      ownerUserId: owner.id
    });

    const ownerLoginResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "bundle-owner@example.com", name: "Owner", password: "password-123" })
    });
    const ownerCookie = ownerLoginResponse.headers.get("set-cookie");

    const otherLoginResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "bundle-other@example.com", name: "Other", password: "password-123" })
    });
    const otherCookie = otherLoginResponse.headers.get("set-cookie");

    const ownerRawResponse = await fetch(`${app.url}/artifacts/${created.id}/raw?file=report.pdf`, {
      headers: { cookie: ownerCookie }
    });
    assert.equal(ownerRawResponse.status, 200);

    const otherRawResponse = await fetch(`${app.url}/artifacts/${created.id}/raw?file=report.pdf`, {
      headers: { cookie: otherCookie }
    });
    assert.equal(otherRawResponse.status, 404);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("renders Markdown embedded fenced code, mermaid cap, and task lists; keeps inline HTML escaped and /raw unchanged", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-markdown-embed-"));
  const app = await startServer({ port: 0, home });

  try {
    const markdownSource = [
      "# Report",
      "",
      "```js",
      "console.log('hi');",
      "```",
      "",
      "- [ ] Todo item",
      "- [x] Done item",
      "",
      "<script>alert('xss')</script>",
      "",
      "Inline `code`."
    ].join("\n");

    const created = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Embedded Markdown", content: markdownSource, format: "markdown", sourceAgent: "test" })
    })).json();

    const page = await (await fetch(created.url)).text();
    assert.match(page, /<pre><code class="language-js">console\.log/);
    assert.match(page, /task-list-item/);
    assert.match(page, /<input type="checkbox" disabled checked>/);
    assert.match(page, /<input type="checkbox" disabled> Todo item/);
    // Inline HTML stays escaped, never interpreted, even inside the rendered doc.
    assert.match(page, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
    assert.doesNotMatch(page, /<script>alert\('xss'\)<\/script>/);

    const raw = await (await fetch(created.rawUrl)).text();
    assert.equal(raw, markdownSource);

    // Mermaid fences render through the same sandboxed iframe mechanism,
    // lazily upgraded client-side, with a base64 srcdoc placeholder server-side.
    const mermaidDoc = [
      "# Diagram",
      "```mermaid",
      "flowchart TD\n  A --> B",
      "```"
    ].join("\n");
    const mermaidCreated = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Embedded Mermaid", content: mermaidDoc, format: "markdown", sourceAgent: "test" })
    })).json();
    const mermaidPage = await (await fetch(mermaidCreated.url)).text();
    assert.match(mermaidPage, /data-artifacty-mermaid/);
    assert.match(mermaidPage, /data-mermaid-srcdoc="[A-Za-z0-9+/=]+"/);
    assert.match(mermaidPage, /<noscript><pre><code class="language-mermaid">flowchart TD/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("caps inline Mermaid diagrams per document via ARTIFACTY_MAX_INLINE_DIAGRAMS", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mermaid-cap-"));
  const previousCap = process.env.ARTIFACTY_MAX_INLINE_DIAGRAMS;
  process.env.ARTIFACTY_MAX_INLINE_DIAGRAMS = "1";
  const app = await startServer({ port: 0, home });

  try {
    const twoDiagrams = [
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "  C --> D",
      "```"
    ].join("\n");
    const created = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Two Diagrams", content: twoDiagrams, format: "markdown", sourceAgent: "test" })
    })).json();
    const page = await (await fetch(created.url)).text();

    const embedCount = (page.match(/data-artifacty-mermaid/g) || []).length;
    assert.equal(embedCount, 1);
    assert.match(page, /artifact-mermaid-capped/);
    assert.match(page, /Inline diagram limit reached \(1\)/);
    assert.match(page, /<pre><code class="language-mermaid">flowchart TD\n {2}C --&gt; D<\/code><\/pre>/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
    if (previousCap === undefined) {
      delete process.env.ARTIFACTY_MAX_INLINE_DIAGRAMS;
    } else {
      process.env.ARTIFACTY_MAX_INLINE_DIAGRAMS = previousCap;
    }
  }
});

test("renders Jupyter notebook cells in order with an output MIME allowlist, oversized truncation, and /raw fidelity", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-notebook-"));
  const app = await startServer({ port: 0, home });

  try {
    const oversizedText = "x".repeat(2 * 1024 * 1024 + 1);
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "<script>alert('xss')</script>\n"] },
        {
          cell_type: "code",
          execution_count: 3,
          source: ["print('hi')"],
          outputs: [
            { output_type: "stream", name: "stdout", text: ["hi\n"] },
            { output_type: "execute_result", data: { "text/plain": ["'hi'"] } },
            { output_type: "display_data", data: { "application/vnd.custom+json": { a: 1 } } },
            { output_type: "display_data", data: { "text/plain": [oversizedText] } },
            { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["Traceback...", "ValueError: bad"] }
          ]
        },
        { cell_type: "raw", source: ["raw content"] }
      ]
    };
    const notebookContent = JSON.stringify(notebook);

    const created = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Analysis Notebook", content: notebookContent, format: "notebook", sourceAgent: "test" })
    })).json();
    assert.equal(created.version.format, "notebook");

    const page = await (await fetch(created.url)).text();

    // Cell order: markdown cell's heading appears before the code cell's
    // execution count, which appears before the raw cell's escaped content.
    const titleIndex = page.indexOf("Title");
    const execIndex = page.indexOf("[3]");
    const rawIndex = page.indexOf("raw content");
    assert.ok(titleIndex > -1 && execIndex > titleIndex, "markdown cell should render before the code cell");
    assert.ok(rawIndex > execIndex, "raw cell should render after the code cell");

    // Markdown cell content goes through the same embedded/escaped pipeline.
    assert.match(page, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);

    // Code cell: escaped highlighted source with a language class.
    assert.match(page, /<pre><code class="language-python">print\(&#39;hi&#39;\)<\/code><\/pre>/);

    // stream and execute_result (text/plain) outputs render as escaped text.
    assert.match(page, /class="artifact-notebook-output artifact-code"><code>hi/);
    assert.match(page, /&#39;hi&#39;/);

    // A MIME type outside the allowlist shows a placeholder naming the type.
    assert.match(page, /Unsupported output type: application\/vnd\.custom\+json/);

    // An oversized output (>2MB) is replaced with a truncated notice, not the raw text.
    assert.match(page, /Output truncated/);
    assert.equal(page.includes(oversizedText), false);

    // error output renders as escaped text (traceback).
    assert.match(page, /ValueError: bad/);

    const raw = await (await fetch(created.rawUrl)).text();
    assert.equal(raw, notebookContent);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("bounds notebook rendering to the first 500 cells and fails closed to formatted JSON on parse error", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-notebook-bounds-"));
  const app = await startServer({ port: 0, home });

  try {
    const manyCells = Array.from({ length: 520 }, (_, index) => ({
      cell_type: "markdown",
      source: [`Cell ${index}`]
    }));
    const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: manyCells };
    const created = await (await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Big Notebook", content: JSON.stringify(notebook), format: "notebook", sourceAgent: "test" })
    })).json();
    const page = await (await fetch(created.url)).text();
    assert.match(page, /Showing the first 500 of 520 cells/);
    assert.match(page, /Cell 499/);
    assert.doesNotMatch(page, /Cell 500\b/);

    const malformed = await createArtifact(createStore({ home }), {
      title: "Malformed Notebook",
      content: "{not valid json",
      format: "notebook",
      sourceAgent: "test"
    });
    const malformedPage = await (await fetch(`${app.url}/artifacts/${malformed.id}`)).text();
    assert.match(malformedPage, /<pre class="artifact-code"><code>\{not valid json<\/code><\/pre>/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

function rawRequest(baseUrl, method, pathname, headers) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function rawRequestWithBody(baseUrl, method, pathname, headers, body) {
  const url = new URL(pathname, baseUrl);
  const payload = Buffer.from(body || "");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          "content-length": String(payload.byteLength)
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}
