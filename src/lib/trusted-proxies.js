import { isIP } from "node:net";
import { normalizeAllowedNetworks, isAddressAllowed } from "./network-policy.js";
export function trustedProxyNetworks(value = process.env.ARTIFACTY_TRUSTED_PROXIES || "") {
  try { return normalizeAllowedNetworks(value); }
  catch { throw Object.assign(new Error("Invalid ARTIFACTY_TRUSTED_PROXIES: expected IP addresses or CIDRs"), { code: "INVALID_TRUSTED_PROXIES" }); }
}
export function clientAddress(request, trusted = []) {
  const peer = request.socket?.remoteAddress;
  if (!trusted.length || !isAddressAllowed(peer, trusted)) return peer;
  const header = request.headers?.["x-forwarded-for"];
  if (typeof header !== "string" || header.length > 8192) return peer;
  const addresses = header.split(",").map(value => value.trim());
  if (!addresses.length || addresses.length > 100 || addresses.some(value => value.includes("%") || !isIP(value))) return peer;
  for (let index = addresses.length - 1; index >= 0; index--) {
    if (!isAddressAllowed(addresses[index], trusted)) return addresses[index];
  }
  return peer;
}
