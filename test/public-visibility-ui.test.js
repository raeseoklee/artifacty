import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNewArtifactPage, renderDashboard } from '../src/lib/render.js';
for(const locale of ['en','ko']) test(`visibility selector exposes explicit public while retaining team default (${locale})`,()=>{
  const html=renderNewArtifactPage({baseUrl:'http://localhost',locale});
  const select=html.match(/<select name="visibility"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(select,/value="private"/);assert.match(select,/value="team" selected/);assert.match(select,/value="public"/);
  assert.match(html,locale==='ko'?/서버가 프라이빗 모드이면/:/Private server mode always requires/);
  const row=renderDashboard({baseUrl:'http://localhost',locale,artifacts:[{id:'public',title:'Original',visibility:'public',tags:[],sourceAgent:'codex',latestVersion:1}]});
  assert.match(row,locale==='ko'?/class="badge v-public">전체 공개/:/class="badge v-public">Public/);
});
