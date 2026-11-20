import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { safeNextPath, startServer } from "../src/server.js";
import { createArtifact, createStore, createUser, setAccessMode } from "../src/lib/storage.js";

const PASSWORD = "correct horse battery staple";
const html = { accept: "text/html,application/xhtml+xml" };

async function withServer(run) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-login-redirect-"));
  const store = createStore({ home });
  const owner = await createUser(store, { email: "owner@example.test", name: "Owner", role: "user", password: PASSWORD });
  const other = await createUser(store, { email: "other@example.test", name: "Other", role: "user", password: PASSWORD });
  const artifact = await createArtifact(store, { title: "Private plan", content: "secret", sourceAgent: "test", visibility: "private", ownerUserId: owner.id });
  const app = await startServer({ port: 0, home });
  try {
    await run({ app, store, artifact, owner, other });
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function signIn(app, email, next) {
  const body = new URLSearchParams({ email, password: PASSWORD });
  if (next !== undefined) body.set("next", next);
  return fetch(`${app.url}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
}

const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];

test("a signed-out browser is sent to sign in and returns to the artifact afterwards", async () => {
  await withServer(async ({ app, artifact }) => {
    const target = `/artifacts/${artifact.id}?version=1`;
    const page = await fetch(`${app.url}${target}`, { redirect: "manual", headers: html });
    assert.equal(page.status, 303);
    const location = new URL(page.headers.get("location"), app.url);
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), target);

    const login = await fetch(location, { headers: html });
    const loginHtml = await login.text();
    assert.equal(login.status, 200);
    assert.match(loginHtml, /Sign in to continue/);
    assert.match(loginHtml, new RegExp(`name="next" value="${target.replace("?", "\\?")}"`));

    const signedIn = await signIn(app, "owner@example.test", target);
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get("location"), target);
    const opened = await fetch(`${app.url}${target}`, { headers: { ...html, cookie: cookieOf(signedIn) } });
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /Private plan/);
  });
});

test("missing and private artifacts look the same to a signed-out visitor", async () => {
  await withServer(async ({ app, artifact }) => {
    const statusFor = async (id) => {
      const response = await fetch(`${app.url}/artifacts/${id}`, { redirect: "manual", headers: html });
      return [response.status, new URL(response.headers.get("location"), app.url).pathname];
    };
    assert.deepEqual(await statusFor(artifact.id), await statusFor("does-not-exist-12345678"));
  });
});

test("a signed-in visitor without access sees a page instead of JSON", async () => {
  await withServer(async ({ app, artifact }) => {
    const cookie = cookieOf(await signIn(app, "other@example.test"));
    const response = await fetch(`${app.url}/artifacts/${artifact.id}`, { redirect: "manual", headers: { ...html, cookie } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    assert.match(body, /Artifact unavailable/);
    assert.doesNotMatch(body, /Private plan/);
  });
});

test("API, raw, and non-browser clients keep their existing responses", async () => {
  await withServer(async ({ app, artifact }) => {
    const api = await fetch(`${app.url}/api/artifacts/${artifact.id}`, { headers: html });
    assert.match(api.headers.get("content-type"), /application\/json/);
    const raw = await fetch(`${app.url}/artifacts/${artifact.id}/raw`, { redirect: "manual", headers: html });
    assert.notEqual(raw.status, 303);
    const script = await fetch(`${app.url}/artifacts/${artifact.id}`, { redirect: "manual", headers: { accept: "application/json" } });
    assert.equal(script.status, 404);
    assert.match(script.headers.get("content-type"), /application\/json/);
  });
});

test("private mode keeps the requested page across sign-in", async () => {
  await withServer(async ({ app, store, artifact }) => {
    const admin = await createUser(store, { email: "admin@example.test", name: "Admin", role: "admin", password: PASSWORD });
    await setAccessMode(store, "private", { access: { userId: admin.id, role: "admin" } });
    const response = await fetch(`${app.url}/artifacts/${artifact.id}`, { redirect: "manual", headers: html });
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get("location"), app.url).searchParams.get("next"), `/artifacts/${artifact.id}`);
  });
});

test("sign-in only follows same-site paths", async () => {
  for (const unsafe of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "/\\\\evil", "javascript:alert(1)", "/login", "/logout", "", undefined, "/a\nb"]) {
    assert.equal(safeNextPath(unsafe), null, String(unsafe));
  }
  assert.equal(safeNextPath("/artifacts/a-1?version=2"), "/artifacts/a-1?version=2");
  await withServer(async ({ app }) => {
    const response = await signIn(app, "owner@example.test", "https://evil.example/x");
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get("location"), app.url).origin, app.url);
  });
});
