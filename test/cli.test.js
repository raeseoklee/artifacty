import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("prints CLI version without loading SQLite", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["src/cli.js", "--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(stderr, "");
});

test("generates API tokens from the CLI", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/cli.js", "token"]);
  const result = JSON.parse(stdout);

  assert.equal(result.bytes, 32);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.env, /^ARTIFACTY_API_TOKEN="/);
  assert.equal(result.header, `x-artifacty-token: ${result.token}`);
  assert.equal(result.authorization, `Authorization: Bearer ${result.token}`);
});

test("generates configurable token sizes", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/cli.js", "token", "--bytes", "48"]);
  const result = JSON.parse(stdout);

  assert.equal(result.bytes, 48);
  assert.match(result.token, /^[A-Za-z0-9_-]{64}$/);
});

test("prints raw token for shell usage", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/cli.js", "token", "--raw"]);
  assert.match(stdout.trim(), /^[A-Za-z0-9_-]{43}$/);
});

test("rejects unsafe token byte sizes", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["src/cli.js", "token", "--bytes", "8"]),
    /--bytes must be an integer between 16 and 128/
  );
});

test("serve can generate and enforce a startup API token", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-"));
  const child = spawn(process.execPath, [
    "src/cli.js",
    "serve",
    "--foreground",
    "--port",
    "0",
    "--home",
    home,
    "--generate-token"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    const stderr = await waitForStderr(child, (output) => output.includes("Import URL:"));
    const url = /Artifacty listening on (http:\/\/[^\s]+)/.exec(stderr)?.[1];
    const token = /API token: ([A-Za-z0-9_-]+)/.exec(stderr)?.[1];

    assert.ok(url);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(stderr, new RegExp(`Create URL: ${escapeRegExp(url)}/new\\?token=${escapeRegExp(token)}`));
    assert.match(stderr, new RegExp(`Import URL: ${escapeRegExp(url)}/import\\?token=${escapeRegExp(token)}`));

    const unauthorized = await fetch(`${url}/api/artifacts`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${url}/api/artifacts`, {
      headers: {
        "x-artifacty-token": token
      }
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stopProcess(child);
    await rm(home, { recursive: true, force: true });
  }
});

test("serve rejects conflicting token options", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["src/cli.js", "serve", "--api-token", "configured", "--generate-token"]),
    /Use either --api-token or --generate-token, not both/
  );
});

test("serve rejects conflicting foreground and detach modes", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["src/cli.js", "serve", "--foreground", "--detach"]),
    /Use either --foreground or --detach, not both/
  );
});

test("imports users from CSV through the CLI", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-users-"));
  const csvPath = path.join(home, "users.csv");
  try {
    await writeFile(csvPath, "email,name,role\ncli-user@example.com,CLI User,user\n", "utf8");
    const { stdout } = await execFileAsync(process.execPath, [
      "src/cli.js",
      "users",
      "import",
      "--home",
      home,
      "--file",
      csvPath
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].user.email, "cli-user@example.com");
    assert.equal(result.created[0].user.passwordResetRequired, true);
    assert.match(result.created[0].temporaryPassword, /^tmp_[A-Za-z0-9_-]+$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("backs up and restores a full-scope bundle through the CLI", async () => {
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-backup-full-src-"));
  const targetHome = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-backup-full-dst-"));
  try {
    const csvPath = path.join(sourceHome, "users.csv");
    await writeFile(csvPath, "email,name,role\ncli-admin@example.com,CLI Admin,admin\n", "utf8");
    await execFileAsync(process.execPath, ["src/cli.js", "users", "import", "--home", sourceHome, "--file", csvPath]);

    await execFileAsync(process.execPath, [
      "src/cli.js", "publish",
      "--home", sourceHome,
      "--title", "Full Backup Demo",
      "--content", "hello",
      "--format", "text",
      "--source", "cli"
    ]);

    const backupPath = path.join(sourceHome, "full-backup.json");
    const { stdout: backupStdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "backup",
      "--home", sourceHome,
      "--file", backupPath,
      "--full"
    ]);
    const backupResult = JSON.parse(backupStdout);
    assert.equal(backupResult.scope, "full");
    assert.equal(backupResult.artifactCount, 1);

    // Restoring into a fresh store without --confirm is rejected with a clear error.
    await assert.rejects(
      execFileAsync(process.execPath, ["src/cli.js", "import-store", "--home", targetHome, "--file", backupPath]),
      /confirm/i
    );

    const { stdout: importStdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "import-store",
      "--home", targetHome,
      "--file", backupPath,
      "--confirm", "replace-all"
    ]);
    const importResult = JSON.parse(importStdout);
    assert.equal(importResult.scope, "full");
    assert.equal(importResult.artifactCount, 1);
    assert.equal(importResult.tableCounts.users, 1);

    const { stdout: usersStdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", targetHome
    ]);
    assert.match(usersStdout, /Full Backup Demo/);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("serve starts a background server by default and returns generated auth", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-serve-background-"));
  try {
    const result = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "serve",
      "--port",
      "0",
      "--home",
      home,
      "--generate-token",
      "--bytes",
      "16"
    ])).stdout);

    assert.equal(result.action, "start");
    assert.equal(result.running, true);
    assert.equal(result.home, home);
    assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(result.auth.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(result.auth.header, `x-artifacty-token: ${result.auth.token}`);
    assert.equal(result.auth.createUrl, `${result.url}/new?token=${encodeURIComponent(result.auth.token)}`);
    assert.equal(result.auth.importUrl, `${result.url}/import?token=${encodeURIComponent(result.auth.token)}`);

    const unauthorized = await fetch(`${result.url}/api/artifacts`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${result.url}/api/artifacts`, {
      headers: {
        "x-artifacty-token": result.auth.token
      }
    });
    assert.equal(authorized.status, 200);
  } finally {
    await execFileAsync(process.execPath, ["src/cli.js", "stop", "--home", home, "--force"]).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test("starts, reports, and stops a background server", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-background-"));
  try {
    const start = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "start",
      "--port",
      "0",
      "--home",
      home
    ])).stdout);

    assert.equal(start.running, true);
    assert.equal(start.home, home);
    assert.match(start.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${start.url}/health`)).status, 200);

    const status = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "status",
      "--home",
      home
    ])).stdout);
    assert.equal(status.running, true);
    assert.equal(status.managed, true);
    assert.equal(status.pid, start.pid);
    assert.equal(status.url, start.url);

    const stop = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "stop",
      "--home",
      home
    ])).stdout);
    assert.equal(stop.stopped, true);
    assert.equal(stop.running, false);

    const stopped = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "status",
      "--home",
      home
    ])).stdout);
    assert.equal(stopped.running, false);
    assert.equal(stopped.managed, false);
  } finally {
    await execFileAsync(process.execPath, ["src/cli.js", "stop", "--home", home]).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test("imports media files as base64 artifacts", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-media-"));
  try {
    const pngBytes = Buffer.from("89504e470d0a", "hex");
    const pngPath = path.join(home, "screenshot.png");
    await writeFile(pngPath, pngBytes);

    const { stdout } = await execFileAsync(process.execPath, [
      "src/cli.js",
      "import",
      "--home",
      home,
      "--agent",
      "cursor",
      "--file",
      pngPath
    ]);
    const imported = JSON.parse(stdout);

    assert.equal(imported.version.format, "image");
    assert.equal(imported.version.contentType, "image/png");
    assert.equal(imported.artifactType, "asset");
    assert.equal(imported.content, pngBytes.toString("base64"));
    assert.equal(imported.version.metadata.mimeType, "image/png");
    assert.equal(imported.version.metadata.encoding, "base64");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("lists paginated artifacts and checks store integrity from the CLI", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-search-"));
  try {
    for (const title of ["One", "Two", "Three"]) {
      await execFileAsync(process.execPath, [
        "src/cli.js",
        "publish",
        "--home",
        home,
        "--title",
        title,
        "--format",
        "markdown",
        "--content",
        `# ${title}`
      ]);
    }

    const list = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "list",
      "--home",
      home,
      "--limit",
      "2",
      "--offset",
      "1"
    ])).stdout);
    assert.equal(list.artifacts.length, 2);
    assert.equal(list.pagination.total, 3);
    assert.equal(list.pagination.offset, 1);
    assert.equal(list.pagination.previousOffset, 0);

    const integrity = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "integrity",
      "--home",
      home
    ])).stdout);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.artifactCount, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("filters, groups, and saves views from the CLI", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-views-"));
  try {
    const handoff = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Handoff", "--format", "text", "--content", "a",
      "--artifact-type", "handoff"
    ])).stdout);
    const doc = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Doc", "--format", "text", "--content", "b",
      "--artifact-type", "document"
    ])).stdout);

    const byType = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", home, "--type", "handoff"
    ])).stdout);
    assert.equal(byType.artifacts.length, 1);
    assert.equal(byType.artifacts[0].id, handoff.id);

    await assert.rejects(
      execFileAsync(process.execPath, ["src/cli.js", "list", "--home", home, "--created-after", "not-a-date"]),
      /Invalid createdAfter filter/
    );

    const grouped = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", home, "--group-by", "artifactType"
    ])).stdout);
    assert.deepEqual(new Set(Object.keys(grouped.groups)), new Set(["handoff", "document"]));
    assert.deepEqual(grouped.groups.handoff, [handoff.id]);

    const savedView = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "views", "save", "Handoffs", "--home", home, "--type", "handoff"
    ])).stdout);
    assert.equal(savedView.name, "Handoffs");
    assert.deepEqual(savedView.filters, { artifactType: "handoff" });

    const listedViews = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "views", "--home", home
    ])).stdout);
    assert.equal(listedViews.views.length, 1);
    assert.equal(listedViews.views[0].id, savedView.id);

    const expanded = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", home, "--view", savedView.id
    ])).stdout);
    assert.equal(expanded.artifacts.length, 1);
    assert.equal(expanded.artifacts[0].id, handoff.id);

    const overridden = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", home, "--view", savedView.id, "--type", "document"
    ])).stdout);
    assert.equal(overridden.artifacts.length, 1);
    assert.equal(overridden.artifacts[0].id, doc.id);

    await execFileAsync(process.execPath, ["src/cli.js", "views", "delete", savedView.id, "--home", home]);
    const afterDelete = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "views", "--home", home
    ])).stdout);
    assert.equal(afterDelete.views.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("links, unlinks, and lists artifact relations from the CLI", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-relations-"));
  try {
    const a = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "A", "--format", "text", "--content", "a"
    ])).stdout);
    const b = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "B", "--format", "text", "--content", "b"
    ])).stdout);

    const linked = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "link", b.id, "derived-from", a.id, "--home", home
    ])).stdout);
    assert.equal(linked.fromId, b.id);
    assert.equal(linked.toId, a.id);
    assert.equal(linked.relation, "derived-from");

    const relationsOfA = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "relations", a.id, "--home", home
    ])).stdout);
    assert.equal(relationsOfA.incoming.length, 1);
    assert.equal(relationsOfA.incoming[0].relation, "derives");
    assert.equal(relationsOfA.incoming[0].artifactId, b.id);

    const shown = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "show", b.id, "--home", home, "--relations"
    ])).stdout);
    assert.equal(shown.outgoing.length, 1);
    assert.equal(shown.outgoing[0].relation, "derived-from");

    const listRelated = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", home, "--related-to", a.id
    ])).stdout);
    assert.equal(listRelated.artifacts.length, 1);
    assert.equal(listRelated.artifacts[0].id, b.id);

    await execFileAsync(process.execPath, [
      "src/cli.js", "unlink", b.id, "derived-from", a.id, "--home", home
    ]);
    const afterUnlink = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "relations", a.id, "--home", home
    ])).stdout);
    assert.equal(afterUnlink.incoming.length, 0);

    await assert.rejects(
      execFileAsync(process.execPath, ["src/cli.js", "link", b.id, "not-a-relation", a.id, "--home", home]),
      /Unsupported relation/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("comments, resolve-comment, and review-status from the CLI", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-comments-"));
  try {
    const doc = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Doc", "--format", "text", "--content", "hello"
    ])).stdout);

    const comment = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "comment", doc.id, "--home", home, "--body", "Please fix line 1", "--line", "1"
    ])).stdout);
    assert.equal(comment.status, "open");
    assert.deepEqual(comment.anchor, { line: 1 });

    const reply = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "comment", doc.id, "--home", home, "--body", "Done", "--parent", comment.id
    ])).stdout);
    assert.equal(reply.parentId, comment.id);

    const listed = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "comments", doc.id, "--home", home
    ])).stdout);
    assert.equal(listed.length, 2);

    const resolved = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "resolve-comment", doc.id, comment.id, "--home", home
    ])).stdout);
    assert.equal(resolved.status, "resolved");

    const openOnly = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "comments", doc.id, "--home", home, "--status", "open"
    ])).stdout);
    assert.equal(openOnly.length, 1);
    assert.equal(openOnly[0].id, reply.id);

    const withStatus = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "review-status", doc.id, "approved", "--home", home
    ])).stdout);
    assert.equal(withStatus.reviewStatus, "approved");

    await assert.rejects(
      execFileAsync(process.execPath, ["src/cli.js", "comment", doc.id, "--home", home]),
      /--body/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("diff compares versions, defaulting from/to and supporting --structured/--json", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-diff-"));
  try {
    const created = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Diff CLI",
      "--format", "json", "--content", JSON.stringify({ a: 1 })
    ])).stdout);

    await execFileAsync(process.execPath, [
      "src/cli.js", "update", created.id, "--home", home,
      "--format", "json", "--content", JSON.stringify({ a: 2 })
    ]);

    // Defaults: --json --structured picks the json path-keyed diff for a
    // JSON artifact between the two latest versions.
    const structured = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "diff", created.id, "--home", home, "--json"
    ])).stdout);
    assert.equal(structured.from, 1);
    assert.equal(structured.to, 2);
    assert.equal(structured.view, "structured");
    assert.equal(structured.format, "json");
    assert.equal(structured.structuredDiff.kind, "json");
    const changed = structured.structuredDiff.entries.find((entry) => entry.op === "changed");
    assert.equal(changed.path, "$.a");
    assert.equal(changed.before, 1);
    assert.equal(changed.after, 2);

    // Human-readable unified text output (no --json), with explicit --from/--to.
    const text = (await execFileAsync(process.execPath, [
      "src/cli.js", "diff", created.id, "--home", home, "--from", "1", "--to", "2"
    ])).stdout;
    assert.match(text, /\$\.a/);

    // A plain-text artifact defaults to the line view; --structured forces
    // the structured (word-highlighted line) diff instead.
    const textArtifact = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Diff CLI Text",
      "--format", "text", "--content", "hello world"
    ])).stdout);
    await execFileAsync(process.execPath, [
      "src/cli.js", "update", textArtifact.id, "--home", home,
      "--format", "text", "--content", "hello there"
    ]);

    const lineDiffJson = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "diff", textArtifact.id, "--home", home, "--json"
    ])).stdout);
    assert.equal(lineDiffJson.view, "lines");
    assert.equal(lineDiffJson.structuredDiff, undefined);

    const structuredLineDiff = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "diff", textArtifact.id, "--home", home, "--json", "--structured"
    ])).stdout);
    assert.equal(structuredLineDiff.view, "structured");
    assert.equal(structuredLineDiff.structuredDiff.kind, "lines");
    const changedLine = structuredLineDiff.structuredDiff.entries.find((entry) => entry.op === "changed");
    assert.ok(changedLine.words.some((w) => w.op === "removed" && w.text === "world"));
    assert.ok(changedLine.words.some((w) => w.op === "added" && w.text === "there"));

    await assert.rejects(
      execFileAsync(process.execPath, ["src/cli.js", "diff", "--home", home]),
      /diff requires an artifact id/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("update --expected-version enforces optimistic concurrency and reports conflicts as JSON", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-concurrency-"));
  try {
    const created = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "publish",
      "--home",
      home,
      "--title",
      "CLI Concurrent",
      "--format",
      "text",
      "--content",
      "v1"
    ])).stdout);
    assert.equal(created.latestVersion, 1);

    const updated = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "update",
      created.id,
      "--home",
      home,
      "--format",
      "text",
      "--content",
      "v2",
      "--expected-version",
      "1"
    ])).stdout);
    assert.equal(updated.latestVersion, 2);

    let error;
    try {
      await execFileAsync(process.execPath, [
        "src/cli.js",
        "update",
        created.id,
        "--home",
        home,
        "--format",
        "text",
        "--content",
        "v3-conflict",
        "--expected-version",
        "1"
      ]);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, "expected the conflicting update to exit non-zero");
    assert.notEqual(error.code, 0);
    const conflictBody = JSON.parse(error.stdout);
    assert.equal(conflictBody.code, "version_conflict");
    assert.equal(conflictBody.latestVersion, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rebuilds the search index from the CLI when FTS5 is available", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-index-"));
  try {
    await execFileAsync(process.execPath, [
      "src/cli.js",
      "publish",
      "--home",
      home,
      "--title",
      "Indexed",
      "--format",
      "text",
      "--content",
      "searchable"
    ]);

    let result;
    try {
      result = JSON.parse((await execFileAsync(process.execPath, [
        "src/cli.js",
        "index",
        "rebuild",
        "--home",
        home
      ])).stdout);
    } catch (error) {
      result = JSON.parse(error.stdout);
    }

    if (result.fts5) {
      assert.equal(result.indexed, 1);
      assert.deepEqual(result.skipped, []);
    } else {
      assert.match(result.message, /FTS5 is unavailable/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("list --mode falls back to keyword without a provider and reports search.mode", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-mode-"));
  try {
    await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Deploy", "--format", "text", "--content", "deploy failed"
    ]);

    const { stdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", home, "--query", "deploy", "--mode", "semantic"
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.search.mode, "keyword");
    assert.equal(result.search.fallback, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("list --mode uses a configured embedding provider for semantic ranking", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-mode-provider-"));
  const commandPath = path.resolve("scripts/fixtures/embeddings-command.js");
  const env = {
    ...process.env,
    ARTIFACTY_EMBEDDINGS_COMMAND: `${process.execPath} ${JSON.stringify(commandPath)}`,
    // Publishing schedules background embedding indexing; force it to run
    // synchronously so the artifact is searchable as soon as the publish
    // subprocess exits, instead of racing it with a fixed sleep.
    ARTIFACTY_EMBEDDINGS_SYNC: "true"
  };
  try {
    await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Deploy", "--format", "text", "--content", "deploy failed"
    ], { env });

    const { stdout } = await execFileAsync(process.execPath, [
      "src/cli.js", "list", "--home", home, "--query", "deploy", "--mode", "semantic"
    ], { env });
    const result = JSON.parse(stdout);
    assert.equal(result.search.mode, "semantic");
    assert.equal(result.artifacts.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("index rebuild --embeddings re-embeds artifacts and reports configured: false without a provider", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-rebuild-embeddings-"));
  try {
    await execFileAsync(process.execPath, [
      "src/cli.js", "publish", "--home", home, "--title", "Doc", "--format", "text", "--content", "hello"
    ]);

    const withoutProvider = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "index", "rebuild", "--embeddings", "--home", home
    ])).stdout);
    assert.equal(withoutProvider.embeddings.configured, false);

    const commandPath = path.resolve("scripts/fixtures/embeddings-command.js");
    const env = {
      ...process.env,
      ARTIFACTY_EMBEDDINGS_COMMAND: `${process.execPath} ${JSON.stringify(commandPath)}`
    };
    const withProvider = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js", "index", "rebuild", "--embeddings", "--home", home
    ], { env })).stdout);
    assert.equal(withProvider.embeddings.configured, true);
    assert.equal(withProvider.embeddings.indexed, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("server entrypoint can generate and enforce a startup API token", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-server-"));
  const child = spawn(process.execPath, [
    "src/server.js",
    "--port",
    "0",
    "--home",
    home,
    "--generate-token",
    "--bytes",
    "16"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    const stderr = await waitForStderr(child, (output) => output.includes("Import URL:"));
    const url = /Artifacty listening on (http:\/\/[^\s]+)/.exec(stderr)?.[1];
    const token = /API token: ([A-Za-z0-9_-]+)/.exec(stderr)?.[1];

    assert.ok(url);
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);

    const unauthorized = await fetch(`${url}/api/artifacts`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${url}/api/artifacts`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stopProcess(child);
    await rm(home, { recursive: true, force: true });
  }
});

function waitForStderr(child, predicate) {
  let output = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stderr. Output:\n${output}`));
    }, 5000);

    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (predicate(output)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Process exited before expected output: code=${code} signal=${signal}\n${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
