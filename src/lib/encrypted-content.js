import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Format 1: magic (8 bytes), nonce (12), authentication tag (16), ciphertext.
const MAGIC = Buffer.from([0x41, 0x52, 0x54, 0x59, 0x45, 0x4e, 0x43, 0x01]);
const HEADER_BYTES = MAGIC.length + 12 + 16;
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;
const DOMAIN = "artifacty:version-content:aes-256-gcm:v1";
const failure = () => Object.assign(new Error("Encrypted content could not be processed securely."), { code: "ENCRYPTED_CONTENT_INVALID" });

function material(context) {
  if (!context || typeof context !== "object" || !Buffer.isBuffer(context.key) || context.key.length !== 32 ||
      !Number.isSafeInteger(context.version) || context.version < 1) throw failure();
  for (const field of ["storeId", "artifactId", "keyId"]) {
    if (typeof context[field] !== "string" || !context[field].length || Buffer.byteLength(context[field], "utf8") > 1024 || /[\u0000-\u001f\u007f]/.test(context[field])) throw failure();
  }
  // An ordered JSON array encodes field boundaries without separator ambiguity.
  const aad = Buffer.from(JSON.stringify([DOMAIN, context.storeId, context.artifactId, context.version, context.keyId]), "utf8");
  const key = Buffer.from(hkdfSync("sha256", context.key, Buffer.alloc(0), Buffer.from(DOMAIN), 32));
  return { aad, key };
}

export function encryptContent(plaintext, context) {
  let key;
  try {
    if (!Buffer.isBuffer(plaintext) || plaintext.length > MAX_CONTENT_BYTES) throw failure();
    const derived = material(context);
    key = derived.key;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(derived.aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  } catch { throw failure(); }
  finally { key?.fill(0); }
}

export function decryptContent(envelope, context) {
  let key;
  let pending;
  try {
    if (!Buffer.isBuffer(envelope) || envelope.length < HEADER_BYTES || envelope.length > HEADER_BYTES + MAX_CONTENT_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) throw failure();
    const derived = material(context);
    key = derived.key;
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(8, 20));
    decipher.setAAD(derived.aad);
    decipher.setAuthTag(envelope.subarray(20, HEADER_BYTES));
    pending = decipher.update(envelope.subarray(HEADER_BYTES));
    const final = decipher.final();
    return Buffer.concat([pending, final]);
  } catch { throw failure(); }
  finally { key?.fill(0); pending?.fill(0); }
}
