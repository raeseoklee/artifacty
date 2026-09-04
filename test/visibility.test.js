import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const execFileAsync = promisify(execFile);

import {
  addRelation,
  archiveArtifact,
  createApiToken,
  createArtifact,
  createStore,
  createUser,
  getArtifact,
  listArtifactsPage,
  listRelations,
  removeRelation,
  restoreArtifact,
  setArtifactOwner,
  setArtifactVisibility,
  STORE_VERSION,
  updateArtifact,
  VISIBILITY_VALUES
} from "../src/lib/storage.js";
import { startServer } from "../src/server.js";
import { createMcpRequestHandler } from "../src/mcp-server.js";

async function withStore(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-visibility-"));
  try {
    await fn(createStore({ home }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("VISIBILITY_VALUES and STORE_VERSION reflect Section 10", () => {
  assert.deepEqual(VISIBILITY_VALUES, ["private", "team"]);
  assert.equal(STORE_VERSION, 8);
});

test("createArtifact validates visibility and defaults to team", async () => {
  await withStore(async (store) => {
    const defaulted = await createArtifact(store, {
      title: "Default Visibility",
      content: "hello",
      format: "text"
    });
    assert.equal(defaulted.visibility, "team");

    const privateArtifact = await createArtifact(store, {
      title: "Private One",
      content: "hello",
      format: "text",
      visibility: "private"
    });
    assert.equal(privateArtifact.visibility, "private");

    await assert.rejects(
      () => createArtifact(store, {
        title: "Bad Visibility",
        content: "hello",
        format: "text",
        visibility: "public"
      }),
      /Unsupported visibility/
    );
  });
});

test("single-user mode (no users) bypasses all visibility restrictions", async () => {
  await withStore(async (store) => {
    const artifact = await createArtifact(store, {
      title: "Single User Private",
      content: "hello",
      format: "text",
      visibility: "private"
    });

    const readAsStranger = await getArtifact(store, artifact.id, {
      access: { userId: "someone-else", role: "user" }
    });
    assert.equal(readAsStranger.id, artifact.id);

    const updated = await updateArtifact(store, artifact.id, {
      content: "hello again",
      format: "text",
      access: { userId: "someone-else", role: "user" }
    });
    assert.equal(updated.latestVersion, 2);
  });
});

test("private artifacts: owner/admin read and write, others get 404/403", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "other@example.com", name: "Other", role: "user", password: "password-123" });
    const admin = await createUser(store, { email: "admin@example.com", name: "Admin", role: "admin", password: "password-123" });

    const artifact = await createArtifact(store, {
      title: "Private Artifact",
      content: "secret",
      format: "text",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });
    assert.equal(artifact.ownerUserId, owner.id);

    const ownerAccess = { userId: owner.id, role: "user" };
    const otherAccess = { userId: other.id, role: "user" };
    const adminAccess = { userId: admin.id, role: "admin" };

    // Owner can read and write.
    const readByOwner = await getArtifact(store, artifact.id, { access: ownerAccess });
    assert.equal(readByOwner.id, artifact.id);
    const updatedByOwner = await updateArtifact(store, artifact.id, {
      content: "secret v2",
      format: "text",
      access: ownerAccess
    });
    assert.equal(updatedByOwner.latestVersion, 2);

    // Admin can read and write.
    const readByAdmin = await getArtifact(store, artifact.id, { access: adminAccess });
    assert.equal(readByAdmin.id, artifact.id);

    // Non-owner read -> 404 (existence hidden).
    await assert.rejects(
      () => getArtifact(store, artifact.id, { access: otherAccess }),
      (error) => {
        assert.equal(error.statusCode, 404);
        assert.equal(error.code, "ARTIFACT_NOT_FOUND");
        return true;
      }
    );

    // Non-owner write -> also 404 because the read guard runs first.
    await assert.rejects(
      () => updateArtifact(store, artifact.id, { content: "hacked", format: "text", access: otherAccess }),
      (error) => {
        assert.equal(error.statusCode, 404);
        return true;
      }
    );

    // Non-owner does not see it in listings.
    const listedByOther = await listArtifactsPage(store, { access: otherAccess });
    assert.ok(!listedByOther.artifacts.some((item) => item.id === artifact.id));

    const listedByOwner = await listArtifactsPage(store, { access: ownerAccess });
    assert.ok(listedByOwner.artifacts.some((item) => item.id === artifact.id));

    const listedByAdmin = await listArtifactsPage(store, { access: adminAccess });
    assert.ok(listedByAdmin.artifacts.some((item) => item.id === artifact.id));
  });
});

