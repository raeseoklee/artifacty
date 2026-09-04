// `artifacty retention show|set|run` CLI coverage (roadmap section 9).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function backdate(home, artifactId, { updatedAt, archivedAt } = {}) {
  const db = new DatabaseSync(path.join(home, "artifacty.sqlite"));
  try {
    if (updatedAt) {
      db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(updatedAt, artifactId);
    }
    if (archivedAt !== undefined) {
      db.prepare("UPDATE artifacts SET archived_at = ? WHERE id = ?").run(archivedAt, artifactId);
    }
  } finally {
    db.close();
  }
}

test("artifacty retention show returns the default (inert) policy", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-retention-show-"));
  try {
    const policy = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "show",
      "--home",
      home
    ])).stdout);
    assert.equal(policy.archiveAfterDays.default, null);
    assert.deepEqual(policy.archiveAfterDays.byType, {});
    assert.equal(policy.purgeArchivedAfterDays, null);
    assert.deepEqual(policy.keepTags, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("artifacty retention set persists archive/purge windows, per-type overrides, and keep tags", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-retention-set-"));
  try {
    const saved = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "set",
      "--home",
      home,
      "--archive-after-days",
      "90",
      "--archive-after-days-for",
      "test-report=30",
      "--purge-archived-after-days",
      "180",
      "--audit-retention-days",
      "365",
      "--event-retention-rows",
      "10000",
      "--keep-tag",
      "pinned",
      "--keep-tag",
      "release"
    ])).stdout);

    assert.equal(saved.archiveAfterDays.default, 90);
    assert.deepEqual(saved.archiveAfterDays.byType, { "test-report": 30 });
    assert.equal(saved.purgeArchivedAfterDays, 180);
    assert.equal(saved.auditRetentionDays, 365);
    assert.equal(saved.eventRetentionRows, 10000);
    assert.deepEqual(saved.keepTags, ["pinned", "release"]);

    const reShown = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "show",
      "--home",
      home
    ])).stdout);
    assert.deepEqual(reShown, saved);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("artifacty retention run defaults to a dry run that makes no changes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-retention-dryrun-"));
  try {
    const published = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "publish",
      "--home",
      home,
      "--title",
      "Old doc",
      "--format",
      "text",
      "--content",
      "hello"
    ])).stdout);
    backdate(home, published.id, { updatedAt: daysAgo(100) });
    await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "set",
      "--home",
      home,
      "--archive-after-days",
      "90"
    ]);

    const report = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "run",
      "--home",
      home,
      "--dry-run"
    ])).stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.archived.length, 0);
    assert.ok(report.archive.some((item) => item.id === published.id));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("artifacty retention run --allow-purge purges an eligible archived artifact and removes its files", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-retention-purge-"));
  try {
    const published = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "publish",
      "--home",
      home,
      "--title",
      "To purge",
      "--format",
      "text",
      "--content",
      "hello"
    ])).stdout);

    await execFileAsync(process.execPath, [
      "src/cli.js",
      "archive",
      published.id,
      "--home",
      home
    ]);
    backdate(home, published.id, { archivedAt: daysAgo(200) });

    await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "set",
      "--home",
      home,
      "--purge-archived-after-days",
      "180"
    ]);

    const refused = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "run",
      "--home",
      home
    ])).stdout);
    assert.equal(refused.dryRun, false);
    assert.equal(refused.purged.length, 0);
    assert.equal(refused.purgeSkipped, true);

    const artifactDir = path.join(home, "artifacts", published.id);
    assert.ok(existsSync(artifactDir), "files must survive an ungated purge attempt");

    // --allow-purge alone is a request-level opt-in only. It must not purge
    // without the operator having also set ARTIFACTY_RETENTION_ALLOW_PURGE
    // in the server/CLI process environment (the CLI must never set that
    // env var itself, or a request-level flag would defeat the operator
    // gate entirely).
    const stillRefused = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "run",
      "--home",
      home,
      "--allow-purge"
    ])).stdout);
    assert.equal(stillRefused.purged.length, 0);
    assert.equal(stillRefused.purgeSkipped, true);
    assert.ok(existsSync(artifactDir), "files must survive --allow-purge without the operator env gate");

    const applied = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "retention",
      "run",
      "--home",
      home,
      "--allow-purge"
    ], { env: { ...process.env, ARTIFACTY_RETENTION_ALLOW_PURGE: "true" } })).stdout);
    assert.deepEqual(applied.purged, [published.id]);
    assert.equal(existsSync(artifactDir), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
