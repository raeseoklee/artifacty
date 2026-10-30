import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact, createUser, createSession, createTeam, setTeamMembers, createApiToken } from "../src/lib/storage.js";

test("category HTTP and browser flows isolate personal lists, share by team and preserve artifact permissions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-category-http-"));
  const app = await startServer({ home, port: 0 });
  try {
    const accounts = {};
    for (const name of ["admin", "owner", "member", "outsider"]) {
      const user = await createUser(app.store, { name, email: `${name}@example.test`, password: "test-password-123", role: name === "admin" ? "admin" : "user" });
      accounts[name] = { token: (await createApiToken(app.store, user.id, { name: "Test", scopes: ["read", "write"] })).token, user, cookie: `artifacty_session=${(await createSession(app.store, user.id)).token}` };
    }
    const access = (name) => ({ userId: accounts[name].user.id, role: accounts[name].user.role });
    const team = await createTeam(app.store, { name: "Documentation" }, { access: access("admin") });
    await setTeamMembers(app.store, team.id, [accounts.owner.user.id, accounts.member.user.id], { access: access("admin") });
    const request = (route, name = "owner", method = "GET", body, origin = app.url) => fetch(`${app.url}${route}`, { method, redirect: "manual", headers: { ...(name ? { cookie: accounts[name].cookie, ...(route.startsWith("/api/artifacts") ? { authorization: `Bearer ${accounts[name].token}` } : {}) } : {}), ...(method === "GET" ? {} : { origin, "content-type": "application/json" }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const artifact = await createArtifact(app.store, { title: "Shared notes", content: "Notes", format: "markdown", visibility: "public", access: access("owner") });
    const privateArtifact = await createArtifact(app.store, { title: "Private notes", content: "Secret", format: "markdown", visibility: "private", access: access("owner") });
    assert.equal((await request("/categories", null)).status, 303);
    assert.equal((await request("/api/categories", null)).status, 401);
    const personalResponse = await request("/api/categories", "owner", "POST", { name: "Reading", scope: "personal", ownerUserId: accounts.outsider.user.id });
    assert.equal(personalResponse.status, 201);
    const personal = await personalResponse.json();
    const sharedResponse = await request("/api/categories", "owner", "POST", { name: "Team reading", scope: "team", teamId: team.id });
    assert.equal(sharedResponse.status, 201);
    const shared = await sharedResponse.json();
    for (const id of [artifact.id, privateArtifact.id]) assert.equal((await request(`/api/categories/${shared.id}/artifacts/${id}`, "owner", "PUT")).status, 200);
    assert.equal((await request(`/api/categories/${personal.id}/artifacts/${artifact.id}`, "owner", "PUT")).status, 200);
    const memberCategories = (await (await request("/api/categories", "member")).json()).categories;
    assert.deepEqual(memberCategories.map((category) => category.id), [shared.id]);
    assert.equal(memberCategories[0].artifactCount, 1);
    assert.deepEqual((await (await request("/api/categories", "outsider")).json()).categories, []);
    assert.equal((await request(`/api/categories/${personal.id}`, "admin", "PATCH", { name: "Stolen" })).status, 404);
    assert.equal((await request(`/api/categories/${shared.id}/artifacts/${privateArtifact.id}`, "member", "PUT")).status, 404);
    const filtered = await (await request(`/api/artifacts?categoryId=${shared.id}&limit=1`, "member")).json();
    assert.equal(filtered.pagination.total, 1);
    assert.equal(filtered.artifacts[0].id, artifact.id);
    assert.equal((await request(`/api/artifacts?categoryId=${personal.id}`, "member")).status, 404);
    const manager = await (await request(`/categories?artifactId=${artifact.id}`)).text();
    assert.match(manager, /data-category-membership checked/);
    assert.match(manager, /Documentation/);
    assert.match(manager, /Changes apply immediately/);
    const dashboard = await (await request(`/?categoryId=${personal.id}`)).text();
    assert.match(dashboard, new RegExp(`name="categoryId"`));
    assert.match(dashboard, /Reading/);
    assert.doesNotMatch(dashboard, /Private notes/);
    assert.match(await (await request(`/artifacts/${artifact.id}`)).text(), /\/categories\?artifactId=/);
    const teams = await (await request("/api/category-teams", "member")).json();
    assert.deepEqual(teams.teams, [{ id: team.id, name: "Documentation" }]);
    assert.deepEqual((await (await request("/api/category-teams", "outsider")).json()).teams, []);
    assert.equal((await request(`/api/categories/${shared.id}`, "member", "PATCH", { name: "Team backlog" })).status, 200);
    assert.equal((await request(`/api/categories/${personal.id}`, "owner", "PATCH", { name: "Bad" }, "https://foreign.example")).status, 403);
    const readToken = await createApiToken(app.store, accounts.owner.user.id, { name: "Read only", scopes: ["read"] });
    const denied = await fetch(`${app.url}/api/categories`, { method: "POST", headers: { authorization: `Bearer ${readToken.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Denied" }) });
    assert.equal(denied.status, 403);
    const mixedToken = await fetch(`${app.url}/api/categories`, { headers: { cookie: accounts.owner.cookie, authorization: `Bearer ${accounts.outsider.token}` } });
    assert.deepEqual((await mixedToken.json()).categories, []);
    const mixedReadToken = await fetch(`${app.url}/api/categories`, { method: "POST", headers: { cookie: accounts.owner.cookie, authorization: `Bearer ${readToken.token}`, "content-type": "application/json", origin: app.url }, body: JSON.stringify({ name: "Still denied" }) });
    assert.equal(mixedReadToken.status, 403);
    const wrongPort = await request(`/api/categories/${personal.id}`, "owner", "PATCH", { name: "Wrong origin" }, "http://127.0.0.1:1");
    assert.equal(wrongPort.status, 403);

    assert.equal((await request(`/api/categories/${personal.id}/artifacts/${artifact.id}`, "owner", "DELETE")).status, 200);
    assert.equal((await request(`/api/categories/${personal.id}`, "owner", "DELETE")).status, 200);
    assert.equal((await request(`/api/artifacts/${artifact.id}`)).status, 200);
    const ko = await (await request("/categories?lang=ko")).text();
    assert.match(ko, /카테고리 만들기/);
    assert.match(ko, /소속 팀/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
