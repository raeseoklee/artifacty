// /admin/retention and /api/admin/retention coverage (roadmap section 9).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createStore } from "../src/lib/storage.js";
import { startServer } from "../src/server.js";

test("GET/PUT /api/admin/retention and POST /api/admin/retention/run round trip with a token in single-user mode", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-retention-api-"));
  const app = await startServer({ port: 0, home, apiToken: "test-token" });
  try {
    const getResponse = await fetch(`${app.url}/api/admin/retention`, {
      headers: { "x-artifacty-token": "test-token" }
    });
    assert.equal(getResponse.status, 200);
    const initial = await getResponse.json();
    assert.equal(initial.archiveAfterDays.default, null);

    const putResponse = await fetch(`${app.url}/api/admin/retention`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-artifacty-token": "test-token" },
      body: JSON.stringify({
        archiveAfterDays: { default: 90, byType: { "test-report": 30 } },
        purgeArchivedAfterDays: 180,
        auditRetentionDays: 365,
        eventRetentionRows: 10000,
        keepTags: ["pinned"]
      })
    });
    assert.equal(putResponse.status, 200);
    const saved = await putResponse.json();
    assert.equal(saved.archiveAfterDays.default, 90);
    assert.deepEqual(saved.keepTags, ["pinned"]);

    const reGetResponse = await fetch(`${app.url}/api/admin/retention`, {
      headers: { "x-artifacty-token": "test-token" }
    });
    assert.deepEqual(await reGetResponse.json(), saved);

    const runResponse = await fetch(`${app.url}/api/admin/retention/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-artifacty-token": "test-token" },
      body: JSON.stringify({ dryRun: true })
    });
    assert.equal(runResponse.status, 200);
    const report = await runResponse.json();
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.archived, []);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("/api/admin/retention requires admin auth: rejected without a token when one is configured", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-retention-api-auth-"));
  const app = await startServer({ port: 0, home, apiToken: "test-token" });
  try {
    const response = await fetch(`${app.url}/api/admin/retention`);
    assert.equal(response.status, 401);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function createAdminSession(app) {
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
  return setupResponse.headers.get("set-cookie");
}

test("GET /admin/retention renders the policy form and last-sweep summary for an admin session", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-retention-page-"));
  const app = await startServer({ port: 0, home });
  try {
    const cookie = await createAdminSession(app);
    const response = await fetch(`${app.url}/admin/retention`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Retention/);
    assert.match(html, /archiveAfterDaysDefault/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("POST /admin/retention saves the policy and POST /admin/retention/run renders a dry-run report", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-retention-form-"));
  const app = await startServer({ port: 0, home });
  try {
    const cookie = await createAdminSession(app);
    const saveResponse = await fetch(`${app.url}/admin/retention`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        archiveAfterDaysDefault: "30",
        archiveAfterDaysByType: "test-report=10",
        purgeArchivedAfterDays: "",
        auditRetentionDays: "",
        eventRetentionRows: "",
        keepTags: "pinned, release"
      })
    });
    assert.equal(saveResponse.status, 303);

    const store = createStore({ home });
    const { getRetentionPolicy } = await import("../src/lib/retention.js");
    const saved = await getRetentionPolicy(store);
    assert.equal(saved.archiveAfterDays.default, 30);
    assert.deepEqual(saved.archiveAfterDays.byType, { "test-report": 10 });
    assert.deepEqual(saved.keepTags, ["pinned", "release"]);

    const runResponse = await fetch(`${app.url}/admin/retention/run`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ dryRun: "1" })
    });
    assert.equal(runResponse.status, 200);
    const html = await runResponse.text();
    assert.match(html, /Dry-run report|미리보기 결과/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("background retention sweep timer starts and stops cleanly with server startup/shutdown", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-retention-sweep-server-"));
  const app = await startServer({ port: 0, home });
  try {
    const store = createStore({ home });
    const { setRetentionPolicy } = await import("../src/lib/retention.js");
    await setRetentionPolicy(store, {
      archiveAfterDays: { default: 1, byType: {} },
      purgeArchivedAfterDays: null,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: []
    });
    // No assertion on timer firing (interval defaults to an hour); this
    // just verifies startup/shutdown with a non-inert policy doesn't throw
    // and the pid/db close cleanly.
    const db = new DatabaseSync(store.dbPath);
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'retention_policy'").get();
      assert.ok(row);
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