test("the SQL visibility predicate guards an empty owner_user_id from matching an anonymous access.userId", async () => {
  await withStore(async (store) => {
    // A real user so isSingleUserMode() is false and the visibility
    // predicate actually applies.
    await createUser(store, { email: "someone@example.com", name: "Someone", role: "user", password: "password-123" });

    const artifact = await createArtifact(store, {
      title: "Private with empty owner",
      content: "secret",
      format: "text",
      visibility: "private"
    });

    // Simulate a row whose owner_user_id is a literal empty string rather
    // than NULL - e.g. a hand-edited or pre-normalization full-scope backup
    // restore, which writes row values through without the
    // normalizeOptionalString(...) || null coercion setArtifactOwner uses.
    // This is exactly the case visibilityClause()'s `? != ''` guard exists
    // for: `access.userId || ""` for an anonymous caller is also "", and
    // without the guard `owner_user_id = ?` would match.
    const db = new DatabaseSync(store.dbPath);
    db.prepare("UPDATE artifacts SET owner_user_id = '' WHERE id = ?").run(artifact.id);
    db.close();

    const anonymousAccess = { role: "user" }; // no userId
    const page = await listArtifactsPage(store, { access: anonymousAccess, includeArchived: true });
    assert.ok(
      !page.artifacts.some((item) => item.id === artifact.id),
      "an anonymous access context must not see a private artifact via an empty owner_user_id"
    );

    await assert.rejects(
      () => getArtifact(store, artifact.id, { access: anonymousAccess }),
      (error) => {
        assert.equal(error.code, "ARTIFACT_NOT_FOUND");
        return true;
      }
    );
  });
});

test("team artifacts: any authenticated user reads/writes, ARTIFACTY_TEAM_WRITE=owner restricts writes", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "team-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "team-other@example.com", name: "Other", role: "user", password: "password-123" });

    const artifact = await createArtifact(store, {
      title: "Team Artifact",
      content: "shared",
      format: "text",
      visibility: "team",
      audit: { userId: owner.id, actor: owner.email }
    });

    const otherAccess = { userId: other.id, role: "user" };
    const readByOther = await getArtifact(store, artifact.id, { access: otherAccess });
    assert.equal(readByOther.id, artifact.id);

    const updatedByOther = await updateArtifact(store, artifact.id, {
      content: "shared v2",
      format: "text",
      access: otherAccess
    });
    assert.equal(updatedByOther.latestVersion, 2);

    const previous = process.env.ARTIFACTY_TEAM_WRITE;
    process.env.ARTIFACTY_TEAM_WRITE = "owner";
    try {
      await assert.rejects(
        () => updateArtifact(store, artifact.id, { content: "blocked", format: "text", access: otherAccess }),
        (error) => {
          assert.equal(error.statusCode, 403);
          assert.equal(error.code, "forbidden");
          return true;
        }
      );
      const ownerAccess = { userId: owner.id, role: "user" };
      const updatedByOwner = await updateArtifact(store, artifact.id, {
        content: "owner can still write",
        format: "text",
        access: ownerAccess
      });
      assert.equal(updatedByOwner.latestVersion, 3);
    } finally {
      if (previous === undefined) {
        delete process.env.ARTIFACTY_TEAM_WRITE;
      } else {
        process.env.ARTIFACTY_TEAM_WRITE = previous;
      }
    }
  });
});

