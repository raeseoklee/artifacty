import { createHash, timingSafeEqual } from "node:crypto";

const TOKEN_HEADER = "x-artifacty-token";

const SECRET_PATTERNS = [
  { type: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: "openai-api-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { type: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { type: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { type: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { type: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { type: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
];

export function securityConfig(options = {}) {
  return {
    apiToken: options.apiToken || process.env.ARTIFACTY_API_TOKEN || "",
    shareMode: options.shareMode || process.env.ARTIFACTY_SHARE_MODE || "local",
    allowSecrets: Boolean(options.allowSecrets || process.env.ARTIFACTY_ALLOW_SECRETS === "true")
  };
}

export function validateServerExposure({ host, config = securityConfig() }) {
  const local = isLoopbackHost(host);
  if (local) {
    return;
  }
  if (!["lan", "team"].includes(config.shareMode)) {
    throw new Error("Non-local host requires ARTIFACTY_SHARE_MODE=lan or team");
  }
  if (!config.apiToken) {
    throw new Error("Non-local host requires ARTIFACTY_API_TOKEN");
  }
}

export function exposureWarning({ host, config = securityConfig() }) {
  if (isLoopbackHost(host)) {
    return "";
  }
  return [
    `Warning: Artifacty is listening on ${host} in ${config.shareMode} share mode.`,
    "HTTP is not encrypted by Artifacty; use only a trusted LAN/VPN or place it behind TLS.",
    "Prefer x-artifacty-token or Authorization headers for scripts, and keep React rendering disabled unless every viewer trusts the artifact source."
  ].join(" ");
}

export function requireToken({ request, url, body = {}, config = securityConfig() }) {
  if (!config.apiToken) {
    return;
  }
  const provided = extractToken({ request, url, body });
  if (!tokensEqual(provided, config.apiToken)) {
    throw Object.assign(new Error("Artifacty API token required"), {
      code: "AUTH_REQUIRED",
      statusCode: 401
    });
  }
}

export function requestToken({ request, url, body = {} }) {
  return extractToken({ request, url, body });
}

export function scanForSecrets(content) {
  const text = String(content ?? "");
  const findings = [];
  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      findings.push({
        type,
        index: match.index,
        preview: redactSecret(match[0])
      });
      match = pattern.exec(text);
    }
  }
  return findings;
}

export function assertNoSecrets(input = {}, options = {}) {
  const findings = scanForSecrets(input.content);
  const allowSecrets =
    options.allowSecrets ||
    input.allowSecrets === true ||
    input.metadata?.secretScan?.allowSecrets === true;

  if (findings.length > 0 && !allowSecrets) {
    throw Object.assign(new Error(`Secret scan blocked artifact content: ${findings.map((finding) => finding.type).join(", ")}`), {
      code: "SECRET_DETECTED",
      statusCode: 400,
      findings
    });
  }

  return {
    status: findings.length > 0 ? "allowed" : "passed",
    findingCount: findings.length,
    findings: findings.map((finding) => ({
      type: finding.type,
      preview: finding.preview
    }))
  };
}

export function tokensEqual(provided, expected) {
  const providedText = String(provided ?? "");
  const expectedText = String(expected ?? "");
  const providedDigest = createHash("sha256").update(providedText).digest();
  const expectedDigest = createHash("sha256").update(expectedText).digest();
  return timingSafeEqual(providedDigest, expectedDigest) &&
    Buffer.byteLength(providedText) === Buffer.byteLength(expectedText);
}

export function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "";
}

function extractToken({ request, url, body }) {
  const authorization = request.headers.authorization || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers[TOKEN_HEADER] ||
    url.searchParams.get("token") ||
    body._token ||
    "";
}

function redactSecret(value) {
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
