import assert from "node:assert/strict";
import test from "node:test";
import { createI18n, DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../src/lib/i18n.js";

// Section 8 (Dashboard Filters and Saved Views) introduces filter, saved-view,
// review-status, and grouping strings. This checks every key it added is
// translated (not just falling back to the English default or the raw key)
// in every supported locale.
const SECTION_8_KEYS = [
  "filter.publisher",
  "filter.createdAfter",
  "filter.createdBefore",
  "filter.artifactTypeAny",
  "filter.reviewStatusAny",
  "filter.groupByNone",
  "filter.groupBy.artifactType",
  "filter.groupBy.sourceAgent",
  "filter.groupBy.day",
  "reviewStatus.none",
  "reviewStatus.pending",
  "reviewStatus.changes-requested",
  "reviewStatus.approved",
  "dashboard.groupUnknown",
  "views.title",
  "views.empty",
  "views.shared",
  "views.delete",
  "views.save",
  "views.namePlaceholder"
];

test("SUPPORTED_LOCALES includes en and ko, with en as the default", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.ok(SUPPORTED_LOCALES.includes("en"));
  assert.ok(SUPPORTED_LOCALES.includes("ko"));
});

test("every Section 8 i18n key is translated in every supported locale", () => {
  const translators = SUPPORTED_LOCALES.map((locale) => createI18n(locale));

  for (const key of SECTION_8_KEYS) {
    for (const t of translators) {
      const value = t.t(key);
      assert.notEqual(value, key, `expected a translation for "${key}" in locale "${t.locale}", got the raw key back`);
      assert.ok(value.length > 0, `expected a non-empty translation for "${key}" in locale "${t.locale}"`);
    }
  }
});

test("Section 8 translations differ between en and ko (not just copy-pasted English)", () => {
  const en = createI18n("en");
  const ko = createI18n("ko");

  const identical = SECTION_8_KEYS.filter((key) => en.t(key) === ko.t(key));
  assert.deepEqual(identical, [], "expected every Section 8 key to have a distinct Korean translation");
});

test("createI18n falls back to the default locale for an unsupported locale", () => {
  const fallback = createI18n("fr");
  assert.equal(fallback.locale, DEFAULT_LOCALE);
  assert.equal(fallback.t("views.title"), createI18n("en").t("views.title"));
});