test("anonymous shared-token access sees team only and cannot write when ARTIFACTY_TEAM_WRITE=owner", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "anon-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const teamArtifact = await createArtifact(store, {
      title: "Team Visible",
      content: "public-ish",
      format: "text",
      visibility: "team",
      audit: { userId: owner.id, actor: owner.email }
    });
    const privateArtifact = await createArtifact(store, {
      title: "Private Hidden",
      content: "hidden",
      format: "text",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });

    const anonAccess = { userId: null, role: null, anonymous: true };

    const list = await listArtifactsPage(store, { access: anonAccess });
    assert.ok(list.artifacts.some((item) => item.id === teamArtifact.id));
    assert.ok(!list.artifacts.some((item) => item.id === privateArtifact.id));

    await assert.rejects(
      () => getArtifact(store, privateArtifact.id, { access: anonAccess }),
      (error) => {
        assert.equal(error.statusCode, 404);
        return true;
      }
    );

    const updated = await updateArtifact(store, teamArtifact.id, {
      content: "anon wrote this",
      format: "text",
      access: anonAccess
    });
    assert.equal(updated.latestVersion, 2);

    const previous = process.env.ARTIFACTY_TEAM_WRITE;
    process.env.ARTIFACTY_TEAM_WRITE = "owner";
    try {
      await assert.rejects(
        () => updateArtifact(store, teamArtifact.id, { content: "blocked anon", format: "text", access: anonAccess }),
        (error) => {
          assert.equal(error.statusCode, 403);
          return true;
        }
      );
    } finally {
      if (previous === undefined) {
        delete process.env.ARTIFACTY_TEAM_WRITE;
      } else {
        process.env.ARTIFACTY_TEAM_WRITE = previous;
      }
    }
  });
});

test("archive, restore, visibility, and owner changes require owner or admin", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "manage-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "manage-other@example.com", name: "Other", role: "user", password: "password-123" });
    const admin = await createUser(store, { email: "manage-admin@example.com", name: "Admin", role: "admin", password: "password-123" });

    const artifact = await createArtifact(store, {
      title: "Team Manageable",
      content: "content",
      format: "text",
      visibility: "team",
      audit: { userId: owner.id, actor: owner.email }
    });

    const otherAccess = { userId: other.id, role: "user" };
    const ownerAccess = { userId: owner.id, role: "user" };
    const adminAccess = { userId: admin.id, role: "admin" };

    await assert.rejects(
      () => archiveArtifact(store, artifact.id, { access: otherAccess }),
      (error) => {
        assert.equal(error.statusCode, 403);
        return true;
      }
    );
    await assert.rejects(
      () => setArtifactVisibility(store, artifact.id, "private", { access: otherAccess }),
      (error) => {
        assert.equal(error.statusCode, 403);
        return true;
      }
    );
    await assert.rejects(
      () => setArtifactOwner(store, artifact.id, other.id, { access: otherAccess }),
      (error) => {
        assert.equal(error.statusCode, 403);
        return true;
      }
    );

    const archived = await archiveArtifact(store, artifact.id, { access: ownerAccess });
    assert.ok(archived.archivedAt);
    const restored = await restoreArtifact(store, artifact.id, { access: adminAccess });
    assert.equal(restored.archivedAt, null);

    const madePrivate = await setArtifactVisibility(store, artifact.id, "private", { access: ownerAccess });
    assert.equal(madePrivate.visibility, "private");

    const reassigned = await setArtifactOwner(store, artifact.id, other.id, { access: adminAccess });
    assert.equal(reassigned.ownerUserId, other.id);

    await assert.rejects(() => setArtifactVisibility(store, artifact.id, "nope", { access: adminAccess }), /Unsupported visibility/);
  });
});

