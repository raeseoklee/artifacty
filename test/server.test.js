import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

    const rawResponse = await fetch(created.rawUrl);
    assert.equal(await rawResponse.text(), "<h1>Hello</h1>");

    const newPageResponse = await fetch(`${app.url}/new`);
    const newPage = await newPageResponse.text();
    assert.equal(newPageResponse.status, 200);
    assert.match(newPage, /<html lang="en">/);
    assert.match(newPage, /New Artifact/);
    assert.match(newPage, /type="importmap"/);
    assert.match(newPage, /data-artifacty-editor/);
    assert.match(newPage, /\/assets\/editor\.js/);
    assert.match(newPage, /window\.ARTIFACTY_I18N/);

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
    assert.match(await editorAssetResponse.text(), /EditorView/);

    const codeMirrorVendorResponse = await fetch(`${app.url}/vendor/npm/codemirror`);
    assert.equal(codeMirrorVendorResponse.status, 200);
    assert.match(await codeMirrorVendorResponse.text(), /basicSetup/);

    const styleModVendorResponse = await fetch(`${app.url}/vendor/npm/style-mod`);
    assert.equal(styleModVendorResponse.status, 200);
    assert.match(await styleModVendorResponse.text(), /StyleModule/);

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
