import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createShareLink } from "../src/lib/share-links.js";
import { createSourceExplainer } from "../src/lib/explainer-service.js";
import { startServer } from "../src/server.js";
import { awaitEmbeddingIndexing, createArtifact, updateArtifact, getArtifact, createUser, createApiToken, createSession, listRelations, listArtifacts } from "../src/lib/storage.js";
import { createMcpRequestHandler } from "../src/mcp-server.js";

const document = { schemaVersion: 1, goal: "Understand queues", summary: "Follow the work", limitations: [], blocks: [{ id: "flow", title: "Flow", type: "steps", items: [{ id: "queue", label: "Queue", explanation: "Jobs wait before a worker takes them.", basis: "source", citation: "Source section Queue" }] }] };

test("browser explanation pins source, creates private copy and enforces credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-explainer-http-"));
  const app = await startServer({ home, port: 0 });
  try {
    const admin = await createUser(app.store, { email: "admin@example.test", password: "password-123", role: "admin" });
    const user = await createUser(app.store, { email: "reader@example.test", password: "password-123", role: "user" });
    const source = await createArtifact(app.store, { title: "Queue guide", content: "# Queue\n\nJobs wait before a worker takes them.", format: "markdown", visibility: "public" });
    const secret = await createArtifact(app.store, { title: "Restricted guide", content: "private", format: "text", visibility: "private", ownerUserId: admin.id });
    const userSession = await createSession(app.store, user.id);
    const cookie = `artifacty_session=${userSession.token}`;
    const readToken = await createApiToken(app.store, user.id, { name: "Read only", scopes: ["read"] });
    const draft = await fetch(`${app.url}/artifacts/${source.id}/explain?version=1`, { headers: { cookie } });
    assert.equal(draft.status, 200); assert.match(await draft.text(), /sourceVersion/);
    assert.equal((await fetch(`${app.url}/artifacts/${secret.id}/explain`, { headers: { cookie } })).status, 404);
    await updateArtifact(app.store, source.id, { content: "Second version", format: "markdown" });
    const form = new URLSearchParams({ title: "Queue explained", content: JSON.stringify(document), sourceVersion: "1" });
    const send = (headers, body = form) => fetch(`${app.url}/artifacts/${source.id}/explain`, { method: "POST", headers, body, redirect: "manual" });
    assert.equal((await send({ cookie, authorization: `Bearer ${readToken.token}` })).status, 403, "bearer scope cannot be bypassed by cookie");
    assert.equal((await send({ cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await send({ cookie }, new URLSearchParams({ content: "{}", sourceVersion: "1" }))).status, 400);
    const response = await send({ cookie });
    assert.equal(response.status, 303);
    const id = response.headers.get("location").split("/").at(-1).split("?")[0];
    const explained = await getArtifact(app.store, id, { access: { userId: user.id, role: "user" } });
    assert.equal(explained.visibility, "private"); assert.equal(explained.ownerUserId, user.id);
    assert.equal(explained.version.metadata.explainerSourceVersion, 1); assert.equal(explained.version.metadata.explainerSourceSha256, source.version.sha256);
    assert.equal((await getArtifact(app.store, source.id)).latestVersion, 2);
    assert.equal((await fetch(`${app.url}/artifacts/${id}`)).status, 404);
    const relations = await listRelations(app.store, id, { access: { userId: user.id, role: "user" } });
    assert.equal(relations.outgoing[0].artifactId, source.id);
    assert.equal(relations.outgoing[0].sourceVersion, 1);
    const viewer = await (await fetch(`${app.url}/artifacts/${id}`, { headers: { cookie } })).text();
    assert.match(viewer, new RegExp(`/artifacts/${source.id}\\?version=1`));
    assert.equal((await fetch(`${app.url}/assets/explainers.js`)).status, 200);
    const deniedEdit = await fetch(`${app.url}/artifacts/${id}/edit`, { method: "POST", headers: { cookie, authorization: `Bearer ${readToken.token}` }, body: new URLSearchParams({ title: "Denied", format: "explainer", content: JSON.stringify(document), expectedVersion: "1" }), redirect: "manual" });
    assert.equal(deniedEdit.status, 403);
    const edit = await fetch(`${app.url}/artifacts/${id}/edit`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ title: "Queue explained", format: "explainer", content: JSON.stringify({ ...document, summary: "Edited explanation" }), expectedVersion: "1" }), redirect: "manual" });
    assert.equal(edit.status, 303);
    const edited = await getArtifact(app.store, id);
    assert.equal(edited.latestVersion, 2); assert.equal(edited.version.metadata.explainerSourceVersion, 1);
    const stale = await fetch(`${app.url}/artifacts/${id}/edit`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ title: "Queue explained", format: "explainer", content: JSON.stringify(document), expectedVersion: "1" }), redirect: "manual" });
    assert.equal(stale.status, 409); assert.match(await stale.text(), /data-explainer-editor/);

  } finally { await awaitEmbeddingIndexing(app.store); await app.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("MCP explanation requires source access and write scope, describes authored interactions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-explainer-mcp-"));
  const app = await startServer({ home, port: 0 });
  try {
    const admin = await createUser(app.store, { email: "admin@example.test", password: "password-123", role: "admin" });
    const user = await createUser(app.store, { email: "reader@example.test", password: "password-123", role: "user" });
    const source = await createArtifact(app.store, { title: "Public source", content: "Queue", format: "text", visibility: "public" });
    const secret = await createArtifact(app.store, { title: "Private source", content: "secret", visibility: "private", ownerUserId: admin.id });
    const handler = (scopes, withUser = true) => createMcpRequestHandler({ store: app.store, publicBaseUrl: app.url, auth: { type: "api-token", scopes, ...(withUser ? { user } : {}) } });
    const writer = handler(["read", "write"]);
    const call = (h, args) => h({ method: "tools/call", params: { name: "artifacty_explain", arguments: args } });
    const args = { sourceId: source.id, sourceVersion: 1, explainer: document };
    assert.equal((await call(handler(["read"]), args)).isError, true);
    assert.equal((await call(handler(["read", "write"], false), args)).isError, true);
    assert.equal((await call(writer, { ...args, sourceId: secret.id })).isError, true);
    assert.equal((await call(writer, { ...args, sourceVersion: 0 })).isError, true);
    assert.equal((await call(writer, { ...args, sourceVersion: 99 })).isError, true);
    assert.equal((await call(writer, { ...args, explainer: {} })).isError, true);
    const result = await call(writer, args);
    assert.equal(result.isError, false); assert.equal(result.structuredContent.visibility, "private");
    assert.equal(result.structuredContent.version.metadata.explainerSourceVersion, 1);
    assert.equal((await listArtifacts(app.store)).length, 3, "failed calls do not create artifacts");
    const prompt = await writer({ method: "prompts/get", params: { name: "artifacty_explanation", arguments: { artifactId: source.id } } });
    assert.match(prompt.messages[0].content.text, /untrusted source material/);
    assert.match(prompt.messages[0].content.text, /do not invent measurements/);
  } finally { await awaitEmbeddingIndexing(app.store); await app.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});


