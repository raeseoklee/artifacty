import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { eventFromAudit, EVENT_TYPES, matchesFilter, publish, subscribe } from "../src/lib/events.js";
import {
  addComment,
  archiveArtifact,
  createArtifact,
  createStore,
  createUser,
  addRelation,
  listAuditEvents,
  listEventsSince,
  restoreArtifact,
  setArtifactVisibility,
  updateArtifact
} from "../src/lib/storage.js";

test("eventFromAudit maps actions per the roadmap mapping and excludes non-event actions", () => {
  assert.equal(eventFromAudit({ action: "create", artifactId: "a" }).type, "artifact.created");
  assert.equal(eventFromAudit({ action: "import", artifactId: "a" }).type, "artifact.created");
  assert.equal(eventFromAudit({ action: "update", artifactId: "a" }).type, "artifact.updated");
  assert.equal(eventFromAudit({ action: "archive", artifactId: "a" }).type, "artifact.archived");
  assert.equal(eventFromAudit({ action: "restore", artifactId: "a" }).type, "artifact.restored");
  assert.equal(eventFromAudit({ action: "relation-add", artifactId: "a" }).type, "artifact.relation.added");
  assert.equal(eventFromAudit({ action: "comment-add", artifactId: "a" }).type, "artifact.comment.added");
  assert.equal(eventFromAudit({ action: "review-status-change", artifactId: "a" }).type, "artifact.review_status.changed");
  assert.equal(eventFromAudit({ action: "version-repair", artifactId: "a" }).type, "artifact.version.repaired");
  assert.equal(eventFromAudit({ action: "version-delete", artifactId: "a" }).type, "artifact.version.deleted");
  assert.equal(eventFromAudit({ action: "retention-archive", artifactId: "a" }).type, "artifact.archived");

  assert.equal(eventFromAudit({ action: "update-conflict", artifactId: "a" }), null);
  assert.equal(eventFromAudit({ action: "update-noop", artifactId: "a" }), null);
  assert.equal(eventFromAudit({ action: "read", artifactId: "a" }), null);
  assert.equal(eventFromAudit({ action: "relation-remove", artifactId: "a" }), null);
  assert.equal(eventFromAudit({ action: "comment-resolve", artifactId: "a" }), null);
  assert.equal(eventFromAudit({ action: "comment-delete", artifactId: "a" }), null);
});

test("matchesFilter applies type/tag/artifactId/sourceAgent filters", () => {
  const event = { type: "artifact.updated", artifactId: "abc", sourceAgent: "claude", tags: ["handoff", "release"] };
  assert.ok(matchesFilter(event, {}));
  assert.ok(matchesFilter(event, { type: "artifact.updated" }));
  assert.equal(matchesFilter(event, { type: "artifact.created" }), false);
  assert.ok(matchesFilter(event, { tag: "release" }));
  assert.equal(matchesFilter(event, { tag: "missing" }), false);
  assert.ok(matchesFilter(event, { artifactId: "abc" }));
  assert.equal(matchesFilter(event, { artifactId: "other" }), false);
  assert.ok(matchesFilter(event, { sourceAgent: "claude" }));
  assert.equal(matchesFilter(event, { sourceAgent: "codex" }), false);
});

test("subscribe/publish delivers only to matching listeners and unsubscribe stops delivery", () => {
  const seen = [];
  const unsubscribe = subscribe({ type: "artifact.updated" }, (event) => seen.push(event));
  publish({ type: "artifact.created", artifactId: "a" });
  publish({ type: "artifact.updated", artifactId: "b" });
  assert.deepEqual(seen.map((e) => e.artifactId), ["b"]);
  unsubscribe();
  publish({ type: "artifact.updated", artifactId: "c" });
  assert.deepEqual(seen.map((e) => e.artifactId), ["b"]);
});

test("publish never throws when a listener throws, and other listeners still run", () => {
  const seen = [];
  const unsubBad = subscribe({}, () => {
    throw new Error("boom");
  });
  const unsubGood = subscribe({}, (event) => seen.push(event));
  assert.doesNotThrow(() => publish({ type: "artifact.created", artifactId: "x" }));
  assert.equal(seen.length, 1);
  unsubBad();
  unsubGood();
});

test("EVENT_TYPES lists every mapped public event type", () => {
  assert.ok(EVENT_TYPES.includes("artifact.created"));
  assert.ok(EVENT_TYPES.includes("artifact.updated"));
  assert.ok(EVENT_TYPES.includes("artifact.archived"));
  assert.ok(EVENT_TYPES.includes("artifact.restored"));
  assert.ok(EVENT_TYPES.includes("artifact.relation.added"));
  assert.ok(EVENT_TYPES.includes("artifact.comment.added"));
  assert.ok(EVENT_TYPES.includes("artifact.review_status.changed"));
  assert.ok(EVENT_TYPES.includes("artifact.version.repaired"));
  assert.ok(EVENT_TYPES.includes("artifact.version.deleted"));
});

