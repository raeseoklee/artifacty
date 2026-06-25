import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { startServer } from "../src/server.js";
import { readServerState } from "../src/lib/server-state.js";

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
                { id: "js/path-injection", shortDescription: { text: "Path injection" } }
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
    assert.match(await viewerAssetResponse.text(), /data-artifacty-code-viewer/);

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
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

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
