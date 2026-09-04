// Regression coverage for the security review findings in
// security-findings-2.md: H1 (SARIF export DoS), H2 (unbounded diff rows),
// M1 (retention purge path traversal), M2 (embeddings command shell
// injection / env leak), M3 (semantic search full-store load), M4
// (includeDeleted access control), M5 (saved-view name leak via audit), and
// L5 (saved-view name shadowing). H3 is intentionally out of scope (see
// docs/network-sharing.md).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildSarifExport } from "../src/lib/sarif-csv-export.js";
import { renderDiffPage } from "../src/lib/render.js";
import { createEmbeddingProvider } from "../src/lib/embeddings.js";
import { setRetentionPolicy, runRetention } from "../src/lib/retention.js";
import {
  createArtifact,
  createStore,
  createUser,
  createSavedView,
  resolveSavedView,
  listAuditEvents,
  addComment,
  deleteComment,
  listComments,
  ensureStore,
  resetEmbeddingProvider,
  setEmbeddingProvider,
  listArtifactsPage
} from "../src/lib/storage.js";

async function withTempStore(prefix, fn) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await fn(createStore({ home }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// --- H1: SARIF export must be single-pass / linear -----------------------

test("H1: buildSarifExport handles a 5k-result document quickly and produces valid SARIF", () => {
  const results = [];
  for (let i = 0; i < 5000; i += 1) {
    results.push({
      ruleId: `rule-${i % 20}`,
      level: i % 7 === 0 ? "error" : "warning",
      message: { text: `finding number ${i} with a bit of extra text to pad the payload out realistically` },
      locations: [{ physicalLocation: { artifactLocation: { uri: `src/file${i % 50}.js` }, region: { startLine: i } } }]
    });
  }
  const sarif = {
    version: "2.1.0",
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    runs: [{ tool: { driver: { name: "test-tool", rules: [] } }, results }]
  };
  const content = JSON.stringify(sarif);

  const start = Date.now();
  const out = buildSarifExport({ content, maxBytes: Infinity });
  const elapsedMs = Date.now() - start;

  assert.equal(out.ok, true);
  assert.equal(out.matchedCount, 5000);
  assert.equal(out.resultCount, 5000);
  assert.equal(out.truncated, false);
  // A generous bound: the old O(n^2) re-serialize-per-result implementation
  // would take on the order of tens of seconds to minutes for 5k results at
  // this size; the linear implementation finishes in well under a second.
  assert.ok(elapsedMs < 5000, `expected linear-time export to finish quickly, took ${elapsedMs}ms`);

  const parsed = JSON.parse(out.json);
  assert.equal(parsed.runs[0].results.length, 5000);
  assert.equal(Buffer.byteLength(out.json, "utf8"), out.sizeBytes);

  // Byte budget path also stays correct and bounded.
  const budgeted = buildSarifExport({ content, maxBytes: 20000 });
  assert.equal(budgeted.ok, true);
  assert.equal(budgeted.truncated, true);
  assert.ok(budgeted.sizeBytes <= 20000);
  const budgetedParsed = JSON.parse(budgeted.json);
  assert.equal(budgetedParsed.runs[0].results.length, budgeted.resultCount);
});

// --- H2: diff page must bound rendered rows -------------------------------

test("H2: renderDiffPage caps line-diff rows and shows a truncation notice", () => {
  const originalEnv = process.env.ARTIFACTY_MAX_DIFF_ENTRIES;
  process.env.ARTIFACTY_MAX_DIFF_ENTRIES = "50";
  try {
    const diffRows = [];
    for (let i = 0; i < 500; i += 1) {
      diffRows.push({ type: "added", beforeLine: "", afterLine: i + 1, text: `line ${i}` });
    }
    const artifact = {
      id: "diff-fixture",
      title: "Diff Fixture",
      versions: [{ version: 1 }, { version: 2 }]
    };
    const html = renderDiffPage({
      artifact,
      fromVersion: { version: 1, format: "text" },
      toVersion: { version: 2, format: "text" },
      fromContent: "a",
      toContent: "b",
      diffRows,
      view: "lines",
      baseUrl: "http://127.0.0.1:8787",
      currentPath: "/artifacts/diff-fixture/diff"
    });

    const rowMatches = html.match(/<tr class="diff-added">/g) || [];
    assert.equal(rowMatches.length, 50, "rendered rows must be capped at ARTIFACTY_MAX_DIFF_ENTRIES");
    assert.match(html, /diff-truncated-note/, "must show a truncation notice");
  } finally {
    if (originalEnv === undefined) {
      delete process.env.ARTIFACTY_MAX_DIFF_ENTRIES;
    } else {
      process.env.ARTIFACTY_MAX_DIFF_ENTRIES = originalEnv;
    }
  }
});

// --- M1: retention purge must not follow a crafted artifact id -----------

test("M1: retention purge guards against a path-traversal artifact id", async () => {
  await withTempStore("artifacty-sec2-purge-", async (store) => {
    // Simulate a row inserted by a restored backup bundle (replaceTableRows
    // writes ids verbatim, with no validation) rather than makeArtifactId.
    // ensureStore() first, so the full schema (all columns/tables/indexes)
    // exists exactly as it would for a real store.
    await ensureStore(store);
    const maliciousId = "../evil-outside-store";
    const db = new DatabaseSync(store.dbPath);
    const now = new Date().toISOString();
    const archivedAt = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString();
    try {
      db.prepare(`
        INSERT INTO artifacts (id, title, artifact_type, schema_version, source_agent, tags_json, created_at, updated_at, latest_version, archived_at)
        VALUES (?, ?, 'document', 1, 'test', '[]', ?, ?, 1, ?)
      `).run(maliciousId, "Evil", now, now, archivedAt);
    } finally {
      db.close();
    }

    // A sentinel file outside artifactsDir that a naive
    // path.join(artifactsDir, id) + rmSync(recursive) could otherwise reach.
    const sentinelDir = path.join(store.home, "evil-outside-store");
    await (await import("node:fs/promises")).mkdir(sentinelDir, { recursive: true });
    const sentinelFile = path.join(sentinelDir, "keepme.txt");
    await (await import("node:fs/promises")).writeFile(sentinelFile, "do not delete me");

    await setRetentionPolicy(store, {
      archiveAfterDays: { default: null, byType: {} },
      purgeArchivedAfterDays: 180,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: []
    });

    process.env.ARTIFACTY_RETENTION_ALLOW_PURGE = "true";
    let result;
    try {
      result = await runRetention(store, { dryRun: false, allowPurge: true });
    } finally {
      delete process.env.ARTIFACTY_RETENTION_ALLOW_PURGE;
    }

    // The DB row is still purged (that part is safe -- it's parameterized
    // SQL), but the filesystem delete must have been skipped entirely.
    assert.deepEqual(result.purged, [maliciousId]);
    assert.ok(existsSync(sentinelFile), "purge must not delete anything outside store.artifactsDir");
  });
});

// --- M2: embeddings command provider must not go through a shell ---------

test("M2: command provider parses argv without a shell and excludes secrets from its env", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-sec2-cmd-"));
  const markerFile = path.join(home, "should-not-exist.marker");
  try {
    // A single quoted -e script that emits one embedding JSON line per
    // stdin line it reads, followed by a shell-metacharacter payload that
    // would run a second command (`touch <marker>`) if the command string
    // were ever handed to /bin/sh. With shell:false and proper argv
    // splitting, ";", "touch", and the marker path are just inert extra
    // argv entries to the node process, not a second command.
    const script =
      'let d="";process.stdin.on("data",c=>d+=c);' +
      'process.stdin.on("end",()=>{' +
      'const n=d.split(String.fromCharCode(10)).filter(Boolean).length;' +
      'for(let i=0;i<n;i++){process.stdout.write(JSON.stringify({embedding:[1,2,3]})+String.fromCharCode(10))}' +
      "})";
    const command = `${process.execPath} -e '${script}' ; touch ${markerFile}`;

    const provider = createEmbeddingProvider({
      ARTIFACTY_EMBEDDINGS_COMMAND: command,
      ARTIFACTY_EMBEDDINGS_MODEL: "test-model",
      ARTIFACTY_EMBEDDINGS_API_KEY: "super-secret-key",
      ARTIFACTY_API_TOKEN: "should-never-reach-child",
      PATH: process.env.PATH,
      HOME: process.env.HOME
    });
    assert.equal(provider.name, "command");

    const vectors = await provider.embed(["hello world"]);
    assert.equal(vectors.length, 1);
    assert.deepEqual(Array.from(vectors[0]), [1, 2, 3]);

    assert.equal(existsSync(markerFile), false, "the ; touch ... payload must never execute");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("M2: minimal embeddings env excludes the API key and unrelated secrets", async () => {
  const { minimalEmbeddingsEnv } = await import("../src/lib/embeddings.js");
  const env = minimalEmbeddingsEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    LANG: "en_US.UTF-8",
    ARTIFACTY_EMBEDDINGS_MODEL: "m",
    ARTIFACTY_EMBEDDINGS_API_KEY: "secret-key",
    ARTIFACTY_API_TOKEN: "server-token",
    SOME_OTHER_SECRET: "nope"
  });
  assert.equal(env.ARTIFACTY_EMBEDDINGS_MODEL, "m");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal("ARTIFACTY_EMBEDDINGS_API_KEY" in env, false);
  assert.equal("ARTIFACTY_API_TOKEN" in env, false);
  assert.equal("SOME_OTHER_SECRET" in env, false);
});

// --- M3: semantic search must not decode the whole embeddings table ------

function fakeProvider() {
  const axes = ["alpha", "beta", "gamma"];
  return {
    name: "sec2-fake",
    model: "sec2-fake-model",
    dimensions: axes.length,
    async embed(texts) {
      return texts.map((text) => {
        const lower = String(text).toLowerCase();
        const vector = new Float32Array(axes.length);
        axes.forEach((axis, index) => {
          if (lower.includes(axis)) {
            vector[index] = 1;
          }
        });
        if (!vector.some(Boolean)) {
          vector[0] = 0.01;
        }
        return vector;
      });
    }
  };
}

async function waitForBackgroundIndexing() {
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

test("M3: semantic search caps candidates via ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES", async () => {
  await withTempStore("artifacty-sec2-semantic-", async (store) => {
    setEmbeddingProvider(fakeProvider());
    try {
      await createArtifact(store, { title: "Alpha doc", content: "alpha content", format: "text", sourceAgent: "test" });
      await createArtifact(store, { title: "Beta doc", content: "beta content", format: "text", sourceAgent: "test" });
      await createArtifact(store, { title: "Gamma doc", content: "gamma content", format: "text", sourceAgent: "test" });
      await waitForBackgroundIndexing();

      const originalCap = process.env.ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES;
      process.env.ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES = "1";
      try {
        const page = await listArtifactsPage(store, { query: "alpha", mode: "semantic" });
        assert.equal(page.search.mode, "semantic");
        assert.equal(page.search.candidatesTruncated, true);
        assert.ok(page.artifacts.length <= 1, "result set must respect the candidate cap");
      } finally {
        if (originalCap === undefined) {
          delete process.env.ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES;
        } else {
          process.env.ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES = originalCap;
        }
      }

      // Without a cap constraint, ranking is unaffected and untruncated.
      const uncapped = await listArtifactsPage(store, { query: "alpha content", mode: "semantic" });
      assert.equal(uncapped.search.candidatesTruncated, undefined);
    } finally {
      resetEmbeddingProvider();
    }
  });
});

// --- M4: includeDeleted must be scoped to admin / comment author ---------

test("M4: includeDeleted is ignored for a non-admin, non-author reader", async () => {
  await withTempStore("artifacty-sec2-includedeleted-", async (store) => {
    const author = await createUser(store, { email: "author@example.com", name: "Author", role: "user", password: "password-123" });
    const stranger = await createUser(store, { email: "stranger@example.com", name: "Stranger", role: "user", password: "password-123" });
    const admin = await createUser(store, { email: "admin2@example.com", name: "Admin", role: "admin", password: "password-123" });
    const authorAccess = { userId: author.id, role: author.role };
    const strangerAccess = { userId: stranger.id, role: stranger.role };
    const adminAccess = { userId: admin.id, role: admin.role };

    const artifact = await createArtifact(store, {
      title: "Commented doc",
      content: "hello",
      format: "text",
      sourceAgent: "test",
      visibility: "team",
      access: authorAccess
    });

    const comment = await addComment(store, artifact.id, {
      body: "a very secret note that got deleted",
      access: authorAccess,
      audit: { userId: author.id, userName: author.name }
    });
    await deleteComment(store, artifact.id, comment.id, { access: authorAccess, audit: { userId: author.id } });

    const strangerView = await listComments(store, artifact.id, { includeDeleted: true, access: strangerAccess });
    assert.equal(strangerView.some((c) => c.id === comment.id), false, "a non-author, non-admin must not see the deleted comment even with includeDeleted=true");

    const authorView = await listComments(store, artifact.id, { includeDeleted: true, access: authorAccess });
    assert.equal(authorView.some((c) => c.id === comment.id), true, "the comment's own author may still see it");

    const adminView = await listComments(store, artifact.id, { includeDeleted: true, access: adminAccess });
    assert.equal(adminView.some((c) => c.id === comment.id), true, "an admin may see it");

    const strangerWithoutFlag = await listComments(store, artifact.id, { access: strangerAccess });
    assert.equal(strangerWithoutFlag.some((c) => c.id === comment.id), false);
  });
});

// --- M5: audit rows must not leak private saved-view names ---------------

test("M5: /api/audit-equivalent listAuditEvents does not leak a private saved view's name", async () => {
  await withTempStore("artifacty-sec2-audit-views-", async (store) => {
    const owner = await createUser(store, { email: "views-owner2@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "views-other2@example.com", name: "Other", role: "user", password: "password-123" });
    const ownerAccess = { userId: owner.id, role: owner.role };
    const otherAccess = { userId: other.id, role: other.role };

    const privateView = await createSavedView(store, {
      name: "Owner's Confidential Roadmap View",
      filters: { tag: "confidential" },
      shared: false,
      access: ownerAccess,
      audit: { userId: owner.id }
    });
    const sharedView = await createSavedView(store, {
      name: "Team Shared View",
      filters: { tag: "public" },
      shared: true,
      access: ownerAccess,
      audit: { userId: owner.id }
    });

    // listAuditEvents has no per-artifact-less-row visibility filter (those
    // rows carry artifactId: ""), so the fix must be that the metadata
    // itself never carries the private view's name -- confirm that holds
    // for every caller, not just a non-owner.
    for (const access of [otherAccess, ownerAccess]) {
      const events = await listAuditEvents(store, { access, limit: 500 });
      const privateEvent = events.find((e) => e.action === "view-create" && e.metadata?.viewId === privateView.id);
      const sharedEvent = events.find((e) => e.action === "view-create" && e.metadata?.viewId === sharedView.id);
      assert.ok(privateEvent, "the view-create audit row must still exist");
      assert.equal("name" in privateEvent.metadata, false, "a private view's name must not appear in audit metadata");
      assert.ok(sharedEvent);
      assert.equal(sharedEvent.metadata.name, "Team Shared View", "a shared view's name may still appear");
    }
  });
});

// --- L5: resolveSavedView must not be shadowed by another user's private view ---

test("L5: a private view of the same name from another user does not shadow the caller's own view", async () => {
  await withTempStore("artifacty-sec2-view-shadow-", async (store) => {
    const attacker = await createUser(store, { email: "attacker@example.com", name: "Attacker", role: "user", password: "password-123" });
    const victim = await createUser(store, { email: "victim@example.com", name: "Victim", role: "user", password: "password-123" });
    const attackerAccess = { userId: attacker.id, role: attacker.role };
    const victimAccess = { userId: victim.id, role: victim.role };

    // Create the attacker's private view of a given name first (so it would
    // sort first / tie-break first under a naive "match by name, then
    // visibility-check" implementation).
    await createSavedView(store, { name: "daily", filters: { tag: "attacker-tag" }, shared: false, access: attackerAccess });
    const victimView = await createSavedView(store, { name: "daily", filters: { tag: "victim-tag" }, shared: false, access: victimAccess });

    const resolved = await resolveSavedView(store, "daily", { access: victimAccess });
    assert.ok(resolved, "the victim's own view must resolve, not be shadowed by the attacker's same-named private view");
    assert.equal(resolved.id, victimView.id);
    assert.equal(resolved.filters.tag, "victim-tag");
  });
});
