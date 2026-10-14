import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore, createUser, listAuditEvents, openDatabase } from "../src/lib/storage.js";
import { stageNetworkPolicy, confirmNetworkPolicy, rollbackNetworkPolicy, getPendingNetworkPolicy, recoverExpiredNetworkPolicy, assertNetworkAccess, getNetworkPolicy, isAddressAllowed, normalizeAllowedNetworks, setNetworkPolicy } from "../src/lib/network-policy.js";

test("normalizes IPv4 and IPv6 networks and rejects malformed entries atomically", () => {
  assert.deepEqual(normalizeAllowedNetworks("192.168.1.54/24,2001:0DB8:1::123/48\n192.168.1.0/24\n::1"), ["192.168.1.0/24", "2001:db8:1::/48", "::1"]);
  assert.deepEqual(normalizeAllowedNetworks(["::ffff:192.168.1.3/120"]), ["192.168.1.0/24"]);
  assert.deepEqual(normalizeAllowedNetworks("\n ,\n"), []);
  for (const value of [null, {}, [4], ["10.0.0.1", "bad"], "localhost", "1.2.3.4/33", "::/129", "::/-1", "::/", "::/1/2", "::/1.5", "::1%lo0", "1.2.3.4/0x1", "01.2.3.4"]) {
    assert.throws(() => normalizeAllowedNetworks(value), { statusCode: 400 });
  }
});

test("matches subnet boundaries, individual hosts, IPv6 and IPv4-mapped socket peers", () => {
  for (const address of ["10.20.30.0", "10.20.30.255", "::ffff:10.20.30.14", "::ffff:a14:1eff"]) {
    assert.equal(isAddressAllowed(address, ["10.20.30.0/24"]), true, address);
  }
  for (const address of ["10.20.29.255", "10.20.31.0", "127.0.0.1", "::1", "garbage", undefined, "10.20.30.1:80", "10.20.30.1, 8.8.8.8"]) {
    assert.equal(isAddressAllowed(address, ["10.20.30.0/24"]), false, String(address));
  }
  assert.equal(isAddressAllowed("2001:db8:abcd:ffff:ffff:ffff:ffff:ffff", ["2001:db8:abcd::/48"]), true);
  assert.equal(isAddressAllowed("2001:db8:abce::", ["2001:db8:abcd::/48"]), false);
  assert.equal(isAddressAllowed("2001:db8::2", ["2001:db8::1"]), false);
  assert.equal(isAddressAllowed("2001:0db8::1", ["2001:db8::1"]), true);
  assert.equal(isAddressAllowed("192.0.2.1", ["192.0.2.1"]), true);
  assert.equal(isAddressAllowed("192.0.2.2", ["192.0.2.1"]), false);
  assert.equal(isAddressAllowed("255.255.255.255", ["0.0.0.0/0"]), true);
  assert.equal(isAddressAllowed("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", ["::/0"]), true);
  assert.equal(isAddressAllowed("invalid", ["::/0", "0.0.0.0/0"]), false);
  assert.equal(isAddressAllowed(undefined, []), true);
});

test("persists policy, requires active admin, audits updates and prevents caller lockout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-network-"));
  try {
    const store = createStore({ home });
    assert.deepEqual(getNetworkPolicy(store), { allowedCidrs: [], allowSharedLinks: false });
    assert.doesNotThrow(() => assertNetworkAccess(store, "192.0.2.1"));
    const admin = await createUser(store, { email: "admin@example.test", password: "long-password-123", role: "admin" });
    const user = await createUser(store, { email: "user@example.test", password: "long-password-123" });
    const access = { userId: admin.id, role: "admin" };
    for (const denied of [undefined, { role: "admin" }, { userId: "missing", role: "admin" }, { userId: user.id, role: "admin" }, { userId: admin.id, role: "user" }]) {
      assert.throws(() => setNetworkPolicy(store, { allowedCidrs: [] }, { access: denied }), { statusCode: 403 });
    }
    assert.throws(() => setNetworkPolicy(store, { allowedCidrs: [], allowSharedLinks: "true" }, { access }), { statusCode: 400 });
    const legacyDb = openDatabase(store);
    try { legacyDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('network_policy', ?)").run(JSON.stringify({ allowedCidrs: [] })); }
    finally { legacyDb.close(); }
    assert.equal(getNetworkPolicy(store).allowSharedLinks, false);
    const policy = setNetworkPolicy(store, { allowedCidrs: "192.0.2.14/24" }, { access, remoteAddress: "::ffff:192.0.2.3", audit: { actor: admin.id, surface: "http" } });
    assert.deepEqual(getNetworkPolicy(createStore({ home })), policy);
    assert.throws(() => assertNetworkAccess(store, "127.0.0.1"), { statusCode: 403, code: "IP_NOT_ALLOWED" });
    assert.doesNotThrow(() => assertNetworkAccess(store, "192.0.2.255"));
    assert.throws(() => setNetworkPolicy(store, { allowedCidrs: ["10.0.0.0/8"] }, { access, remoteAddress: "192.0.2.3" }), { code: "NETWORK_POLICY_LOCKOUT" });
    assert.throws(() => setNetworkPolicy(store, { allowedCidrs: ["192.0.2.0/24", "invalid"] }, { access }), { statusCode: 400 });
    assert.deepEqual(getNetworkPolicy(store), policy);
    const events = await listAuditEvents(store);
    assert.equal(events.filter((event) => event.action === "network-policy-update").length, 1);
    assert.deepEqual(setNetworkPolicy(store, { allowedCidrs: [] }, { access, remoteAddress: "192.0.2.3" }), { allowedCidrs: [], allowSharedLinks: false });
    const db = openDatabase(store);
    db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(admin.id);
    db.close();
    assert.throws(() => setNetworkPolicy(store, { allowedCidrs: [] }, { access }), { statusCode: 403 });
  } finally { await rm(home, { recursive: true, force: true }); }
});


