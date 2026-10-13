import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenApiDocument, renderApiDocsHtml, buildCurlExample, schemaExample } from '../src/lib/openapi.js';
import { matchesOperation, enhanceApiDocs } from '../src/client/api-docs.js';
import { runWithLanguageSettings } from '../src/lib/i18n.js';
import { RELATION_TYPES, REVIEW_STATUSES } from '../src/lib/storage.js';

const spec = buildOpenApiDocument();
const request = (path) => spec.paths[path].post.requestBody.content['application/json'].example;

test('request examples use accepted operation inputs rather than response records', () => {
  assert.equal(request('/api/artifacts').format, 'markdown');
  assert.ok(request('/api/artifacts').content);
  assert.equal(request('/api/artifacts').id, undefined);
  assert.equal(request('/api/artifacts/{id}').expectedVersion, 1);
  assert.ok(RELATION_TYPES.includes(request('/api/artifacts/{id}/relations').relation));
  assert.ok(REVIEW_STATUSES.includes(request('/api/artifacts/{id}/review-status').status));
  assert.equal(request('/api/artifacts/{id}/review-status').reviewStatus, undefined);
  assert.equal(request('/api/admin/retention/run').dryRun, true);
  assert.equal(spec.paths['/api/artifacts/{id}/relations/{relationId}'].delete.responses['204'], undefined);
  assert.ok(spec.paths['/api/artifacts/{id}/relations/{relationId}'].delete.responses['200']);
  assert.equal(spec.paths['/api/webhooks'].post['x-artifacty-access'], 'admin');
});

function validate(schema, value) {
  if (schema.$ref) return validate(spec.components.schemas[schema.$ref.split('/').pop()], value);
  if (schema.allOf) for (const part of schema.allOf) validate(part, value);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.required) for (const key of schema.required) assert.ok(Object.hasOwn(value, key), key);
  if (schema.type === 'array') { assert.ok(Array.isArray(value)); for (const item of value) validate(schema.items, item); }
  else if (schema.type && !Array.isArray(schema.type)) assert.equal(typeof value, schema.type === 'integer' ? 'number' : schema.type);
  for (const [key, item] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) validate(item, value[key]);
}

test('rendered schema-derived response examples satisfy their declared schemas', () => {
  for (const methods of Object.values(spec.paths)) for (const operation of Object.values(methods)) {
    for (const response of Object.values(operation.responses)) {
      const schema = response.content?.['application/json']?.schema;
      if (schema) validate(schema, schemaExample(schema, spec.components.schemas));
    }
    const media = operation.requestBody?.content?.['application/json'];
    if (media?.example) validate(media.schema, media.example);
  }
});

test('docs are localized, escaped, usable without JS, and share persisted theme', () => {
  const html = renderApiDocsHtml({ locale: 'ko', baseUrl: "https://example.test/'><script>alert(1)</script>" });
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /요청 예제/);
  assert.match(html, /<details class="operation"/);
  assert.match(html, /data-search-controls hidden/);
  assert.match(html, /data-copy hidden/);
  assert.match(html, /\/assets\/api-docs.js/);
  assert.ok(html.indexOf('/assets/theme.js') < html.indexOf('<style>'));
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /Try it/i);
});

test('curl substitutes path values, required query, bearer placeholder, and shell-quotes apostrophes', () => {
  const operation = spec.paths['/artifacts/{id}/export'].get;
  const curl = buildCurlExample({ baseUrl: "https://example.test/a'b", apiPath: '/artifacts/{id}/export', method: 'get', operation });
  assert.match(curl, /a'\\''b\/artifacts\/artifact-example\/export\?format=csv/);
  assert.match(curl, /Bearer YOUR_API_TOKEN/);
  assert.doesNotMatch(curl, /\{id\}/);
  assert.ok(curl.includes(' \\\n'));
});

test('search filters by every token and actual client copy handles clipboard failures', async () => {
  assert.equal(matchesOperation('GET /api/artifacts List artifacts', 'GET artifacts'), true);
  assert.equal(matchesOperation('GET /api/artifacts', 'post artifacts'), false);
  const listeners = {};
  const button = { hidden: true, parentElement: { querySelector: () => ({ textContent: 'curl example' }) }, addEventListener: (event, handler) => { listeners[event] = handler; } };
  const status = {};
  const document = { body: { dataset: { copySuccess: 'copied', copyFailure: 'failed' } }, querySelector: (selector) => selector === '[data-copy-status]' ? status : null, querySelectorAll: (selector) => selector === '[data-copy]' ? [button] : [] };
  let copied;
  enhanceApiDocs(document, { writeText: async (value) => { copied = value; } });
  assert.equal(button.hidden, false);
  await listeners.click();
  assert.equal(copied, 'curl example');
  assert.equal(status.textContent, 'copied');
  enhanceApiDocs(document, { writeText: async () => { throw new Error('denied'); } });
  await listeners.click();
  assert.equal(status.textContent, 'failed');
});


test('language selector follows enabled custom packs and administrator default', () => {
  const settings = { defaultLocale: 'ja', enabledLocales: ['en', 'ja'], packs: [{ locale: 'ja', nativeName: '日本語', messages: { 'apiDocs.title': 'API リファレンス' } }] };
  const html = runWithLanguageSettings(settings, () => renderApiDocsHtml({ currentPath: '/docs/api?tag=one&tag=two&q=%22hello%22&lang=ko#schemas' }));
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /<option value="ja" selected>日本語<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
  assert.doesNotMatch(html, /<option value="ko"/);
  assert.match(html, /method="get" action="\/docs\/api#schemas"/);
  assert.match(html, /name="tag" value="one"/);
  assert.match(html, /name="tag" value="two"/);
  assert.match(html, /name="q" value="&quot;hello&quot;"/);
  assert.doesNotMatch(html, /type="hidden" name="lang"/);
  const disabled = runWithLanguageSettings(settings, () => renderApiDocsHtml({ locale: 'ko' }));
  assert.match(disabled, /<html lang="ja">/);
});


test('API controls use the local shared Bootstrap stylesheet after page styles', () => {
  const html = renderApiDocsHtml();
  assert.ok(html.indexOf('/assets/ui-controls.css') > html.indexOf('</style>'));
  assert.match(html, /class="form-control" id="api-search"/);
  assert.match(html, /class="form-select" name="lang"/);
  assert.match(html, /class="btn btn-outline-secondary btn-sm" type="button" data-copy/);
  assert.match(html, /class="btn btn-outline-secondary" href="\/openapi.json"/);
  assert.match(html, /class="btn btn-outline-secondary" type="submit"/);
  assert.doesNotMatch(html, /<link[^>]+href="https?:/);
});
