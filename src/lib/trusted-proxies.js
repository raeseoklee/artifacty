import { isIP } from "node:net";
import { normalizeAllowedNetworks, isAddressAllowed } from "./network-policy.js";
export function trustedProxyNetworks(value = process.env.ARTIFACTY_TRUSTED_PROXIES || "") {
  try { return normalizeAllowedNetworks(value); }
  catch { throw Object.assign(new Error("Invalid ARTIFACTY_TRUSTED_PROXIES: expected IP addresses or CIDRs"), { code: "INVALID_TRUSTED_PROXIES" }); }
}
// Returned when a trusted proxy forwards a chain that cannot identify the client.
// It is not an IP address, so a non-empty network policy denies it, and such
// requests share one rate-limit bucket instead of taking the proxy's identity.
export const UNRESOLVED_CLIENT_ADDRESS = "unresolved-proxy-client";
const MAX_FORWARDED_LENGTH = 8192;
const MAX_FORWARDED_ENTRIES = 100;

export function clientAddress(request, trusted = []) {
  const peer = request.socket?.remoteAddress;
  if (!trusted.length || !isAddressAllowed(peer, trusted)) return peer;
  const header = request.headers?.["x-forwarded-for"];
  if (header === undefined) return peer;
  if (typeof header !== "string" || header.length > MAX_FORWARDED_LENGTH) return UNRESOLVED_CLIENT_ADDRESS;
  const addresses = header.split(",").map(value => value.trim());
  if (addresses.length > MAX_FORWARDED_ENTRIES) return UNRESOLVED_CLIENT_ADDRESS;
  // Only entries appended by trusted proxies are reliable, so read from the
  // right and stop at the first untrusted address. Anything further left is
  // client-supplied and must not affect the result, even when it is malformed.
  for (let index = addresses.length - 1; index >= 0; index--) {
    const address = addresses[index];
    if (address.includes("%") || !isIP(address)) return UNRESOLVED_CLIENT_ADDRESS;
    if (!isAddressAllowed(address, trusted)) return address;
  }
  return peer;
}