test("shared and collected explainers remain interactive without exposing a private source", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-explainer-share-"));
  const app = await startServer({ home, port: 0 });
  try {
    const admin = await createUser(app.store, { email: "owner@example.test", password: "password-123", role: "admin" });
    const access = { userId: admin.id, role: "admin" };
    const source = await createArtifact(app.store, { title: "Confidential source title", content: "Private original", visibility: "private", access });
    const explanation = await createSourceExplainer(app.store, { sourceId: source.id, explainer: document, title: "Public teaching example" }, { access });
    const link = createShareLink(app.store, explanation.id, {}, { access });
    const shared = await fetch(`${app.url}/s/${link.token}`);
    assert.equal(shared.status, 200);
    const html = await shared.text();
    assert.match(html, /data-explainer/); assert.match(html, /assets\/explainers.js/);
    assert.match(html, /Jobs wait before a worker takes them/);
    assert.doesNotMatch(html, new RegExp(`${source.id}|Confidential source title|Private original`));
    const collection = await createArtifact(app.store, { title: "Lesson", format: "collection", content: JSON.stringify({ sections: [{ id: "lesson", title: "Lesson", items: [{ artifactId: explanation.id, display: "inline" }] }] }), access });
    const cookie = `artifacty_session=${(await createSession(app.store, admin.id)).token}`;
    const inline = await (await fetch(`${app.url}/artifacts/${collection.id}`, { headers: { cookie } })).text();
    assert.match(inline, /data-explainer/); assert.match(inline, /Jobs wait before a worker takes them/);
    const editor = await (await fetch(`${app.url}/artifacts/${explanation.id}/edit`, { headers: { cookie } })).text();
    assert.match(editor, /data-explainer-editor/); assert.match(editor, /name="expectedVersion"/);
  } finally { await awaitEmbeddingIndexing(app.store); await app.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("Mermaid source drafts preserve branches and fall back for unsupported syntax", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-flow-http-"));
  const app = await startServer({home,port:0});
  try {
    const source = await createArtifact(app.store,{title:'Flow',format:'mermaid',content:'flowchart LR\nA[Request] --> B{Valid?}\nB -->|Yes| C[Token]\nB -->|No| D[Reject]'});
    const response=await fetch(`${app.url}/artifacts/${source.id}/explain`);
    assert.equal(response.status,200);const html=await response.text();assert.match(html,/&quot;start&quot;/);assert.match(html,/&quot;label&quot;: &quot;Yes&quot;/);
    const complex=await createArtifact(app.store,{title:'Complex',format:'mermaid',content:'sequenceDiagram\nA->>B: Hello'});
    const fallback=await fetch(`${app.url}/artifacts/${complex.id}/explain`);assert.equal(fallback.status,200);assert.match(await fallback.text(),/Manual draft/);
  } finally {await app.close();await rm(home,{recursive:true,force:true});}
});
