import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithDisplaySettings } from '../src/lib/display-settings.js';
import { renderArtifactPage, renderAdminDisplayPage, renderAdminUpdatePage } from '../src/lib/render.js';
import { groupKeyFor } from '../src/lib/listing.js';

const createdAt = '2026-11-03T00:30:00.000Z';
const artifact = { id: 'display-fixture', title: 'Display fixture', tags: [], latestVersion: 1, versions: [{version:1,format:"text",createdAt}], createdAt, visibility: 'team' };
const version = { version: 1, format: 'text', createdAt, sha256: 'fixture', size: 5 };
test('browser timestamps follow display context and keep UTC machine values', () => {
  for (const timeZone of ['Asia/Seoul', 'America/Los_Angeles', 'UTC']) {
    const page = runWithDisplaySettings({ timeZone }, () => renderArtifactPage({ artifact, version, content: 'hello', baseUrl: 'http://localhost' }));
    const canonical = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
    const label = new Intl.DateTimeFormat('en', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(createdAt));
    assert.ok(page.includes(`${label} ${canonical}</time>`));
    assert.ok(page.includes(`datetime="${createdAt}"`));
    assert.match(page, /data-visibility/);
  }
});
test('browser day groups can use configured zone while API and CLI default to UTC', () => {
  assert.equal(groupKeyFor(artifact, 'day'), '2026-11-03');
  assert.equal(groupKeyFor(artifact, 'day', 'America/Los_Angeles'), '2026-11-02');
  assert.equal(groupKeyFor(artifact, 'day', 'Asia/Seoul'), '2026-11-03');
});
test('display settings opt into autosave and retain a no-JavaScript submit', () => {
  const page = renderAdminDisplayPage({ settings: { timeZone: 'Asia/Seoul' }, user: { id: 'admin', role: 'admin' }, baseUrl: 'http://localhost' });
  assert.match(page, /data-display-settings/);
  assert.match(page, /value="Asia\/Seoul" selected/);
  assert.match(page, /type="submit"/);
});
