import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createArtifact, createUser, setAccessMode, openDatabase } from "../src/lib/storage.js";
import { setNetworkPolicy } from "../src/lib/network-policy.js";
import { createShareLink, revokeShareLink, setShareLinkPolicy } from "../src/lib/share-links.js";

test("IP exception admits only valid read-only capabilities and preserves private share policy", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-share-network-"));
  const app = await startServer({ home, port: 0 });
  try {
    const admin = await createUser(app.store, { email: "admin@example.test", password: "password-123", role: "admin" });
    const access = { userId: admin.id, role: "admin" };
    const artifact = await createArtifact(app.store, { title: "Capability", content: "Scoped content", format: "text", ownerUserId: admin.id });
    const link = createShareLink(app.store, artifact.id, {}, { access });
    const route = `/s/${link.token}`;
    const request = (url, method = "GET") => fetch(app.url + url, { method, redirect: "manual" });
    setNetworkPolicy(app.store, { allowedCidrs: ["192.0.2.0/24"] }, { access });
    assert.equal((await request(route)).status, 403);
    setNetworkPolicy(app.store, { allowedCidrs: ["192.0.2.0/24"], allowSharedLinks: true }, { access });
    assert.equal((await request(route)).status, 200);
    assert.equal(await (await request(route + "/raw")).text(), "Scoped content");
    assert.equal((await request(route, "HEAD")).status, 200);
    for (const url of ["/", "/api/artifacts", "/mcp", "/assets/theme.js", route + "/edit", route + "/raw/", `/artifacts/${artifact.id}/raw`]) assert.equal((await request(url)).status, 403, url);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) assert.equal((await request(route, method)).status, 403, method);
    assert.equal((await request(`/s/${"A".repeat(43)}`)).status, 404);
    assert.equal((await request("/s/short")).status, 403);
    await setAccessMode(app.store, "private", { access });
    assert.equal((await request(route)).status, 404);
    setShareLinkPolicy(app.store, { enabledInPrivate: true }, { access });
    assert.equal((await request(route)).status, 200);
    const expired = createShareLink(app.store, artifact.id, {}, { access });
    const db = openDatabase(app.store);
    try { db.prepare("UPDATE artifact_share_links SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", expired.id); }
    finally { db.close(); }
    assert.equal((await request(`/s/${expired.token}/raw`)).status, 404);
    revokeShareLink(app.store, artifact.id, link.id, { access });
    assert.equal((await request(route)).status, 404);
  } finally { await app.close(); await rm(home, { recursive: true, force: true }); }
});
