import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCollection, resolveCollection, collectionContentForReader } from "../src/lib/collections.js";
import { startServer } from "../src/server.js";
import { createArtifact, updateArtifact, createUser, createApiToken, createSession } from "../src/lib/storage.js";
import { createShareLink } from "../src/lib/share-links.js";
import { setNetworkPolicy } from "../src/lib/network-policy.js";

const payload = (items) => ({ description: "# Project overview", sections: [{ id: "overview", title: "Overview", items }] });
const ref = (artifact, version = "latest", display = "inline") => ({ artifactId: artifact.id, version, display });

test("collection validation rejects invalid limits, paths and versions", () => {
  assert.deepEqual(parseCollection(payload([{ artifactId: "sample" }])), payload([{ artifactId: "sample", version: "latest", display: "card" }]));
  for (const value of ["not json", null, { sections: {} }, payload([{ artifactId: "../private" }]), payload([{ artifactId: "x", version: 0 }]), payload([{ artifactId: "x", display: "iframe" }]), payload(Array.from({ length: 201 }, () => ({ artifactId: "x" }))), { sections: [{ id: "same", title: "a", items: [] }, { id: "same", title: "b", items: [] }] }]) assert.throws(() => parseCollection(value), { code: "INVALID_COLLECTION" });
});

test("resolver hides missing or forbidden references without swallowing infrastructure failures", async () => {
  const content = payload([{ artifactId: "hidden" }, { artifactId: "missing" }, { artifactId: "visible", version: 2 }]);
  const resolved = await resolveCollection(content, { readArtifact: async (id, version) => {
    if (id === "hidden") throw Object.assign(new Error("secret"), { statusCode: 403 });
    if (id === "missing") throw Object.assign(new Error("missing"), { statusCode: 404 });
    assert.equal(version, 2); return { id, title: "visible" };
  } });
  assert.equal(resolved.unavailableCount, 2);
  assert.doesNotMatch(collectionContentForReader(resolved), /hidden|missing|secret/);
  await assert.rejects(resolveCollection(content, { readArtifact: () => { throw new Error("database failed"); } }), /database failed/);
});

