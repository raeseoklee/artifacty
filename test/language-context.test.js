import test from "node:test";
import assert from "node:assert/strict";
import { runWithLanguageSettings, createI18n, resolveLocale, availableLanguages, enabledLocales, defaultLocale, localeFromUrl, localizedHref } from "../src/lib/i18n.js";

const japanese = { defaultLocale: "ja", enabledLocales: ["en", "ja"], packs: [{ locale: "ja", nativeName: "日本語", messages: { "nav.artifacts": "アーティファクト" } }] };

test("installed packs extend translations and disabled languages fall back to the administrator default", () => {
  runWithLanguageSettings(japanese, () => {
    assert.equal(defaultLocale(), "ja");
    assert.deepEqual(enabledLocales(), ["en", "ja"]);
    assert.equal(resolveLocale("ko"), "ja");
    assert.equal(resolveLocale("JA"), "ja");
    assert.equal(createI18n("ja").t("nav.artifacts"), "アーティファクト");
    assert.equal(createI18n("ja").t("nav.import"), createI18n("en").t("nav.import"));
    assert.equal(availableLanguages().find(language => language.locale === "ko").enabled, false);
    assert.equal(availableLanguages().find(language => language.locale === "ja").nativeName, "日本語");
    assert.equal(localeFromUrl(new URL("http://localhost/")), "ja");
    assert.equal(localizedHref("/account", "en"), "/account?lang=en");
  });
  assert.equal(defaultLocale(), "en");
  assert.equal(resolveLocale("ja"), "en");
});

test("concurrent stores keep their language catalogs isolated across asynchronous requests", async () => {
  const korean = { defaultLocale: "ko", enabledLocales: ["ko"], packs: [] };
  const results = await Promise.all([japanese, korean].map(settings => runWithLanguageSettings(settings, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return { locale: defaultLocale(), title: createI18n().t("nav.artifacts") };
  })));
  assert.deepEqual(results, [{ locale: "ja", title: "アーティファクト" }, { locale: "ko", title: "아티팩트" }]);
  assert.equal(createI18n().locale, "en");
});
