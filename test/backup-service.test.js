import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportStore, importStore, defaultBackupPath } from "../src/lib/backup.js";
import { createArtifact, createStore, getArtifact, listArtifacts } from "../src/lib/storage.js";
import { createLaunchAgentPlist, serviceCommand } from "../src/lib/service.js";

test("exports and imports a complete store backup", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    const created = await createArtifact(sourceStore, {
      title: "Backup Demo",
      content: "# Backup",
      format: "markdown",
      sourceAgent: "test"
    });
    const backupFile = path.join(sourceHome, "backup.json");

    const exported = await exportStore(sourceStore, backupFile);
    assert.equal(exported.artifactCount, 1);

    const targetStore = createStore({ home: targetHome });
    const imported = await importStore(targetStore, backupFile);
    assert.equal(imported.artifactCount, 1);

    const artifacts = await listArtifacts(targetStore);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, created.id);
    assert.equal((await getArtifact(targetStore, created.id)).content, "# Backup");
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("builds LaunchAgent service definitions without writing in dry run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-service-"));
  try {
    const plistPath = path.join(home, "com.artifacty.server.plist");
    const plist = createLaunchAgentPlist({
      projectDir: process.cwd(),
      home,
      host: "127.0.0.1",
      port: 8787
    });
    assert.match(plist, /com\.artifacty\.server/);
    assert.match(plist, /ARTIFACTY_HOME/);

    const result = await serviceCommand("install", {
      projectDir: process.cwd(),
      home,
      plistPath,
      dryRun: true
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.changed, true);
    assert.match(result.content, /ProgramArguments/);
    assert.ok(defaultBackupPath(createStore({ home })).startsWith(path.join(home, "backups")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
