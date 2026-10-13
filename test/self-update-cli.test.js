import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = (...args) => exec(process.execPath, ["src/cli.js", ...args]);

test("help distinguishes application updates from artifact edits", async () => {
  const { stdout } = await cli("help");
  assert.match(stdout, /artifacty update \[--check\]/);
  assert.match(stdout, /artifacty upgrade \[--check\]/);
  assert.match(stdout, /artifacty update <id> \(--file/);
});

test("a missing artifact id never turns a content edit into a software update", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-update-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [["update", "--content", "Keep this content"], ["upgrade", "unexpected"], ["update", "--force"]]) {
    await assert.rejects(cli(...args, "--home", home), /To update content, use artifacty update <id>/);
  }
  assert.deepEqual(await readdir(home), []);
});