test("staged changes require confirmation and recover durably after their deadline", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-network-confirm-"));
  try {
    const store = createStore({ home });
    const admin = await createUser(store, { email: "admin@example.test", password: "long-password-123", role: "admin" });
    const access = { userId: admin.id, role: "admin" };
    const options = { access, remoteAddress: "192.0.2.1" };
    const initial = { allowedCidrs: ["192.0.2.0/24", "198.51.100.0/24"], allowSharedLinks: false };
    const proposed = { allowedCidrs: ["192.0.2.0/24"], allowSharedLinks: true };
    setNetworkPolicy(store, initial, options);
    assert.throws(() => stageNetworkPolicy(store, proposed), { statusCode: 403 });
    assert.throws(() => stageNetworkPolicy(store, proposed, { access }), { statusCode: 400 });
    for (const timeoutMs of [0, 9999, 600001, NaN, "120000"]) {
      assert.throws(() => stageNetworkPolicy(store, proposed, { ...options, timeoutMs }), { statusCode: 400 });
    }
    assert.throws(() => stageNetworkPolicy(store, { allowedCidrs: ["10.0.0.0/8"] }, options), { code: "NETWORK_POLICY_LOCKOUT" });
    let pending = stageNetworkPolicy(store, proposed, options);
    assert.deepEqual(getPendingNetworkPolicy(store), pending);
    assert.equal(Object.hasOwn(pending, "previousPolicy"), false);
    assert.ok(Date.parse(pending.expiresAt) > Date.now() + 110000);
    assert.deepEqual(getNetworkPolicy(store), proposed);
    assert.throws(() => assertNetworkAccess(store, "198.51.100.1"), { code: "IP_NOT_ALLOWED" });
    assert.throws(() => stageNetworkPolicy(store, initial, options), { code: "NETWORK_POLICY_PENDING" });
    assert.throws(() => setNetworkPolicy(store, initial, options), { code: "NETWORK_POLICY_PENDING" });
    assert.throws(() => confirmNetworkPolicy(store, pending.id, { ...options, remoteAddress: "198.51.100.1" }), { statusCode: 403 });
    assert.throws(() => confirmNetworkPolicy(store, pending.id, { access }), { statusCode: 403 });
    assert.throws(() => confirmNetworkPolicy(store, "wrong-id", options), { code: "NETWORK_POLICY_NOT_PENDING" });
    assert.throws(() => rollbackNetworkPolicy(store, pending.id), { statusCode: 403 });
    assert.deepEqual(rollbackNetworkPolicy(store, pending.id, options), initial);
    assert.equal(getPendingNetworkPolicy(store), null);
    pending = stageNetworkPolicy(store, proposed, options);
    assert.deepEqual(confirmNetworkPolicy(store, pending.id, options), proposed);
    assert.equal(getPendingNetworkPolicy(store), null);
    assert.equal(recoverExpiredNetworkPolicy(store, { now: Date.now() + 1000000 }), false);
    assert.deepEqual(getNetworkPolicy(store), proposed);

    setNetworkPolicy(store, initial, options);
    pending = stageNetworkPolicy(store, proposed, options);
    assert.equal(recoverExpiredNetworkPolicy(store, { now: Date.parse(pending.expiresAt) - 1 }), false);
    assert.equal(recoverExpiredNetworkPolicy(store, { now: Date.parse(pending.expiresAt) }), true);
    assert.deepEqual(getNetworkPolicy(store), initial);
    assert.equal(getPendingNetworkPolicy(store), null);

    // Simulate a process restart after deadline: only durable metadata is used.
    pending = stageNetworkPolicy(store, proposed, options);
    const db = openDatabase(store);
    const row = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'network_policy_pending'").get().value);
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    db.prepare("UPDATE meta SET value = ? WHERE key = 'network_policy_pending'").run(JSON.stringify(row));
    db.close();
    const restarted = createStore({ home });
    assert.doesNotThrow(() => assertNetworkAccess(restarted, "198.51.100.1"));
    assert.deepEqual(getNetworkPolicy(restarted), initial);
    assert.throws(() => confirmNetworkPolicy(restarted, pending.id, options), { code: "NETWORK_POLICY_NOT_PENDING" });
    const events = await listAuditEvents(store);
    for (const action of ["network-policy-stage", "network-policy-confirm", "network-policy-rollback", "network-policy-auto-rollback"]) {
      assert.ok(events.some((event) => event.action === action), action);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
