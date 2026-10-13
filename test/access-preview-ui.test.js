import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAccessModePreviewPage, renderAdminAccessPage, renderDashboard } from '../src/lib/render.js';
const artifact = { id: 'a', title: '<Visible artifact>', tags: ['test'], sourceAgent: 'codex', format: 'text', artifactType: 'document', latestVersion: 1, visibility: 'team' };
const base = { baseUrl: 'http://localhost', user: { role: 'admin' }, artifacts: [artifact], anonymousArtifactCount: 3 };
for (const locale of ['en', 'ko']) {
  test(`public mode preview shows inert artifact rows and an unsaved banner (${locale})`, () => {
    const html = renderAccessModePreviewPage({ ...base, mode: 'public', locale });
    assert.match(html, /class="artifact-row"/);
    assert.match(html, /&lt;Visible artifact&gt;/);
    assert.doesNotMatch(html, /href="\/artifacts\/a|<form|href="\/new|href="\/import/);
    assert.match(html, /href="\/admin\/access\?mode=public/);
    assert.match(html, locale === 'ko' ? /설정은 저장되지 않았습니다/ : /Settings have not been saved/);
  });
}
test('private preview never renders supplied artifact rows or a real login action', () => {
  const html = renderAccessModePreviewPage({ ...base, mode: 'private' });
  assert.match(html, /Sign-in required/);
  assert.doesNotMatch(html, /&lt;Visible artifact&gt;|href="\/login|<form/);
});
test('dashboard retains artifact links and sharing settings put save in a separate footer', () => {
  assert.match(renderDashboard({ ...base }), /href="\/artifacts\/a"/);
  const html = renderAdminAccessPage({ ...base, mode: 'private', preview: { mode: 'public', anonymousArtifactCount: 3 } });
  assert.match(html, /value="public" checked/);
  assert.match(html, /action="\/admin\/access"/);
  const form = html.match(/<form class="editor-form" method="post" action="\/admin\/access\/share-links">([\s\S]*?)<\/form>/)[1];
  assert.match(form, /<\/label><footer class="editor-actions"><button/);
});