test("collection pages follow latest, pin versions and protect children across HTML/raw/share/diff", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-collections-"));
  const app = await startServer({ home, port: 0 });
  try {
    const admin = await createUser(app.store, { email: "collection-admin@example.test", password: "password-123", role: "admin" });
    const reader = await createUser(app.store, { email: "reader@example.test", password: "password-123", role: "user" });
    const token = await createApiToken(app.store, reader.id, { name: "Read", scopes: ["read", "write"] });
    const child = await createArtifact(app.store, { title: "Public chapter", content: "original chapter", format: "markdown", visibility: "public" });
    const privateChild = await createArtifact(app.store, { title: "Secret title", content: "secret body", format: "text", visibility: "private", ownerUserId: "someone-else" });
    const collection = await createArtifact(app.store, { title: "Project manual", content: JSON.stringify(payload([ref(child, 1), ref(child), ref(privateChild)])), format: "collection", visibility: "public", ownerUserId: reader.id });
    await updateArtifact(app.store, child.id, { content: "updated chapter", format: "markdown" });
    const html = await (await fetch(`${app.url}/artifacts/${collection.id}`)).text();
    assert.match(html, /original chapter/); assert.match(html, /updated chapter/); assert.match(html, /Contents/);
    assert.doesNotMatch(html, new RegExp(`${privateChild.id}|Secret title|secret body`));
    for (const route of [`/api/artifacts/${collection.id}`, `/artifacts/${collection.id}/raw`, `/artifacts/${collection.id}/diff`, `/api/artifacts/${collection.id}/diff`]) {
      const response = await fetch(app.url + route, { headers: { authorization: `Bearer ${token.token}` } }); assert.equal(response.status, 200, route);
      assert.doesNotMatch(await response.text(), new RegExp(`${privateChild.id}|Secret title|secret body`), route);
    }
    const adminSession = await createSession(app.store, admin.id);
    const mixedPrincipal = await fetch(`${app.url}/api/artifacts/${collection.id}`, { headers: { authorization: `Bearer ${token.token}`, cookie: `artifacty_session=${adminSession.token}` } });
    assert.equal(mixedPrincipal.status, 200);
    assert.doesNotMatch(await mixedPrincipal.text(), new RegExp(privateChild.id));
    const imported = await fetch(`${app.url}/api/import`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, cookie: `artifacty_session=${adminSession.token}`, "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", title: "Attributed import", content: "imported example", provenance: { tool: "codex", provider: "OpenAI", model: "example-model", userId: admin.id } }) });
    assert.equal(imported.status, 201);
    const importedArtifact = await imported.json();
    assert.equal(importedArtifact.provenance.model, "example-model");
    assert.equal(importedArtifact.provenance.userId, reader.id);
    const replacement = { title: "Project manual", content: JSON.stringify(payload([ref(child)])), format: "collection" };
    const blocked = await fetch(`${app.url}/api/artifacts/${collection.id}`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify(replacement) });
    assert.equal(blocked.status, 409);
    const formBlocked = await fetch(`${app.url}/artifacts/${collection.id}/edit`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(replacement), redirect: "manual" });
    assert.equal(formBlocked.status, 409);
    for (const action of ["archive", "restore"]) {
      const changed = await fetch(`${app.url}/api/artifacts/${collection.id}/${action}`, { method: "POST", headers: { authorization: `Bearer ${token.token}` } });
      assert.equal(changed.status, 200);
      assert.doesNotMatch(await changed.text(), new RegExp(`${privateChild.id}|Secret title|secret body`));
    }
    const access = { userId: admin.id, role: "admin" };
    const sharingPreview = await fetch(`${app.url}/artifacts/${collection.id}/sharing?previewUser=${reader.id}`, { headers: { cookie: `artifacty_session=${adminSession.token}` } });
    assert.equal(sharingPreview.status, 200);
    const previewHtml = await sharingPreview.text();
    assert.match(previewHtml, /Accessible references: 2 of 3/);
    assert.doesNotMatch(previewHtml, new RegExp(`${privateChild.id}|Secret title|secret body`));
    const link = createShareLink(app.store, collection.id, {}, { access });
    const shared = await (await fetch(`${app.url}/s/${link.token}`)).text();
    assert.match(shared, /Public chapter/); assert.doesNotMatch(shared, new RegExp(`${privateChild.id}|Secret title|secret body`));
    const rawShared = await (await fetch(`${app.url}/s/${link.token}/raw`)).text();
    assert.doesNotMatch(rawShared, new RegExp(privateChild.id));
    const recoveryPage = await fetch(`${app.url}/artifacts/${collection.id}/edit`, { headers: { cookie: `artifacty_session=${(await createSession(app.store, reader.id)).token}` } });
    assert.equal(recoveryPage.status, 200);
    assert.match(await recoveryPage.text(), /name="dropUnavailableReferences" value="true" required/);
    const wrongOptIn = await fetch(`${app.url}/api/artifacts/${collection.id}`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...replacement, dropUnavailableReferences: "false" }) });
    assert.equal(wrongOptIn.status, 409);
    const recovered = await fetch(`${app.url}/api/artifacts/${collection.id}`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...replacement, dropUnavailableReferences: true }) });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).latestVersion, 2);
    setNetworkPolicy(app.store, { allowedCidrs: ["192.0.2.0/24"], allowSharedLinks: true }, { access });
    const exception = await (await fetch(`${app.url}/s/${link.token}`)).text();
    assert.doesNotMatch(exception, /Public chapter|original chapter|updated chapter/);
    const exceptionRaw = await (await fetch(`${app.url}/s/${link.token}/raw`)).text();
    assert.doesNotMatch(exceptionRaw, new RegExp(`${child.id}|${privateChild.id}`));
  } finally { await app.close(); await rm(home, { recursive: true, force: true }); }
});

test("collection builder and viewer escape titles and preserve nested collections as cards", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-collection-builder-"));
  const app = await startServer({ home, port: 0 });
  try {
    const nested = await createArtifact(app.store, { title: '<script>alert("x")</script>', content: JSON.stringify(payload([])), format: "collection", visibility: "public" });
    const collection = await createArtifact(app.store, { title: "Nested", content: JSON.stringify(payload([ref(nested)])), format: "collection", visibility: "public" });
    const html = await (await fetch(`${app.url}/artifacts/${collection.id}`)).text();
    assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>alert/);
    assert.equal((html.match(/class="collection-page"/g) || []).length, 1);
    const builder = await (await fetch(`${app.url}/artifacts/${collection.id}/edit`)).text();
    assert.match(builder, /data-collection-editor/); assert.match(builder, /data-add-section/); assert.doesNotMatch(builder, /<script>alert/);
    assert.equal((await fetch(`${app.url}/collections/new`)).status, 200);
    const malformed = await fetch(`${app.url}/api/artifacts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Invalid", format: "collection", content: "{}" }) });
    assert.equal(malformed.status, 400);
  } finally { await app.close(); await rm(home, { recursive: true, force: true }); }
});
