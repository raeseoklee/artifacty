import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, openDatabase } from "../src/lib/storage.js";
import { exportStoreToString, importStoreFromString } from "../src/lib/backup.js";
import { getLanguageSettings, saveLanguageSettings, importLanguagePack } from "../src/lib/language-settings.js";
import { TRANSLATIONS } from "../src/lib/i18n.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-language-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return createStore({ home });
}
const french = { locale: "fr", nativeName: "Français", messages: { "media.image": "Image", "media.encoding": "encodage : {encoding}" } };

test("language defaults honor the existing built-in locale environment without persisting on reads", async (t) => {
  const store = await fixture(t);
  const before = process.env.ARTIFACTY_LOCALE;
  t.after(() => { if (before === undefined) delete process.env.ARTIFACTY_LOCALE; else process.env.ARTIFACTY_LOCALE = before; });
  for (const [env, expected] of [["ko", "ko"], ["fr", "en"], ["", "en"]]) {
    process.env.ARTIFACTY_LOCALE = env;
    assert.deepEqual(await getLanguageSettings(store), { defaultLocale: expected, enabledLocales: ["en", "ko"], packs: [] });
  }
  const db = openDatabase(store);
  try { assert.equal(db.prepare("SELECT value FROM meta WHERE key='language_settings'").get(), undefined); } finally { db.close(); }
});

test("imports are disabled initially, settings preserve packs, and replacement preserves enabled defaults", async (t) => {
  const store = await fixture(t);
  const imported = await importLanguagePack(store, { ...french, locale: "FR" });
  assert.deepEqual(imported.enabledLocales, ["en", "ko"]);
  assert.equal(imported.packs[0].locale, "fr");
  await saveLanguageSettings(store, { defaultLocale: "fr", enabledLocales: ["en", "fr"] });
  const replaced = await importLanguagePack(store, { ...french, nativeName: "Français nouveau" });
  assert.equal(replaced.packs.length, 1);
  assert.equal(replaced.defaultLocale, "fr");
  assert.deepEqual(replaced.enabledLocales, ["en", "fr"]);
  const db = openDatabase(store);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action IN ('language-settings-change', 'language-pack-import')").get().count, 3); } finally { db.close(); }
});

test("invalid packs and settings cannot replace a valid catalog", async (t) => {
  const store = await fixture(t);
  await importLanguagePack(store, french);
  const before = await getLanguageSettings(store);
  for (const pack of [null, [], { ...french, locale: "en" }, { ...french, locale: "bad_locale" }, { ...french, nativeName: " " },
    { ...french, messages: { unknown: "bad" } }, { ...french, messages: { "media.image": "" } },
    { ...french, messages: { "media.image": "x".repeat(4001) } }, { ...french, messages: { "media.encoding": "missing" } },
    { ...french, messages: { "media.encoding": "{encoding} {unexpected}" } }, { ...french, messages: { "media.image": () => "code" } }]) {
    await assert.rejects(importLanguagePack(store, pack), { statusCode: 400 });
  }
  for (const settings of [{ defaultLocale: "fr", enabledLocales: [] }, { defaultLocale: "fr", enabledLocales: ["en"] },
    { defaultLocale: "fr", enabledLocales: ["fr", "FR"] }, { defaultLocale: "de", enabledLocales: ["de"] }]) {
    await assert.rejects(saveLanguageSettings(store, settings), { statusCode: 400 });
  }
  assert.deepEqual(await getLanguageSettings(store), before);
});

test("pack byte and installed-pack limits are enforced", async (t) => {
  const store = await fixture(t);
  const messages = Object.fromEntries(Object.entries(TRANSLATIONS.en).filter(([, value]) => !value.includes("{")).slice(0, 180).map(([key]) => [key, "x".repeat(4000)]));
  await assert.rejects(importLanguagePack(store, { ...french, messages }), { statusCode: 400 });
  for (let index = 0; index < 16; index++) await importLanguagePack(store, { locale: `fr-x-${index}`, nativeName: `Pack ${index}`, messages: {} });
  await assert.rejects(importLanguagePack(store, french), { statusCode: 400 });
  assert.equal((await getLanguageSettings(store)).packs.length, 16);
});

test("corrupt persisted settings fail clearly and cannot be overwritten by a new import", async (t) => {
  const store = await fixture(t);
  const db = openDatabase(store);
  try { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('language_settings', ?)").run('{"broken":true}'); } finally { db.close(); }
  await assert.rejects(getLanguageSettings(store), { code: "CORRUPT_LANGUAGE_SETTINGS", statusCode: 500 });
  await assert.rejects(importLanguagePack(store, french), { code: "CORRUPT_LANGUAGE_SETTINGS" });
  const check = openDatabase(store);
  try { assert.equal(check.prepare("SELECT value FROM meta WHERE key='language_settings'").get().value, '{"broken":true}'); } finally { check.close(); }
});

test("full backup preserves language packs and enabled default settings", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await importLanguagePack(source, french);
  const expected = await saveLanguageSettings(source, { defaultLocale: "fr", enabledLocales: ["fr"] });
  const exported = await exportStoreToString(source, { scope: "full" });
  await importStoreFromString(target, exported, { confirm: "replace-all" });
  assert.deepEqual(await getLanguageSettings(target), expected);
});

test("stored packs survive removed English keys and changed placeholders without hiding structural corruption", async (t) => {
  const store = await fixture(t);
  const messages = { "retired.translation.key": "Old text", "media.encoding": "Old {format}", "media.image": "Image" };
  const stored = { defaultLocale: "fr", enabledLocales: ["fr"], packs: [{ ...french, messages }] };
  const db = openDatabase(store);
  const serialized = JSON.stringify(stored);
  try { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('language_settings', ?)").run(serialized); } finally { db.close(); }
  const settings = await getLanguageSettings(store);
  assert.equal(settings.defaultLocale, "fr");
  assert.deepEqual(settings.packs[0].messages, { "media.image": "Image" });
  await assert.rejects(importLanguagePack(store, { ...french, messages }), { statusCode: 400 });
  const check = openDatabase(store);
  try {
    assert.equal(check.prepare("SELECT value FROM meta WHERE key='language_settings'").get().value, serialized, "Reading compatibility fallback must not rewrite stored data");
    stored.packs[0].messages["retired.translation.key"] = { code: "bad" };
    check.prepare("UPDATE meta SET value=? WHERE key='language_settings'").run(JSON.stringify(stored));
  } finally { check.close(); }
  await assert.rejects(getLanguageSettings(store), { code: "CORRUPT_LANGUAGE_SETTINGS" });
});
