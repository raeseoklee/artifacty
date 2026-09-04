import { createHash, timingSafeEqual } from "node:crypto";

const TOKEN_HEADER = "x-artifacty-token";

export const TOKEN_SCOPES = ["read", "write", "admin"];
const DEFAULT_TOKEN_SCOPES = ["read", "write"];

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

// Bundle artifacts (roadmap section 17: Document Assets in Bundles) inline
// binary file/asset payloads as base64 text. Scanning that base64 blob for
// secret patterns is both wasteful and prone to false positives, so when
// content is bundle JSON, only its text-bearing fields (title, text, file
// names/paths, and non-binary file contents) are scanned. Any other content
// (including non-JSON and non-bundle JSON) is scanned in full, unchanged.
export function extractSecretScanText(content) {
  const text = String(content ?? "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== "object" || parsed.artifactType !== "bundle") {
    return text;
  }

  const parts = [];
  if (typeof parsed.title === "string") {
    parts.push(parsed.title);
  }
  if (typeof parsed.text === "string") {
    parts.push(parsed.text);
  }
  if (Array.isArray(parsed.files)) {
    for (const file of parsed.files) {
      if (!file || typeof file !== "object") {
        continue;
      }
      if (typeof file.path === "string") {
        parts.push(file.path);
      }
      if (typeof file.name === "string") {
        parts.push(file.name);
      }
      if (file.encoding !== "base64" && typeof file.content === "string") {
        parts.push(file.content);
      }
    }
  }
  if (Array.isArray(parsed.assets)) {
    for (const asset of parsed.assets) {
      if (!asset || typeof asset !== "object") {
        continue;
      }
      if (typeof asset.name === "string") {
        parts.push(asset.name);
      }
      if (typeof asset.caption === "string") {
        parts.push(asset.caption);
      }
      if (asset.encoding !== "base64" && typeof asset.data === "string") {
        parts.push(asset.data);
      }
    }
  }
  return parts.join("\n");
}

