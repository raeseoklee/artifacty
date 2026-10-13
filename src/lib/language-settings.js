import { TRANSLATIONS } from "./i18n.js";
import { ensureStore, openDatabase, transaction, insertAuditRow } from "./storage.js";

const BUILTINS = ["en", "ko"];
// Bound individual uploads and the combined persisted catalog separately.
const MAX_PACK_BYTES = 512 * 1024;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const invalid = (message) => Object.assign(new Error(message), { code: "INVALID_LANGUAGE_SETTINGS", statusCode: 400 });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function localeCode(value) {
  if (typeof value !== "string" || value.length > 35 || !value) throw invalid("A valid locale of at most 35 characters is required");
  try { return Intl.getCanonicalLocales(value)[0].toLowerCase(); }
  catch { throw invalid("Invalid language locale"); }
}

function byteLimit(value, maximum) {
  let text;
  try { text = JSON.stringify(value); } catch { throw invalid("Language settings must be JSON data"); }
  if (!text || Buffer.byteLength(text, "utf8") > maximum) throw invalid("Language data exceeds the size limit");
}

function placeholders(text) {
  return [...new Set([...text.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))].sort().join("\0");
}

function validatePack(pack, { stored = false } = {}) {
  if (!object(pack) || Object.keys(pack).some((key) => !["locale", "nativeName", "messages"].includes(key))) throw invalid("A language pack requires locale, nativeName and messages");
  byteLimit(pack, MAX_PACK_BYTES);
  const locale = localeCode(pack.locale);
  if (BUILTINS.includes(locale)) throw invalid("Built-in languages cannot be replaced");
  if (typeof pack.nativeName !== "string" || !pack.nativeName.trim() || pack.nativeName.length > 80) throw invalid("Language name must contain 1 to 80 characters");
  if (!object(pack.messages)) throw invalid("Language messages must be a JSON object");
  const messages = {};
  for (const [key, value] of Object.entries(pack.messages)) {
    if (typeof value !== "string" || !value.trim() || value.length > 4000) throw invalid(`Translation must contain 1 to 4000 characters: ${key}`);
    // Catalogs can outlive the application dictionary. Ignore obsolete entries
    // on reads, so changed keys/placeholders fall back to the current English.
    // Imports stay strict to catch mistakes in newly submitted packs.
    if (!Object.hasOwn(TRANSLATIONS.en, key)) {
      if (stored) continue;
      throw invalid(`Unknown translation key: ${key}`);
    }
    if (placeholders(value) !== placeholders(TRANSLATIONS.en[key])) {
      if (stored) continue;
      throw invalid(`Translation placeholders must match English: ${key}`);
    }
    messages[key] = value;
  }
  return { locale, nativeName: pack.nativeName.trim(), messages };
}

function validateSettings(value, options = {}) {
  if (!object(value) || !Array.isArray(value.packs) || value.packs.length > 16) throw invalid("At most 16 custom language packs are allowed");
  const packs = value.packs.map((pack) => validatePack(pack, options));
  const installed = new Set([...BUILTINS, ...packs.map((pack) => pack.locale)]);
  if (installed.size !== BUILTINS.length + packs.length) throw invalid("Duplicate language packs are not allowed");
  if (!Array.isArray(value.enabledLocales) || !value.enabledLocales.length) throw invalid("Enable at least one language");
  const enabledLocales = value.enabledLocales.map(localeCode);
  if (new Set(enabledLocales).size !== enabledLocales.length || enabledLocales.some((locale) => !installed.has(locale))) throw invalid("Enabled languages must be installed and unique");
  const defaultLocale = localeCode(value.defaultLocale);
  if (!enabledLocales.includes(defaultLocale)) throw invalid("The default language must be enabled");
  const settings = { defaultLocale, enabledLocales, packs };
  byteLimit(settings, MAX_SETTINGS_BYTES);
  return settings;
}

function readSettings(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'language_settings'").get();
  if (!row) {
    const configured = String(process.env.ARTIFACTY_LOCALE || "").toLowerCase();
    return { defaultLocale: BUILTINS.includes(configured) ? configured : "en", enabledLocales: [...BUILTINS], packs: [] };
  }
  try {
    if (Buffer.byteLength(row.value, "utf8") > MAX_SETTINGS_BYTES) throw invalid("Stored language data exceeds the size limit");
    return validateSettings(JSON.parse(row.value), { stored: true });
  }
  catch (cause) { throw Object.assign(new Error("Stored language settings are invalid; repair or restore them before making changes", { cause }), { code: "CORRUPT_LANGUAGE_SETTINGS", statusCode: 500 }); }
}

async function withDatabase(store, action) {
  await ensureStore(store);
  const db = openDatabase(store);
  try { return action(db); } finally { db.close(); }
}

export async function getLanguageSettings(store) {
  return withDatabase(store, readSettings);
}

function save(db, settings, action, audit, metadata) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('language_settings', ?)").run(JSON.stringify(settings));
  insertAuditRow(db, { action, artifactId: "", audit, metadata });
  return settings;
}

export async function saveLanguageSettings(store, input, { audit } = {}) {
  if (!object(input)) throw invalid("Language settings must be an object");
  return withDatabase(store, (db) => transaction(db, () => {
    const current = readSettings(db);
    const next = validateSettings({ defaultLocale: input.defaultLocale, enabledLocales: input.enabledLocales, packs: current.packs });
    return save(db, next, "language-settings-change", audit, { defaultLocale: next.defaultLocale, enabledLocales: next.enabledLocales });
  }));
}

export async function importLanguagePack(store, input, { audit } = {}) {
  const pack = validatePack(input);
  return withDatabase(store, (db) => transaction(db, () => {
    const current = readSettings(db);
    const packs = current.packs.filter((entry) => entry.locale !== pack.locale);
    const next = validateSettings({ ...current, packs: [...packs, pack] });
    return save(db, next, "language-pack-import", audit, { locale: pack.locale, messageCount: Object.keys(pack.messages).length });
  }));
}
