import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TRANSLATIONS, createI18n } from '../src/lib/i18n.js';
import { renderLoginPage, renderAccountPage, renderPasswordPage, renderAdminUsersPage, renderAdminBackupPage, renderContent, renderSharedArtifactPage } from '../src/lib/render.js';

test('English and Korean dictionaries have identical keys and placeholders', () => {
  assert.deepEqual(Object.keys(TRANSLATIONS.en).sort(), Object.keys(TRANSLATIONS.ko).sort());
  for (const key of Object.keys(TRANSLATIONS.en)) {
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(TRANSLATIONS.en[key]), placeholders(TRANSLATIONS.ko[key]), key);
  }
});
const user = { id: 'admin', role: 'admin', name: 'Original User', email: 'user@example.com' };
const props = { user, baseUrl: 'http://localhost', locale: 'ko' };
test('account and administration forms localize labels without translating submitted identifiers', () => {
  assert.match(renderLoginPage({ ...props, setup: true }), /관리자 계정 만들기/);
  const account = renderAccountPage({ ...props, tokens: [{ id: 't', name: 'Original Token', createdAt: '2026-01-02T03:04:00Z' }] });
  assert.match(account, /토큰 만들기/); assert.match(account, /Original Token/);
  assert.match(account, /datetime="2026-01-02T03:04:00Z"/); assert.match(account, /UTC<\/time>/);
  assert.match(renderPasswordPage(props), /현재 비밀번호/);
  const users = renderAdminUsersPage(props);
  assert.match(users, /value="admin">관리자/); assert.match(users, /CSV에서 사용자 가져오기/);
  const backup = renderAdminBackupPage({ ...props, integrity: { ok: true, store: '/tmp', artifactCount: 1, versionCount: 1, totalBytes: 3 } });
  assert.match(backup, /백업 복원/); assert.match(backup, /name="forceUsers"/);
  assert.match(renderLoginPage({ baseUrl: 'http://localhost' }), /Sign in/);
});
function view(locale) { const { t } = createI18n(locale); return { locale, raw: t, text: t }; }
test('CSV, SARIF and notebook notices translate while original artifact content survives', () => {
  assert.match(renderContent('csv', '', {}, { view: view('ko') }), /비어 있습니다/);
  assert.match(renderContent('csv', 'Name\nOriginal text', {}, { view: view('ko') }), /Original text/);
  assert.match(renderContent('sarif', 'not-json', {}, { view: view('ko') }), /올바른 SARIF JSON/);
  assert.match(renderContent('sarif', 'not-json'), /Invalid SARIF JSON/);
  const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 0, metadata: {}, cells: [{ cell_type: 'code', source: 'print("Original")', metadata: {}, outputs: [{ output_type: 'display_data', data: { 'application/custom': 'x' } }] }] });
  assert.match(renderContent('notebook', notebook, {}, { view: view('ko') }), /지원하지 않는 출력 형식/);
});
test('public share viewer carries inert translated client messages and no account navigation', () => {
  const html = renderSharedArtifactPage({ artifact: { title: 'Original', artifactType: 'document' }, version: { format: 'csv', version: 1 }, content: 'Name\nOriginal', locale: 'ko', sharePath: '/s/token' });
  const config = html.match(/id="artifacty-viewer-i18n">([^<]*)<\/script>/);
  assert.equal(JSON.parse(config[1]).filter, '필터');
  assert.doesNotMatch(html, /class="workspace-header"/);
});
test('viewer client falls back to English and applies Korean interpolation', () => {
  const source = readFileSync(new URL('../src/client/viewer.js', import.meta.url), 'utf8');
  const messages = source.slice(source.indexOf('const viewerMessages'), source.indexOf('const viewerTheme'));
  for (const config of ['', '{invalid', '{"filterColumn":"{column}열 필터"}']) {
    const context = { document: { getElementById: () => ({ textContent: config }) } };
    vm.createContext(context); vm.runInContext(messages, context);
    assert.equal(vm.runInContext('viewerText("filterColumn", { column: 2 })', context), config.includes('열') ? '2열 필터' : 'Filter column 2');
  }
});

test('rendered viewer configuration preserves placeholders through client interpolation', () => {
  const source = readFileSync(new URL('../src/client/viewer.js', import.meta.url), 'utf8');
  const clientMessages = source.slice(source.indexOf('const viewerMessages'), source.indexOf('const viewerTheme'));
  for (const locale of ['en', 'ko']) {
    const html = renderSharedArtifactPage({ artifact: { title: 'Original', artifactType: 'document' }, version: { format: 'csv', version: 1 }, content: 'Name\nOriginal', locale, sharePath: '/s/token' });
    const config = html.match(/id="artifacty-viewer-i18n">([^<]*)<\/script>/)[1];
    const parsed = JSON.parse(config);
    assert.match(parsed.filterColumn, /\{column\}/);
    assert.match(parsed.rowsShown, /\{visible\}/);
    assert.match(parsed.rowsShown, /\{total\}/);
    const context = { document: { getElementById: () => ({ textContent: config }) } };
    vm.createContext(context);
    vm.runInContext(clientMessages, context);
    assert.equal(vm.runInContext('viewerText("filterColumn", { column: 2 })', context), locale === 'ko' ? '2열 필터' : 'Filter column 2');
    assert.equal(vm.runInContext('viewerText("rowsShown", { visible: 3, total: 5 })', context), locale === 'ko' ? '전체 5행 중 3행 표시' : '3 of 5 rows shown');
    assert.equal(vm.runInContext('viewerText("resultsShown", { visible: 3, total: 5 })', context), locale === 'ko' ? '전체 5개 결과 중 3개 표시' : '3 of 5 results shown');
  }
});
