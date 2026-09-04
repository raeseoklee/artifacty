// Webhook delivery for Artifacty change notifications (roadmap section 3).
// Storage owns the `webhooks` table (createWebhook/listWebhooks/deleteWebhook
// /recordWebhookDelivery in src/lib/storage.js); this module owns signing,
// SSRF guarding, and the retry loop, and wires itself to the in-process
// event bus via registerWebhookDispatcher().
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { sanitizeEventForDelivery, subscribe } from "./events.js";

const DEFAULT_RETRY_DELAYS_MS = [2000, 10000, 60000];
const MAX_CONSECUTIVE_FAILURES = 20;

/**
 * The signing key is derived from the stored secret hash rather than the
 * raw secret (which is shown once and never persisted in recoverable
 * form): `secretHash = sha256(secret)` is stored at creation time, and both
 * delivery and verification compute `HMAC-SHA256(key = secretHash, body)`.
 * A webhook consumer that keeps the raw secret they were shown re-derives
 * the same key with `sha256(secret)` before verifying. See
 * docs/threat-model.md.
 */
export function signPayload(secretHashHex, rawBody) {
  return createHmac("sha256", secretHashHex).update(rawBody).digest("hex");
}

/**
 * Rejects targets that are not http(s), or that resolve to loopback,
 * link-local, or private address literals, unless
 * ARTIFACTY_WEBHOOK_ALLOW_PRIVATE=true. This is a literal-address check
 * (no DNS resolution) — good enough to stop the common accidental/careless
 * cases without adding a DNS dependency; see docs/threat-model.md for the
 * residual risk of a hostname that resolves to a private address at
 * delivery time.
 */
export function assertPublicWebhookUrl(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE === "true";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw invalidWebhookUrl("Webhook url must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidWebhookUrl("Webhook url must use http or https");
  }
  if (allowPrivate) {
    return parsed;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isDisallowedHostname(hostname)) {
    throw invalidWebhookUrl(`Webhook url host is not allowed: ${hostname}`);
  }
  return parsed;
}

function invalidWebhookUrl(message) {
  return Object.assign(new Error(message), { code: "INVALID_WEBHOOK_URL", statusCode: 400 });
}

function isDisallowedHostname(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isDisallowedIpv6Host(hostname.slice(1, -1));
  }
  if (hostname.includes(":")) {
    return isDisallowedIpv6Host(hostname);
  }
  // Node's DNS/socket layer accepts every legacy inet_aton form (decimal,
  // octal, hex, and 1-3 part "shorthand" addresses like 127.1 or
  // 2130706433), not just four-part dotted-decimal, so a literal-address
  // check that only recognizes dotted-decimal can be bypassed by any of
  // those forms. Parse with the same semantics inet_aton uses so every form
  // that resolves to the same address is rejected identically. A hostname
  // that is not any legacy IPv4 literal form at all (i.e. an actual DNS
  // name) returns null here and is allowed through this check (subject to
  // whatever it resolves to at delivery time — see docs/threat-model.md).
  const ipv4Value = parseLegacyIpv4(hostname);
  if (ipv4Value !== null) {
    return isDisallowedIpv4Int(ipv4Value);
  }
  return false;
}

// Parses any legacy inet_aton-style IPv4 literal (1-4 dot-separated parts,
// each decimal, octal (0-prefixed), or hex (0x-prefixed), with the last
// part absorbing the remaining bytes) into its 32-bit unsigned value.
// Returns null when `hostname` is not this kind of literal at all.
function parseLegacyIpv4(hostname) {
  if (!/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)(\.(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)){0,3}$/i.test(hostname)) {
    return null;
  }
  const parts = hostname.split(".");
  const nums = parts.map(parseLegacyNumber);
  if (nums.some((value) => value === null)) {
    return null;
  }
  const lastIndex = nums.length - 1;
  for (let i = 0; i < lastIndex; i += 1) {
    if (nums[i] > 255) {
      return null;
    }
  }
  const lastMax = 256 ** (4 - lastIndex) - 1;
  if (nums[lastIndex] > lastMax) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < lastIndex; i += 1) {
    value += nums[i] * 256 ** (3 - i);
  }
  value += nums[lastIndex];
  return value;
}

function parseLegacyNumber(part) {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    return Number.parseInt(part, 16);
  }
  if (/^0[0-7]+$/.test(part)) {
    return Number.parseInt(part, 8);
  }
  if (/^0$/.test(part) || /^[1-9][0-9]*$/.test(part)) {
    return Number.parseInt(part, 10);
  }
  return null;
}

function isDisallowedIpv4Int(value) {
  const a = (value >>> 24) & 255;
  const b = (value >>> 16) & 255;
  const c = (value >>> 8) & 255;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this network" (covers 0.0.0.0)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
  return false;
}

