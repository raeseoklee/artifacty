import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportStore, importStore, importStoreFromString, defaultBackupPath } from "../src/lib/backup.js";
import { checkStoreIntegrity, createArtifact, createStore, getArtifact, listArtifacts } from "../src/lib/storage.js";
import { createLaunchAgentPlist, createSystemdUserUnit, createWindowsTaskScript, serviceCommand } from "../src/lib/service.js";

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

test("store restore replaces artifact files without leaving orphans", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-replace-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-replace-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    const kept = await createArtifact(sourceStore, {
      title: "Kept",
      content: "kept",
      format: "text",
      sourceAgent: "test"
    });
    const backupFile = path.join(sourceHome, "backup.json");
    await exportStore(sourceStore, backupFile);

    const targetStore = createStore({ home: targetHome });
    const removed = await createArtifact(targetStore, {
      title: "Removed",
      content: "removed",
      format: "text",
      sourceAgent: "test"
    });
    assert.notEqual(kept.id, removed.id);

    await importStore(targetStore, backupFile);
    const artifacts = await listArtifacts(targetStore);
    assert.deepEqual(artifacts.map((artifact) => artifact.id), [kept.id]);

    const integrity = await checkStoreIntegrity(targetStore);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.orphanFiles.length, 0);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("store restore rejects unsafe backup version paths", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-path-"));
  try {
    const store = createStore({ home });
    for (const unsafePath of ["../outside.txt", "..\\outside.txt", "C:\\outside.txt"]) {
      const malicious = JSON.stringify({
        schemaVersion: 1,
        artifacts: [
          {
            id: "malicious",
            title: "Malicious",
            artifactType: "document",
            schemaVersion: 1,
            sourceAgent: "test",
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            latestVersion: 1,
            versions: [
              {
                version: 1,
                createdAt: new Date().toISOString(),
                format: "text",
                contentType: "text/plain; charset=utf-8",
                path: unsafePath,
                sizeBytes: 3,
                sha256: "bad",
                metadata: {},
                content: "bad"
              }
            ]
          }
        ]
      });

      await assert.rejects(
        () => importStoreFromString(store, malicious),
        /Invalid Artifacty backup version path/
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("store restore normalizes portable backup paths across operating systems", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-portable-"));
  try {
    const store = createStore({ home });
    const content = "portable";
    const backup = JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        {
          id: "portable",
          title: "Portable",
          artifactType: "document",
          schemaVersion: 1,
          sourceAgent: "test",
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestVersion: 1,
          versions: [
            {
              version: 1,
              createdAt: new Date().toISOString(),
              format: "text",
              contentType: "text/plain; charset=utf-8",
              path: "artifacts\\portable\\v1.txt",
              sizeBytes: Buffer.byteLength(content),
              sha256: createHash("sha256").update(content).digest("hex"),
              metadata: {},
              content
            }
          ]
        }
      ]
    });

    await importStoreFromString(store, backup);
    assert.equal((await getArtifact(store, "portable")).content, content);
    const restored = await getArtifact(store, "portable");
    assert.equal(restored.version.path, "artifacts/portable/v1.txt");
    assert.equal((await checkStoreIntegrity(store)).ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
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
      platform: "macos",
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

test("builds Linux systemd user service definitions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-service-linux-"));
  try {
    const unitPath = path.join(home, "com.artifacty.server.service");
    const unit = createSystemdUserUnit({
      projectDir: process.cwd(),
      home,
      host: "127.0.0.1",
      port: 8787,
      apiToken: "service-token",
      mcpHttp: true
    });

    assert.match(unit, /\[Unit\]/);
    assert.match(unit, /ExecStart=/);
    assert.match(unit, /ARTIFACTY_HOME=/);
    assert.match(unit, /ARTIFACTY_API_TOKEN=service-token/);
    assert.match(unit, /--mcp-http/);
    assert.match(unit, /Restart=on-failure/);

    const result = await serviceCommand("install", {
      platform: "linux",
      projectDir: process.cwd(),
      home,
      unitPath,
      dryRun: true
    });
    assert.equal(result.platform, "linux");
    assert.equal(result.path, unitPath);
    assert.match(result.content, /WantedBy=default\.target/);
    assert.ok(result.nextSteps.some((step) => step.includes("systemctl --user enable --now")));
    assert.ok(result.nextSteps.some((step) => step.includes("loginctl enable-linger")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("builds Windows scheduled task installer scripts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-service-windows-"));
  try {
    const scriptPath = path.join(home, "install-artifacty-server-task.ps1");
    const script = createWindowsTaskScript({
      projectDir: process.cwd(),
      home,
      host: "127.0.0.1",
      port: 8787,
      apiToken: "service-token",
      mcpHttp: true
    });

    assert.match(script, /Register-ScheduledTask/);
    assert.match(script, /ArtifactyServer/);
    assert.match(script, /Start-ScheduledTask/);
    assert.match(script, /--api-token service-token/);
    assert.match(script, /--mcp-http/);

    const result = await serviceCommand("task", {
      platform: "windows",
      projectDir: process.cwd(),
      home,
      scriptPath
    });
    assert.equal(result.platform, "windows");
    assert.equal(result.path, scriptPath);
    assert.match(result.content, /New-ScheduledTaskAction/);
    assert.ok(result.nextSteps.some((step) => step.includes("powershell")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
