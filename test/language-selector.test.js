import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithLanguageSettings } from '../src/lib/i18n.js';
import { renderDashboard, renderAdminLanguagesPage, renderAdminRetentionPage } from '../src/lib/render.js';

const settings = { defaultLocale: 'en', enabledLocales: ['en', 'fr'], packs: [{ locale: 'fr', nativeName: 'Français <test>', messages: {} }, { locale: 'de', nativeName: 'Deutsch', messages: {} }] };
const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])]));

test('language selector uses enabled native names and preserves all non-language page state', () => {
  const html = runWithLanguageSettings(settings, () => renderDashboard({ artifacts: [], baseUrl: 'http://localhost', locale: 'fr', currentPath: '/artifacts/a?version=2&q=%22hello%22&tag=one&tag=two&lang=ko&lang=en#comments' }));
  const match = html.match(/<form class="language-switcher"([^>]*)>([\s\S]*?)<\/form>/);
  assert.equal(attributes(match[1]).action, '/artifacts/a#comments');
  assert.equal(attributes(match[1]).method, 'get');
  const hidden = [...match[2].matchAll(/<input\b[^>]*>/g)].map(item => attributes(item[0]));
  assert.deepEqual(hidden.map(item => [item.name, item.value]), [['version','2'], ['q','"hello"'], ['tag','one'], ['tag','two']]);
  assert.match(match[2], /value="en">English/);
  assert.match(match[2], /value="fr" selected>Français &lt;test&gt;/);
  assert.doesNotMatch(match[2], /value="ko"|value="de"|onchange=/);
  assert.match(match[2], /<button type="submit"[^>]*>Apply<\/button>/);
});

test('language administration includes disabled installed packs and explicit import guidance', () => {
  const html = runWithLanguageSettings(settings, () => renderAdminLanguagesPage({ settings, user: { role: 'admin' }, baseUrl: 'http://localhost', locale: 'en', error: '<unsafe>' }));
  assert.match(html, /name="enabledLocales" value="de"[^>]*> Deutsch/);
  assert.match(html, /name="enabledLocales" value="fr" checked/);
  assert.match(html, /name="defaultLocale"/);
  assert.match(html, /action="\/admin\/languages\/import"/);
  assert.match(html, /name="pack" maxlength="524288"/);
  assert.match(html, /href="\/admin\/languages\/template"/);
  assert.match(html, /Keep placeholders such as \{count\} unchanged/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test('language settings navigation remains administrator-only', () => {
  for (const [user, expected] of [[null,false], [{ role: 'user' },false], [{ role: 'admin' },true]]) {
    const html = renderDashboard({ artifacts: [], baseUrl: 'http://localhost', user });
    assert.equal(html.includes('href="/admin/languages"'), expected);
  }
});

test('retention separates duration controls, full-width type rules, and history without changing field names', () => {
  const html = renderAdminRetentionPage({ baseUrl: 'http://localhost', locale: 'ko', policy: { archiveAfterDays: { default: 30, byType: { 'test-report': 7 } }, purgeArchivedAfterDays: 90, auditRetentionDays: 180, eventRetentionRows: 1000, keepTags: ['pinned'] } });
  const form = html.match(/<form class="editor-form retention-policy-form"[^>]*>([\s\S]*?)<\/form>/)[1];
  assert.equal((form.match(/class="retention-section"/g) || []).length, 3);
  for (const name of ['archiveAfterDaysDefault','archiveAfterDaysByType','purgeArchivedAfterDays','auditRetentionDays','eventRetentionRows','keepTags']) assert.match(form, new RegExp(`name="${name}"`));
  assert.match(form, /아티팩트 유형별 규칙/); assert.match(form, /감사 로그와 이벤트 기록/);
  assert.match(form, /test-report=7/);
});
