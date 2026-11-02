import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContent, renderExplainerDraftPage, renderArtifactPage, renderSharedArtifactPage } from '../src/lib/render.js';

const item = (id, extra = {}) => ({ id, label: `Label ${id}`, explanation: 'A readable explanation.', basis: 'interpretation', ...extra });
const model = {
  schemaVersion: 1, goal: 'Understand the tradeoff', summary: 'A simple overview.', limitations: ['Authored examples only.'],
  blocks: [
    { id: 'steps', title: 'Follow the flow', type: 'steps', items: [item('first', { basis: 'source', citation: 'Section 1' }), item('second')] },
    { id: 'compare', title: 'Compare approaches', type: 'compare', items: [item('a'), item('b')] },
    { id: 'diagram', title: 'Explore the components', type: 'diagram', items: [item('a'), item('b')], connections: [{ from: 'a', to: 'b', label: 'requests' }] },
    { id: 'scenarios', title: 'Inspect scenarios', type: 'scenarios', parameter: { label: 'Batch size', unit: 'items' }, items: [item('small', { value: 1 }), item('large', { value: 10, basis: 'assumption' })] }
  ]
};
const version = { version: 1, format: 'explainer', sizeBytes: 100, createdAt: '2026-10-30T00:00:00Z', sha256: 'a'.repeat(64), metadata: {} };
const artifact = { id: 'sample', title: 'A useful explanation', sourceAgent: 'artifacty', latestVersion: 1, versions: [version], version, visibility: 'private', tags: ['teaching'], artifactType: 'document', relations: { outgoing: [], incoming: [] } };

test('explainer renders each mode with safe native controls and no-JavaScript content', () => {
  const html = renderContent('explainer', JSON.stringify(model));
  for (const mode of ['steps', 'compare', 'diagram', 'scenarios']) assert.ok(html.includes(`data-explainer-block="${mode}"`));
  assert.ok(html.includes('data-explainer-controls hidden'));
  assert.ok(html.includes('data-explainer-edge data-from="0" data-to="1"'));
  assert.ok(html.includes('data-explainer-range'));
  assert.ok(html.includes('No values are interpolated'));
  assert.ok(html.includes('Source-based'));
  assert.ok(html.includes('Section 1'));
  assert.ok(html.includes('<h4>Limitations</h4>'));
  assert.doesNotMatch(html, /data-explainer-item="\d+" hidden/);
  assert.doesNotMatch(html, /<script|<iframe|onclick=/);
});

test('explainer escapes untrusted text and attributes', () => {
  const unsafe = structuredClone(model);
  unsafe.goal = '<script>alert(1)</script>';
  unsafe.blocks[0].items[0].explanation = '<img src=x onerror=alert(1)>';
  unsafe.blocks[0].items[0].citation = '" onclick="steal()';
  const html = renderContent('explainer', JSON.stringify(unsafe));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.doesNotMatch(html, /<script|<img| onclick="/);
});

test('explainer supports Korean and safe public-share interactivity', () => {
  const html = renderSharedArtifactPage({ artifact, version, content: JSON.stringify(model), locale: 'ko', sharePath: '/s/token' });
  assert.ok(html.includes('인터랙티브 설명'));
  assert.ok(html.includes('/assets/explainers.js'));
  assert.ok(html.includes('data-explainer-range'));
  assert.doesNotMatch(html, /allow-scripts|sourceId/);
});

test('draft form preserves source version and offers progressive friendly editing', () => {
  const html = renderExplainerDraftPage({ artifact, draft: model, baseUrl: 'http://localhost', draftTitle: 'Custom name' });
  assert.ok(html.includes('action="/artifacts/sample/explain"'));
  assert.ok(html.includes('name="sourceVersion" value="1"'));
  assert.ok(html.includes('name="title" required maxlength="500" value="Custom name"'));
  assert.ok(html.includes('data-explainer-editor-fields'));
  assert.ok(html.includes('name="content" rows="20" required'));
  assert.ok(html.includes('Create private explainer'));
});

test('edit form preserves metadata and optimistic version guard', () => {
  const html = renderExplainerDraftPage({ artifact, draft: model, mode: 'edit', expectedVersion: 3 });
  assert.ok(html.includes('action="/artifacts/sample/edit"'));
  assert.ok(html.includes('name="expectedVersion" value="3"'));
  assert.ok(html.includes('name="tags" value="teaching"'));
  assert.ok(html.includes('name="artifactType" value="document"'));
  assert.ok(html.includes('Edit explanation'));
  assert.doesNotMatch(html, /name="sourceVersion"/);
});

test('viewer prioritizes explanation and offers creation for readers of other formats', () => {
  const html = renderArtifactPage({ artifact, version, content: JSON.stringify(model), baseUrl: 'http://localhost' });
  assert.ok(html.includes('<details class="collection-management">'));
  assert.ok(html.indexOf('</div></details>\n        <article class="explainer"') > 0);
  assert.doesNotMatch(html, /href="\/artifacts\/sample\/explain/);
  const sourceVersion = { ...version, format: 'markdown' };
  const source = renderArtifactPage({ artifact, version: sourceVersion, content: '# Source', user: { id: 'reader', role: 'user' }, permission: 'read' });
  assert.ok(source.includes('/artifacts/sample/explain?version=1'));
});

test('source link pins the selected explanation version without exposing restricted relations', () => {
  const linked = structuredClone(artifact);
  linked.relations.outgoing.push({ relation: 'derived-from', artifactId: 'source', sourceVersion: 4, artifact: { title: 'Original source' } });
  const pinned = { ...version, metadata: { explainerSourceVersion: 4 } };
  const html = renderArtifactPage({ artifact: linked, version: pinned, content: JSON.stringify(model) });
  assert.ok(html.includes('href="/artifacts/source?version=4"'));
  linked.relations.outgoing[0].restricted = true;
  const restricted = renderArtifactPage({ artifact: linked, version: pinned, content: JSON.stringify(model) });
  assert.ok(!restricted.includes('/artifacts/source'));
});

test('interactive flow uses an isolated generated Mermaid frame and authored navigation', () => {
  const value = structuredClone(model);
  value.blocks[2].diagram = { direction: 'LR', start: 'a' };
  value.blocks[2].items[0].label = '</script><img src=x onerror=alert(1)>"';
  value.blocks[2].connections[0].label = '';
  const output = renderContent('explainer', JSON.stringify(value));
  assert.match(output, /data-explainer-flow/);
  assert.match(output, /sandbox="allow-scripts"/);
  assert.doesNotMatch(output, /allow-same-origin/);
  assert.match(output, /data-flow-branches/);
  assert.match(output, /data-flow-start="0"/);
  assert.doesNotMatch(output, /<img src=x/);
  const frame = output.match(/srcdoc="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  assert.match(frame, /edge.label\?/);
  assert.match(frame, /event.source!==parent/);
  assert.doesNotMatch(frame, /<img src=x/);
  const script = frame.match(/<script type="module">([\s\S]*)<\/script>/)[1].replace(/^import .*;$/m,'');
  // Compile the exact frame script to catch template escaping regressions.
  assert.doesNotThrow(() => new (Object.getPrototypeOf(async function(){}).constructor)(script));
});
