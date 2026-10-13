import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStoreBackup, importStoreBundle } from "../src/lib/backup.js";
import { createArtifact, createStore, createUser, getArtifactSharing, setArtifactSharing } from "../src/lib/storage.js";

test("artifact-only restore requires explicit confirmation before deleting sharing grants", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-access-"));
  try {
    const store = createStore({ home });
    const user = await createUser(store, { email: "reader@example.com", password: "password-123", role: "user" });
    const artifact = await createArtifact(store, { title: "Manual", content: "manual" });
    await setArtifactSharing(store, artifact.id, { userIds: [user.id] });
    const bundle = await buildStoreBackup(store);
    await assert.rejects(importStoreBundle(store, bundle), { code: "dependents_exist" });
    assert.deepEqual((await getArtifactSharing(store, artifact.id)).userIds, [user.id]);
    const result = await importStoreBundle(store, bundle, { confirm: "replace-all" });
    assert.match(JSON.stringify(result.warnings), /sharing grant/);
    assert.deepEqual((await getArtifactSharing(store, artifact.id)).userIds, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid restored permission is rejected before replacing existing artifacts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-permission-"));
  try {
    const store = createStore({ home });
    const user = await createUser(store, { email: "reader@example.com", password: "password-123", role: "user" });
    const artifact = await createArtifact(store, { title: "Manual", content: "keep me" });
    await setArtifactSharing(store, artifact.id, { userIds: [user.id] });
    const bundle = await buildStoreBackup(store, { scope: "full" });
    bundle.full.artifactShares[0].permission = "admin";
    await assert.rejects(importStoreBundle(store, bundle, { confirm: "replace-all", forceUsers: true }), { code: "INVALID_BACKUP" });
    assert.deepEqual((await getArtifactSharing(store, artifact.id)).userIds, [user.id]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
