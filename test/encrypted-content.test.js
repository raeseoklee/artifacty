import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptContent, decryptContent } from "../src/lib/encrypted-content.js";
const context = () => ({ key: randomBytes(32), storeId: "store-one", artifactId: "artifact-one", version: 1, keyId: "key-one" });
const rejected = (fn) => assert.throws(fn, { code: "ENCRYPTED_CONTENT_INVALID", message: "Encrypted content could not be processed securely." });

test("encrypted content round trips empty, UTF-8 and arbitrary binary bytes", () => {
  const options = context();
  const originalKey = Buffer.from(options.key);
  for (const plaintext of [Buffer.alloc(0), Buffer.from("안녕하세요 🌍\n<script>example</script>"), Buffer.from(Array.from({ length: 256 }, (_, index) => index))]) {
    const original = Buffer.from(plaintext);
    const envelope = encryptContent(plaintext, options);
    assert.deepEqual(decryptContent(envelope, options), plaintext);
    assert.deepEqual(plaintext, original);
    assert.equal(envelope.length, plaintext.length + 36);
  }
  assert.deepEqual(options.key, originalKey);
});

test("each encryption has a fresh nonce and exposes no key or context values", () => {
  const options = context();
  const plaintext = Buffer.from("identical document");
  const first = encryptContent(plaintext, options);
  const second = encryptContent(plaintext, options);
  assert.notDeepEqual(first.subarray(8, 20), second.subarray(8, 20));
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(options.key), false);
  assert.equal(first.includes(Buffer.from(options.artifactId)), false);
});

test("every envelope region is authenticated or strictly format checked", () => {
  const options = context();
  const envelope = encryptContent(Buffer.from("secret payload"), options);
  for (let index = 0; index < envelope.length; index++) {
    const changed = Buffer.from(envelope); changed[index] ^= 1;
    rejected(() => decryptContent(changed, options));
  }
  for (let length = 0; length < envelope.length; length++) rejected(() => decryptContent(envelope.subarray(0, length), options));
  rejected(() => decryptContent(Buffer.concat([envelope, Buffer.from([0])]), options));
});

test("keys and every context identifier are bound, including ambiguous separator values", () => {
  const options = context();
  const envelope = encryptContent(Buffer.from("secret"), options);
  for (const change of [{ key: randomBytes(32) }, { storeId: "another" }, { artifactId: "another" }, { version: 2 }, { keyId: "another" }]) {
    rejected(() => decryptContent(envelope, { ...options, ...change }));
  }
  const first = { ...options, storeId: "a:b", artifactId: "c" };
  const second = { ...options, storeId: "a", artifactId: "b:c" };
  rejected(() => decryptContent(encryptContent(Buffer.from("secret"), first), second));
});

test("invalid input types and missing or malformed context fail with sanitized errors", () => {
  const options = context();
  const envelope = encryptContent(Buffer.alloc(0), options);
  for (const bad of [undefined, null, {}, { ...options, key: undefined }, { ...options, key: Buffer.alloc(31) }, { ...options, key: new Uint8Array(32) },
    { ...options, version: 0 }, { ...options, version: 1.5 }, { ...options, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...options, artifactId: "" }, { ...options, storeId: "x".repeat(1025) }, { ...options, keyId: "bad\nkey" }]) {
    rejected(() => encryptContent(Buffer.alloc(0), bad));
    rejected(() => decryptContent(envelope, bad));
  }
  for (const bad of ["text", null, [], new Uint8Array(10)]) {
    rejected(() => encryptContent(bad, options));
    rejected(() => decryptContent(bad, options));
  }
});
