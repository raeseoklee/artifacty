import { AsyncLocalStorage } from "node:async_hooks";
import { ensureStore, openDatabase, transaction, insertAuditRow } from "./storage.js";

const displaySettings = new AsyncLocalStorage();
const invalid = () => Object.assign(new Error("Choose a valid IANA time zone, such as Asia/Seoul or UTC"), { code: "INVALID_DISPLAY_SETTINGS", statusCode: 400 });

function normalizeTimeZone(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /^[+-]/.test(value.trim())) throw invalid();
  try { return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone; }
  catch { throw invalid(); }
}

export function supportedDisplayTimeZones() {
  return ["UTC", ...Intl.supportedValuesOf("timeZone").filter(zone => zone !== "UTC")];
}

export function currentDisplayTimeZone() {
  return displaySettings.getStore()?.timeZone || "UTC";
}

export function runWithDisplaySettings(settings, action) {
  return displaySettings.run(Object.freeze({ timeZone: normalizeTimeZone(settings.timeZone) }), action);
}

function readSettings(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'display_settings'").get();
  if (!row) return { timeZone: "UTC" };
  try {
    const value = JSON.parse(row.value);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "timeZone")) throw invalid();
    return { timeZone: normalizeTimeZone(value.timeZone) };
  } catch (cause) {
    throw Object.assign(new Error("Stored display settings are invalid; repair or restore them before making changes", { cause }), { code: "CORRUPT_DISPLAY_SETTINGS", statusCode: 500 });
  }
}

async function withDatabase(store, action) {
  await ensureStore(store);
  const db = openDatabase(store);
  try { return action(db); } finally { db.close(); }
}

export async function getDisplaySettings(store) {
  return withDatabase(store, readSettings);
}

export async function saveDisplaySettings(store, input, { audit } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "timeZone")) throw invalid();
  const next = { timeZone: normalizeTimeZone(input.timeZone) };
  return withDatabase(store, db => transaction(db, () => {
    const previous = readSettings(db);
    if (previous.timeZone === next.timeZone) return next;
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('display_settings', ?)").run(JSON.stringify(next));
    insertAuditRow(db, { action: "display-settings-change", artifactId: "", audit, metadata: { previousTimeZone: previous.timeZone, timeZone: next.timeZone } });
    return next;
  }));
}