test("relation entries to a private artifact are restricted for non-owners", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "rel-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "rel-other@example.com", name: "Other", role: "user", password: "password-123" });

    const visibleArtifact = await createArtifact(store, {
      title: "Visible Source",
      content: "content",
      format: "text",
      visibility: "team",
      audit: { userId: other.id, actor: other.email }
    });
    const privateTarget = await createArtifact(store, {
      title: "Private Target",
      content: "content",
      format: "text",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });

    await addRelation(store, {
      fromId: visibleArtifact.id,
      toId: privateTarget.id,
      relation: "references",
      access: { userId: owner.id, role: "user" }
    });

    const otherAccess = { userId: other.id, role: "user" };
    const relations = await listRelations(store, visibleArtifact.id, { access: otherAccess });
    assert.equal(relations.outgoing.length, 1);
    assert.equal(relations.outgoing[0].restricted, true);
    // Both the neighbour's summary and its id are withheld: ids are
    // slugified titles, so leaking the id alone would still disclose the
    // private artifact's title (see security-fixes-visibility.test.js M3).
    assert.equal(relations.outgoing[0].artifact, null);
    assert.equal(relations.outgoing[0].artifactId, null);

    const ownerAccess = { userId: owner.id, role: "user" };
    const relationsForOwner = await listRelations(store, visibleArtifact.id, { access: ownerAccess });
    assert.equal(relationsForOwner.outgoing[0].restricted, false);
    assert.equal(relationsForOwner.outgoing[0].artifact.id, privateTarget.id);

    await removeRelation(store, {
      fromId: visibleArtifact.id,
      toId: privateTarget.id,
      relation: "references",
      access: ownerAccess
    });
    const afterRemoval = await listRelations(store, visibleArtifact.id, { access: ownerAccess });
    assert.equal(afterRemoval.outgoing.length, 0);
  });
});

