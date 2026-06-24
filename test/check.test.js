import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkMcpTools, REQUIRED_MCP_TOOLS } from "../src/lib/check.js";

test("checks MCP tool discovery", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-check-"));
  try {
    const result = await checkMcpTools({
      projectDir: process.cwd(),
      home,
      timeout: 5000
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingTools, []);
    for (const tool of REQUIRED_MCP_TOOLS) {
      assert.ok(result.tools.includes(tool), `${tool} should be discovered`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