// Expands `hostname` (an unbracketed IPv6 literal, possibly with a
// zone id and/or a trailing IPv4-mapped dotted-quad tail) into its 8
// 16-bit groups, or null if it is not a well-formed IPv6 literal at all.
function parseIpv6Groups(hostname) {
  let addr = hostname;
  const zoneIndex = addr.indexOf("%");
  if (zoneIndex !== -1) {
    addr = addr.slice(0, zoneIndex);
  }
  if (!addr) {
    return null;
  }
  if ((addr.match(/::/g) || []).length > 1) {
    return null;
  }

  const ipv4TailMatch = /(^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (ipv4TailMatch) {
    const dotted = ipv4TailMatch[2];
    const octets = dotted.split(".").map(Number);
    if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, addr.length - dotted.length)}${hi}:${lo}`;
  }

  let groups;
  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftParts = left ? left.split(":").filter((part) => part !== "") : [];
    const rightParts = right ? right.split(":").filter((part) => part !== "") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) {
      return null;
    }
    groups = [...leftParts, ...Array(missing).fill("0"), ...rightParts];
  } else {
    groups = addr.split(":");
  }

  if (groups.length !== 8) {
    return null;
  }
  const values = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
    values.push(Number.parseInt(group, 16));
  }
  return values;
}

function isDisallowedIpv6Host(hostname) {
  const groups = parseIpv6Groups(hostname);
  if (!groups) {
    // Not a well-formed IPv6 literal despite looking like one (contains a
    // ":"). Fail closed rather than letting an unparseable host through.
    return true;
  }
  if (groups.every((value, index) => (index < 7 ? value === 0 : value === 1))) {
    return true; // ::1 loopback
  }
  if (groups.every((value) => value === 0)) {
    return true; // :: unspecified
  }
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    // IPv4-mapped ::ffff:0:0/96 - validate the embedded IPv4 address too.
    const byte0 = (groups[6] >>> 8) & 0xff;
    const byte1 = groups[6] & 0xff;
    const byte2 = (groups[7] >>> 8) & 0xff;
    const byte3 = groups[7] & 0xff;
    const ipv4Value = ((byte0 * 256 + byte1) * 256 + byte2) * 256 + byte3;
    return isDisallowedIpv4Int(ipv4Value);
  }
  return false;
}

/**
 * Deliver one webhook payload with bounded retries. `delaysMs` is
 * injectable so tests can run the retry loop without real sleeps.
 * `fetchImpl` is injectable for tests that stub network calls.
 */
export async function deliverWebhook({ webhook, event, delaysMs = DEFAULT_RETRY_DELAYS_MS, fetchImpl = fetch, sleep = defaultSleep }) {
  // One delivery id for the whole delivery (body and every retry's header),
  // so a receiver deduplicating on x-artifacty-delivery sees retries of the
  // same delivery as the same delivery, not a new one each time.
  const deliveryId = randomUUID();
  const body = JSON.stringify({ delivery: deliveryId, event: sanitizeEventForDelivery(event), webhookId: webhook.id });
  const attempts = [null, ...delaysMs];
  let lastError = null;
  let lastStatus = null;
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const delay = attempts[attempt];
    if (delay) {
      await sleep(delay);
    }
    try {
      const signature = signPayload(webhook.secretHash, body);
      const response = await fetchImpl(webhook.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-artifacty-event": event.type,
          "x-artifacty-delivery": deliveryId,
          "x-artifacty-signature": `sha256=${signature}`
        },
        body,
        signal: AbortSignal.timeout(webhookTimeoutMs())
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, attempts: attempt + 1 };
      }
      lastError = new Error(`Webhook delivery received status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, status: lastStatus, error: lastError?.message || "delivery failed", attempts: attempts.length };
}

function webhookTimeoutMs() {
  const parsed = Number.parseInt(process.env.ARTIFACTY_WEBHOOK_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Subscribes to the in-process event bus and delivers matching events to
 * every enabled webhook in `store`. Returns an unsubscribe function.
 * `deps` lets tests inject storage functions and delivery options without
 * touching the real store/network.
 */
export function registerWebhookDispatcher(store, deps = {}) {
  const {
    listWebhooks,
    recordWebhookDelivery,
    insertWebhookFailureAudit,
    deliver = deliverWebhook,
    delaysMs
  } = deps;

  return subscribe({}, (event) => {
    dispatchEvent(store, event, { listWebhooks, recordWebhookDelivery, insertWebhookFailureAudit, deliver, delaysMs }).catch((error) => {
      process.stderr.write(`Artifacty webhook dispatch error: ${error.stack || error.message}\n`);
    });
  });
}

async function dispatchEvent(store, event, { listWebhooks, recordWebhookDelivery, insertWebhookFailureAudit, deliver, delaysMs }) {
  const webhooks = await listWebhooks(store, { enabledOnly: true });
  const matching = webhooks.filter((webhook) => matchesWebhook(webhook, event));
  // Deliver to every matching webhook concurrently so one slow or dead
  // endpoint (up to the retry backoff ceiling per delivery) cannot delay
  // delivery to every other webhook for the same event.
  await Promise.allSettled(matching.map((webhook) => deliverToWebhook(store, webhook, event, {
    recordWebhookDelivery,
    insertWebhookFailureAudit,
    deliver,
    delaysMs
  })));
}

async function deliverToWebhook(store, webhook, event, { recordWebhookDelivery, insertWebhookFailureAudit, deliver, delaysMs }) {
  const result = await deliver({ webhook, event, delaysMs });
  const disable = !result.ok && webhook.failureCount + 1 >= MAX_CONSECUTIVE_FAILURES;
  await recordWebhookDelivery(store, webhook.id, {
    ok: result.ok,
    status: result.status,
    disable
  });
  if (disable && insertWebhookFailureAudit) {
    await insertWebhookFailureAudit(store, webhook, event, result);
  }
}

function matchesWebhook(webhook, event) {
  if (Array.isArray(webhook.eventTypes) && webhook.eventTypes.length > 0 && !webhook.eventTypes.includes(event.type)) {
    return false;
  }
  const filter = webhook.filter || {};
  if (filter.artifactId && filter.artifactId !== event.artifactId) {
    return false;
  }
  if (filter.tag && !(Array.isArray(event.tags) && event.tags.includes(filter.tag))) {
    return false;
  }
  if (filter.sourceAgent && filter.sourceAgent !== event.sourceAgent) {
    return false;
  }
  return true;
}

export { MAX_CONSECUTIVE_FAILURES, DEFAULT_RETRY_DELAYS_MS };
