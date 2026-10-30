import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertVerifiedRun, main } from "../.github/scripts/verify-release-run.mjs";

const expected = { repository: "owner/artifacty", sha: "a".repeat(40), workflowId: 42 };
const successful = { status: "completed", conclusion: "success", event: "workflow_dispatch", workflow_id: 42, path: ".github/workflows/verify.yml", repository: { full_name: expected.repository }, head_repository: { full_name: expected.repository }, head_sha: expected.sha, run_attempt: 2 };

test("publication selects the package from the exact successful commit and attempt", () => {
  assert.equal(assertVerifiedRun(successful, expected), `release-${expected.sha}-2`);
});

test("publication rejects pending, failed, unrelated, forked and stale verification", () => {
  for (const patch of [
    { status: "in_progress" }, { conclusion: "failure" }, { conclusion: "cancelled" },
    { event: "pull_request" }, { workflow_id: 99 }, { path: ".github/workflows/security.yml" },
    { repository: { full_name: "other/artifacty" } }, { head_repository: { full_name: "fork/artifacty" } },
    { head_sha: "b".repeat(40) }, { run_attempt: 0 }, { run_attempt: "2" }
  ]) assert.throws(() => assertVerifiedRun({ ...successful, ...patch }, expected));
});

test("publication rejects a malformed run ID before contacting GitHub", async () => {
  for (const id of [undefined, "", "0", "../runs/1", "1\nartifact=other"]) {
    await assert.rejects(main({ VERIFICATION_RUN_ID: id }), /numeric/);
  }
});


test("release gate resolves GitHub evidence and emits only the verified artifact name", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-release-gate-"));
  const requests = [];
  let fail = false;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (fail) { response.writeHead(403).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url.endsWith("/runs/123") ? successful : { id: 42 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const env = { VERIFICATION_RUN_ID: "123", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: expected.repository, GITHUB_SHA: expected.sha, GH_TOKEN: "fixture", GITHUB_OUTPUT: path.join(home, "output") };
  await main(env);
  assert.deepEqual(requests.sort(), ["/repos/owner/artifacty/actions/runs/123", "/repos/owner/artifacty/actions/workflows/verify.yml"]);
  const output = await readFile(env.GITHUB_OUTPUT, "utf8");
  assert.equal(output, `artifact=release-${expected.sha}-2\n`);
  fail = true;
  await assert.rejects(main(env), /returned 403/);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), output);
});