test("mutations publish events in order only after the transaction commits, and update-conflict never publishes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-events-"));
  try {
    const store = createStore({ home });
    const seen = [];
    const unsubscribe = subscribe({}, (event) => seen.push(event));
    try {
      const artifact = await createArtifact(store, {
        title: "Doc",
        content: "hello",
        sourceAgent: "test",
        tags: ["handoff"]
      });
      await updateArtifact(store, artifact.id, { content: "hello2", sourceAgent: "test" });

      // A version-conflicting update rolls back and must not publish.
      await assert.rejects(updateArtifact(store, artifact.id, {
        content: "stale",
        sourceAgent: "test",
        expectedVersion: 1
      }));

      const other = await createArtifact(store, { title: "Other", content: "x", sourceAgent: "test" });
      await addRelation(store, { fromId: artifact.id, toId: other.id, relation: "references" });
      await archiveArtifact(store, artifact.id);
      await restoreArtifact(store, artifact.id);

      await new Promise((resolve) => setImmediate(resolve));

      const types = seen.map((event) => event.type);
      assert.deepEqual(types, [
        "artifact.created",
        "artifact.updated",
        "artifact.created",
        "artifact.relation.added",
        "artifact.archived",
        "artifact.restored"
      ]);
      assert.ok(seen.every((event) => event.id.startsWith("evt_")));
      assert.deepEqual(seen[1].tags, ["handoff"]);
    } finally {
      unsubscribe();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listEventsSince replays persisted events in order and applies filters, with a bounded history table", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-events-"));
  try {
    const originalLimit = process.env.ARTIFACTY_EVENT_HISTORY;
    process.env.ARTIFACTY_EVENT_HISTORY = "3";
    try {
      const store = createStore({ home });
      const artifact = await createArtifact(store, { title: "Doc", content: "1", sourceAgent: "test" });
      for (let i = 0; i < 5; i += 1) {
        await updateArtifact(store, artifact.id, { content: `v${i}`, sourceAgent: "test" });
      }
      const all = await listEventsSince(store, 0);
      // History is capped at 3, so old events are pruned even though 6 total were published.
      assert.ok(all.length <= 3);
      const seqs = all.map((event) => event.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

      const sinceLatest = await listEventsSince(store, all[all.length - 1].seq);
      assert.equal(sinceLatest.length, 0);

      const filtered = await listEventsSince(store, 0, { artifactId: artifact.id });
      assert.ok(filtered.every((event) => event.artifactId === artifact.id));
    } finally {
      if (originalLimit === undefined) {
        delete process.env.ARTIFACTY_EVENT_HISTORY;
      } else {
        process.env.ARTIFACTY_EVENT_HISTORY = originalLimit;
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listEventsSince re-derives visibility/owner from the live artifact row instead of a stale snapshot", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-events-live-visibility-"));
  try {
    const store = createStore({ home });
    const owner = await createUser(store, { email: "owner@example.com", password: "correct-horse-battery", role: "user" });
    const stranger = await createUser(store, { email: "stranger@example.com", password: "correct-horse-battery", role: "user" });
    const ownerAccess = { userId: owner.id, role: "user" };
    const strangerAccess = { userId: stranger.id, role: "user" };

    // Created (and its "artifact.created" event persisted) while team-visible,
    // so a stranger could see the event at the time it was written.
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      sourceAgent: "test",
      ownerUserId: owner.id
    });

    const beforePrivate = await listEventsSince(store, 0, {}, 200, strangerAccess);
    assert.ok(
      beforePrivate.some((event) => event.artifactId === artifact.id),
      "a stranger must see the creation event while the artifact is team-visible"
    );

    await setArtifactVisibility(store, artifact.id, "private", { access: ownerAccess });

    // The *same* creation event, replayed after the artifact turned
    // private, must no longer be visible to the stranger - the frozen
    // visibility snapshot from when the event was written must not leak it.
    const afterPrivate = await listEventsSince(store, 0, {}, 200, strangerAccess);
    assert.ok(
      !afterPrivate.some((event) => event.artifactId === artifact.id),
      "a stranger must not see events for an artifact that has since gone private"
    );

    // The owner (and an internal/trusted caller with no access context) can
    // still see it.
    const ownerView = await listEventsSince(store, 0, {}, 200, ownerAccess);
    assert.ok(ownerView.some((event) => event.artifactId === artifact.id));
    const trustedView = await listEventsSince(store, 0, {}, 200, null);
    assert.ok(trustedView.some((event) => event.artifactId === artifact.id));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("comment-add audit/event rows carry the artifact's tags and artifactType, like create/update", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-events-comment-tags-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      sourceAgent: "test",
      artifactType: "handoff",
      tags: ["release", "handoff"]
    });

    const seen = [];
    const unsubscribe = subscribe({ type: "artifact.comment.added" }, (event) => seen.push(event));
    try {
      await addComment(store, artifact.id, { body: "Looks good." });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      unsubscribe();
    }

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].tags.sort(), ["handoff", "release"]);
    assert.equal(seen[0].artifactType, "handoff");

    const events = await listEventsSince(store, 0, { tag: "release" });
    assert.ok(events.some((event) => event.type === "artifact.comment.added" && event.artifactId === artifact.id));

    const auditRows = await listAuditEvents(store, { artifactId: artifact.id, action: "comment-add" });
    assert.equal(auditRows.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
