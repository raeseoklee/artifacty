import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createApiToken, createArtifact, createSession, createUser, listTeams, setAccessMode, updateArtifact } from "../src/lib/storage.js";

test("administrators switch access modes and owners grant users and teams access across browser surfaces", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-access-"));
  const app = await startServer({ home, port: 0 });
  try {
    const accounts = {};
    for (const name of ["admin", "owner", "reader", "teammate", "outsider"]) {
      const user = await createUser(app.store, { email: `${name}@example.com`, name, role: name === "admin" ? "admin" : "user", password: "password-123" });
      const session = await createSession(app.store, user.id);
      accounts[name] = { user, cookie: `artifacty_session=${session.token}` };
    }
    const artifact = await createArtifact(app.store, { title: "Shared manual", format: "text", content: "First", ownerUserId: accounts.owner.user.id, visibility: "public" });
    await updateArtifact(app.store, artifact.id, { content: "Second" });
    const get = (route, account) => fetch(`${app.url}${route}`, { redirect: "manual", headers: account ? { cookie: accounts[account].cookie } : {} });
    const post = (route, account, body) => fetch(`${app.url}${route}`, { method: "POST", redirect: "manual", headers: { cookie: accounts[account].cookie, origin: app.url, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    assert.equal((await get("/")).status, 200);
    assert.equal((await get(`/artifacts/${artifact.id}/raw`)).status, 200);
    assert.equal((await get("/admin/access", "owner")).status, 403);
    assert.equal((await post("/admin/access", "owner", { mode: "private" })).status, 403);
    assert.equal((await post("/admin/access", "admin", { mode: "private" })).status, 303);
    for (const route of ["/", "/new", "/import", `/artifacts/${artifact.id}`, `/artifacts/${artifact.id}/raw`, `/artifacts/${artifact.id}/diff?from=1&to=2`]) {
      const response = await get(route);
      assert.equal(response.status, 303, route);
      assert.match(response.headers.get("location"), /login/);
    }
    assert.equal((await post("/admin/teams", "owner", { name: "Denied" })).status, 403);
    assert.equal((await post("/admin/teams", "admin", { name: "Documentation" })).status, 303);
    const [team] = await listTeams(app.store);
    assert.equal((await post(`/admin/teams/${team.id}/members`, "admin", [["userIds", accounts.teammate.user.id], ["userIds", accounts.reader.user.id]])).status, 303);
    assert.equal((await get("/admin/access", "admin")).status, 200);
    assert.equal((await get(`/artifacts/${artifact.id}/sharing`, "owner")).status, 200);
    assert.equal((await post(`/artifacts/${artifact.id}/sharing`, "owner", [["userIds", accounts.reader.user.id], ["teamIds", team.id]])).status, 303);
    assert.equal((await get(`/artifacts/${artifact.id}/sharing`, "reader")).status, 403);
    for (const route of [`/artifacts/${artifact.id}`, `/artifacts/${artifact.id}/raw`, `/artifacts/${artifact.id}/diff?from=1&to=2`]) {
      for (const account of ["owner", "reader", "teammate", "admin"]) assert.equal((await get(route, account)).status, 200, `${account}: ${route}`);
      assert.equal((await get(route, "outsider")).status, 404, route);
    }
    assert.equal((await post(`/artifacts/${artifact.id}/sharing`, "owner", {})).status, 303);
    assert.equal((await get(`/artifacts/${artifact.id}/raw`, "reader")).status, 404);
    assert.equal((await post("/admin/access", "admin", { mode: "public" })).status, 303);
    assert.equal((await get(`/artifacts/${artifact.id}/raw`)).status, 200);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("network policy administration validates ranges and gates every route using the socket peer", async () => {
  const { setNetworkPolicy, getPendingNetworkPolicy, confirmNetworkPolicy } = await import("../src/lib/network-policy.js");
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-network-http-"));
  const app = await startServer({ home, port: 0 });
  try {
    const admin = await createUser(app.store, { email: "admin@example.com", name: "Admin", role: "admin", password: "password-123" });
    const session = await createSession(app.store, admin.id);
    const post = (allowedCidrs, allowSharedLinks) => fetch(`${app.url}/admin/access/network`, { method: "POST", redirect: "manual", headers: { cookie: `artifacty_session=${session.token}`, origin: app.url, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ allowedCidrs, ...(allowSharedLinks ? { allowSharedLinks: "true" } : {}) }) });
    assert.equal((await post("invalid/999")).status, 400);
    assert.equal((await post("192.0.2.0/24")).status, 400);
    assert.equal((await post("127.0.0.0/8", true)).status, 303);
    assert.equal(getPendingNetworkPolicy(app.store).allowSharedLinks, true);
    assert.equal((await fetch(`${app.url}/health`, { headers: { "x-forwarded-for": "192.0.2.5" } })).status, 200);
    confirmNetworkPolicy(app.store, getPendingNetworkPolicy(app.store).id, { access: { userId: admin.id, role: "admin" }, remoteAddress: "127.0.0.1" });
    setNetworkPolicy(app.store, { allowedCidrs: ["192.0.2.0/24"] }, { access: { userId: admin.id, role: "admin" } });
    for (const route of ["/", "/login", "/health", "/openapi.json", "/api/artifacts", "/mcp", "/artifacts/example/raw"]) {
      const response = await fetch(`${app.url}${route}`, { redirect: "manual", headers: { "x-forwarded-for": "192.0.2.5" } });
      assert.equal(response.status, 403, route);
      assert.equal((await response.json()).code, "IP_NOT_ALLOWED");
    }
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("private API creation and import require personal identity even with a shared token", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-private-create-"));
  const app = await startServer({ home, port: 0, apiToken: "shared-secret" });
  try {
    const admin = await createUser(app.store, { email: "admin@example.com", name: "Admin", role: "admin", password: "password-123" });
    const token = await createApiToken(app.store, admin.id, { name: "Personal", scopes: ["read", "write"] });
    await setAccessMode(app.store, "private", { access: { userId: admin.id, role: "admin" } });
    for (const route of ["/api/artifacts", "/api/import"]) {
      const request = (secret) => fetch(`${app.url}${route}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Private creation", content: "Manual", format: "text", agent: "generic" }) });
      assert.equal((await request("shared-secret")).status, 403, route);
      const response = await request(token.token);
      assert.equal(response.status, 201, route);
      assert.equal((await response.json()).ownerUserId, admin.id);
    }
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