test("migration backfills owner_user_id from publisher_user_id for legacy rows", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-visibility-migration-"));
  try {
    const store = createStore({ home });
    const user = await createUser(store, { email: "migrate@example.com", name: "Migrate", role: "user", password: "password-123" });
    const artifact = await createArtifact(store, {
      title: "Migrated Artifact",
      content: "content",
      format: "text",
      audit: { userId: user.id, actor: user.email }
    });
    assert.equal(artifact.ownerUserId, user.id);

    // Simulate a pre-Section-10 row: null out owner_user_id directly via SQLite,
    // then re-open the store so initializeSchema() re-runs the backfill.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(store.dbPath);
    db.prepare("UPDATE artifacts SET owner_user_id = NULL WHERE id = ?").run(artifact.id);
    db.close();

    const reread = await getArtifact(store, artifact.id);
    assert.equal(reread.ownerUserId, user.id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI: publish/update accept --visibility, and the visibility command changes it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-cli-visibility-"));
  try {
    const { stdout: publishStdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "publish",
      "--home", home,
      "--title", "CLI Visibility Demo",
      "--content", "hello",
      "--format", "text",
      "--visibility", "private"
    ]);
    const published = JSON.parse(publishStdout);
    assert.equal(published.visibility, "private");

    const { stdout: updateStdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "update", published.id,
      "--home", home,
      "--content", "hello v2",
      "--format", "text",
      "--visibility", "team"
    ]);
    const updated = JSON.parse(updateStdout);
    assert.equal(updated.visibility, "team");
    assert.equal(updated.latestVersion, 2);

    const { stdout: visibilityStdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "visibility", published.id, "private", "--home", home
    ]);
    const changed = JSON.parse(visibilityStdout);
    assert.equal(changed.visibility, "private");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HTTP API: private artifacts 404 for non-owners, and the visibility/owner endpoints require owner or admin", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-server-visibility-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });
  try {
    const owner = await createUser(store, { email: "http-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "http-other@example.com", name: "Other", role: "user", password: "password-123" });
    const admin = await createUser(store, { email: "http-admin@example.com", name: "Admin", role: "admin", password: "password-123" });

    const ownerToken = (await createApiToken(store, owner.id, { name: "Owner", scopes: ["read", "write"] })).token;
    const otherToken = (await createApiToken(store, other.id, { name: "Other", scopes: ["read", "write"] })).token;
    const adminToken = (await createApiToken(store, admin.id, { name: "Admin", scopes: ["read", "write", "admin"] })).token;

    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "x-artifacty-token": ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "HTTP Private", content: "secret", format: "text", visibility: "private" })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.visibility, "private");
    assert.equal(created.ownerUserId, owner.id);

    const otherReadResponse = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      headers: { "x-artifacty-token": otherToken }
    });
    assert.equal(otherReadResponse.status, 404);

    const ownerReadResponse = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      headers: { "x-artifacty-token": ownerToken }
    });
    assert.equal(ownerReadResponse.status, 200);

    const otherVisibilityResponse = await fetch(`${app.url}/api/artifacts/${created.id}/visibility`, {
      method: "POST",
      headers: { "x-artifacty-token": otherToken, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "team" })
    });
    assert.equal(otherVisibilityResponse.status, 404);

    const ownerVisibilityResponse = await fetch(`${app.url}/api/artifacts/${created.id}/visibility`, {
      method: "POST",
      headers: { "x-artifacty-token": ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "team" })
    });
    assert.equal(ownerVisibilityResponse.status, 200);
    const madeTeam = await ownerVisibilityResponse.json();
    assert.equal(madeTeam.visibility, "team");

    // Now visible to any authenticated user.
    const otherReadAfterTeam = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      headers: { "x-artifacty-token": otherToken }
    });
    assert.equal(otherReadAfterTeam.status, 200);

    const adminOwnerResponse = await fetch(`${app.url}/api/artifacts/${created.id}/owner`, {
      method: "POST",
      headers: { "x-artifacty-token": adminToken, "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: other.id })
    });
    assert.equal(adminOwnerResponse.status, 200);
    const reowned = await adminOwnerResponse.json();
    assert.equal(reowned.ownerUserId, other.id);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP: artifacty_get and artifacty_set_visibility respect access, and denials surface as tool errors", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-visibility-"));
  try {
    const store = createStore({ home });
    const owner = await createUser(store, { email: "mcp-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "mcp-other@example.com", name: "Other", role: "user", password: "password-123" });

    const ownerHandler = createMcpRequestHandler({
      store,
      auth: { user: owner },
      auditContext: () => ({ surface: "mcp", actor: owner.email, userId: owner.id, publisherName: owner.name })
    });
    const otherHandler = createMcpRequestHandler({
      store,
      auth: { user: other },
      auditContext: () => ({ surface: "mcp", actor: other.email, userId: other.id, publisherName: other.name })
    });

    const created = await ownerHandler({
      method: "tools/call",
      params: {
        name: "artifacty_create",
        arguments: { title: "MCP Private", content: "secret", visibility: "private" }
      }
    });
    assert.equal(created.structuredContent.visibility, "private");
    const id = created.structuredContent.id;

    const deniedGet = await otherHandler({
      method: "tools/call",
      params: { name: "artifacty_get", arguments: { id } }
    });
    assert.equal(deniedGet.isError, true);
    assert.equal(deniedGet.structuredContent.code, "ARTIFACT_NOT_FOUND");

    const deniedVisibility = await otherHandler({
      method: "tools/call",
      params: { name: "artifacty_set_visibility", arguments: { id, visibility: "team" } }
    });
    assert.equal(deniedVisibility.isError, true);
    // The artifact is private and `other` is neither owner nor admin, so the
    // readability guard (not the ownership guard) rejects first, keeping the
    // 404-not-403 existence-hiding behavior consistent across every access
    // path.
    assert.equal(deniedVisibility.structuredContent.code, "ARTIFACT_NOT_FOUND");

    const allowedVisibility = await ownerHandler({
      method: "tools/call",
      params: { name: "artifacty_set_visibility", arguments: { id, visibility: "team" } }
    });
    assert.equal(allowedVisibility.isError, false);
    assert.equal(allowedVisibility.structuredContent.visibility, "team");

    const nowVisible = await otherHandler({
      method: "tools/call",
      params: { name: "artifacty_get", arguments: { id } }
    });
    assert.equal(nowVisible.isError, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("browser: dashboard shows a private badge and the account page lists owned private artifacts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-browser-visibility-"));
  const app = await startServer({ port: 0, home });
  try {
    const setupResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "browser-owner@example.com", name: "Owner", password: "password-123" })
    });
    const cookie = setupResponse.headers.get("set-cookie");

    const createResponse = await fetch(`${app.url}/new`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "Browser Private", content: "secret", format: "text", visibility: "private" })
    });
    assert.equal(createResponse.status, 303);

    const dashboardResponse = await fetch(`${app.url}/`, { headers: { cookie } });
    const dashboardHtml = await dashboardResponse.text();
    assert.match(dashboardHtml, /badge v-private/);

    const accountResponse = await fetch(`${app.url}/account`, { headers: { cookie } });
    const accountHtml = await accountResponse.text();
    assert.match(accountHtml, /Browser Private/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