export function assertNoSecrets(input = {}, options = {}) {
  const findings = scanForSecrets(extractSecretScanText(input.content));
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

// Derives the artifact-visibility access context (userId, role, anonymous)
// from an authenticated request. A shared ARTIFACTY_API_TOKEN (or no auth at
// all before login) has no personal identity. It is admin-equivalent for
// server administration routes elsewhere, but for artifact visibility it is
// scoped like any other anonymous team principal and cannot see private
// artifacts.
export function accessContext(request, currentUser) {
  const auth = request.artifactyAuth;
  const user = currentUser || auth?.user || null;
  if (user) {
    return { userId: user.id, role: user.role, anonymous: false };
  }
  return { userId: null, role: null, anonymous: true };
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

// Validates and normalizes a requested scope list for a personal API token.
// `admin` is only permitted when the owning user has the admin role.
export function normalizeTokenScopes(requested, { userRole = "user" } = {}) {
  const scopes = Array.isArray(requested) && requested.length > 0
    ? [...new Set(requested)]
    : [...DEFAULT_TOKEN_SCOPES];
  for (const scope of scopes) {
    if (!TOKEN_SCOPES.includes(scope)) {
      throw Object.assign(new Error(`Unsupported token scope: ${scope}`), {
        code: "INVALID_TOKEN_SCOPE",
        statusCode: 400
      });
    }
    if (scope === "admin" && userRole !== "admin") {
      throw Object.assign(new Error("The admin scope requires an admin user"), {
        code: "INVALID_TOKEN_SCOPE",
        statusCode: 400
      });
    }
  }
  return scopes;
}

// A request authenticated by the shared ARTIFACTY_API_TOKEN, a browser
// session, or run with no auth configured at all (single-user/no-token
// mode) always has full scopes. Only a personal `api-token` auth carries a
// scopes list that can be narrower than that.
export function effectiveScopes(auth) {
  if (auth?.type === "api-token" && Array.isArray(auth.scopes)) {
    return auth.scopes;
  }
  return TOKEN_SCOPES;
}

export function requireScope(auth, scope) {
  if (!scope) {
    return;
  }
  if (!effectiveScopes(auth).includes(scope)) {
    throw Object.assign(new Error(`Token is missing required scope: ${scope}`), {
      code: "scope_denied",
      statusCode: 403,
      scope
    });
  }
}

// Fixed-window rate limiter keyed by (principal, bucket). Each bucket has
// its own limit; a bucket with no configured limit (<= 0 or missing) is
// never limited. Purely in-memory and per-process, which matches the
// single-process Artifacty server model.
const RATE_LIMITER_SWEEP_EVERY_N_CHECKS = 1000;
const RATE_LIMITER_MAX_BUCKETS = 10000;

export function createRateLimiter({ windowMs = 60000, limits = {} } = {}) {
  const buckets = new Map();
  let checksSinceSweep = 0;

  // Every expired window is normally just overwritten in place by the next
  // check() for that same key, which never reclaims memory for principals
  // that stop calling entirely. Sweep out stale entries periodically (every
  // RATE_LIMITER_SWEEP_EVERY_N_CHECKS calls) and opportunistically whenever
  // the map has grown past RATE_LIMITER_MAX_BUCKETS, so an attacker minting
  // a fresh key per request (e.g. a spoofable principal) cannot grow this
  // map without bound.
  function sweepExpired(now) {
    for (const [key, entry] of buckets) {
      if (now - entry.windowStart >= windowMs) {
        buckets.delete(key);
      }
    }
    // An attacker minting a fresh principal per request within a single
    // window creates entries that are never expired, so the sweep above
    // frees nothing against that pattern. Once the map is still over the
    // cap after sweeping, evict the oldest entries by windowStart until
    // back under the cap so this check stays O(cap) instead of degrading
    // to unbounded growth under the exact attack it exists to defend
    // against.
    if (buckets.size > RATE_LIMITER_MAX_BUCKETS) {
      const entries = [...buckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      const excess = buckets.size - RATE_LIMITER_MAX_BUCKETS;
      for (let i = 0; i < excess; i += 1) {
        buckets.delete(entries[i][0]);
      }
    }
  }

  return {
    windowMs,
    check(principal, bucket) {
      const limit = limits[bucket];
      if (!Number.isFinite(limit) || limit <= 0) {
        return { allowed: true };
      }
      const now = Date.now();
      checksSinceSweep += 1;
      if (checksSinceSweep >= RATE_LIMITER_SWEEP_EVERY_N_CHECKS || buckets.size > RATE_LIMITER_MAX_BUCKETS) {
        checksSinceSweep = 0;
        sweepExpired(now);
      }
      const key = `${bucket}:${principal}`;
      let entry = buckets.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        entry = { windowStart: now, count: 0 };
        buckets.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > limit) {
        const retryAfterMs = windowMs - (now - entry.windowStart);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      return { allowed: true };
    },
    // Test/diagnostic helper: number of tracked (bucket, principal) keys.
    bucketCount() {
      return buckets.size;
    }
  };
}

// Rate limiting is disabled by default on loopback binds (local, single-user
// use should not be throttled) unless explicitly forced on, and can always
// be disabled outright.
export function rateLimitEnabled({ host, env = process.env } = {}) {
  const mode = env.ARTIFACTY_RATE_LIMIT;
  if (mode === "off") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  return !isLoopbackHost(host);
}

export function rateLimitFromEnv(env = process.env) {
  return {
    write: parsePositiveInt(env.ARTIFACTY_RATE_WRITE_PER_MIN, 120),
    auth: parsePositiveInt(env.ARTIFACTY_RATE_AUTH_PER_MIN, 10),
    search: parsePositiveInt(env.ARTIFACTY_RATE_SEARCH_PER_MIN, 300)
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
