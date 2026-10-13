import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { uiIcon } from '../src/lib/ui-icons.js';

test('local control CSS and sidebar asset support GET and HEAD without external resources', async t => {
  const home=await mkdtemp(path.join(tmpdir(),'artifacty-controls-'));
  const app=await startServer({home,port:0});
  t.after(async()=>{await app.close();await rm(home,{recursive:true,force:true});});
  for(const [asset,type] of [['ui-controls.css','text/css'],['sidebar.js','text/javascript']]) {
    const response=await fetch(`${app.url}/assets/${asset}`);
    assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok((await response.text()).length>0);
    const head=await fetch(`${app.url}/assets/${asset}`,{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(await head.text(),'');
  }
  const css=await readFile(new URL('../src/client/ui-controls.css',import.meta.url),'utf8');
  assert.match(css,/\.btn-primary/);assert.match(css,/\.form-control/);
  assert.doesNotMatch(css,/@import|url\(["']?https?:/);
});
test('UI icons use a fixed local allowlist and cannot inject attributes',()=>{
  assert.match(uiIcon('sun'),/aria-hidden="true"/);
  assert.match(uiIcon('moon',{size:'" onload="bad'}),/width="18"/);
  assert.throws(()=>uiIcon('constructor'));assert.throws(()=>uiIcon('<script>'));
});
