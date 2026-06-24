import { randomBytes } from "node:crypto";

export function generateToken(options = {}) {
  const bytes = normalizeTokenBytes(options.bytes);
  const token = randomBytes(bytes).toString("base64url");
  return {
    token,
    bytes,
    env: `ARTIFACTY_API_TOKEN=${quoteShellValue(token)}`,
    header: `x-artifacty-token: ${token}`,
    authorization: `Authorization: Bearer ${token}`
  };
}

export function normalizeTokenBytes(value) {
  const bytes = Number(value ?? 32);
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new Error("--bytes must be an integer between 16 and 128");
  }
  return bytes;
}

function quoteShellValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
