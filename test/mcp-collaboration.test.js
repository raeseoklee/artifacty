import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore, createUser, createArtifact, setAccessMode, setArtifactSharing } from "../src/lib/storage.js";
import { createMcpJsonRpcHandler } from "../src/mcp-server.js";

test("MCP respects read/comment/edit sharing without granting management rights", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-collaboration-"));
  try {
    const store = createStore({ home });
    const owner = await createUser(store, { email: "owner@example.com", password: "password-123", role: "admin" });
    const member = await createUser(store, { email: "member@example.com", password: "password-123", role: "user" });
    const access = { userId: owner.id, role: "admin" };
    const artifact = await createArtifact(store, { title: "Manual", content: "original", ownerUserId: owner.id });
    await setAccessMode(store, "private", { access });
    const handler = createMcpJsonRpcHandler({ store, auth: { type: "api-token", user: member, scopes: ["read", "write"] }, auditContext: () => ({ userId: member.id, actor: member.email, surface: "mcp" }) });
    let nextId = 0;
    const call = async (name, args = {}) => (await handler({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: { id: artifact.id, ...args } } })).result;
    const grant = (permission) => setArtifactSharing(store, artifact.id, { userIds: [member.id], userPermissions: { [member.id]: permission } }, { access });

    await grant("read");
    assert.equal((await call("artifacty_get")).isError, false);
    assert.equal((await call("artifacty_comment", { body: "denied" })).isError, true);
    await grant("comment");
    const comment = await call("artifacty_comment", { body: "Please expand this section" });
    assert.equal(comment.isError, false);
    assert.equal((await call("artifacty_resolve_comment", { commentId: comment.structuredContent.id })).isError, false);
    assert.equal((await call("artifacty_update", { content: "not allowed" })).isError, true);
    await grant("edit");
    assert.equal((await call("artifacty_update", { content: "expanded", expectedVersion: 1 })).isError, false);
    assert.equal((await call("artifacty_archive")).isError, true);
    assert.equal((await call("artifacty_set_visibility", { visibility: "team" })).isError, true);
    await setArtifactSharing(store, artifact.id, {}, { access });
    assert.equal((await call("artifacty_get")).isError, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
