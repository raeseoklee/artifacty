import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { renderDashboard, renderAdminUsersPage } from '../src/lib/render.js';
const source=readFileSync(new URL('../src/client/sidebar.js',import.meta.url),'utf8');
function browser(value,blocked=false) {
 const root={},events={},storageEvents={},collapse={},expand={},button={hidden:true,dataset:{collapseLabel:'Collapse',expandLabel:'Expand'},attrs:{},setAttribute(k,v){this.attrs[k]=v;},querySelector:s=>s.includes('collapse')?collapse:expand,addEventListener(k,fn){this[k]=fn;}};
 const store={value,getItem(){if(blocked)throw Error();return this.value;},setItem(k,v){if(blocked)throw Error();assert.equal(k,'artifacty_sidebar');this.value=v;}};
 vm.runInNewContext(source,{localStorage:store,document:{documentElement:{setAttribute:(k,v)=>root[k]=v,removeAttribute:k=>delete root[k]},querySelectorAll:()=>[button],addEventListener:(k,fn)=>events[k]=fn},window:{addEventListener:(k,fn)=>storageEvents[k]=fn}});
 return {root,events,storageEvents,button,store,collapse,expand};
}
test('sidebar restores only valid collapsed preference and controls stay hidden until JS readiness',()=>{
 for(const saved of ['collapsed','expanded','invalid',null]) {const b=browser(saved);assert.equal(b.root['data-sidebar'],saved==='collapsed'?'collapsed':undefined);assert.equal(b.button.hidden,true);b.events.DOMContentLoaded();assert.equal(b.button.hidden,false);assert.equal(b.button.attrs['aria-expanded'],String(saved!=='collapsed'));}
});
test('sidebar toggle works with blocked storage and labels follow state',()=>{
 const b=browser('collapsed',true);b.events.DOMContentLoaded();b.button.click();assert.equal(b.root['data-sidebar'],'collapsed');assert.equal(b.button.title,'Expand');assert.equal(b.collapse.hidden,true);b.button.click();assert.equal(b.button.attrs['aria-expanded'],'true');
});
test('sidebar persists its choice and synchronizes other tabs',()=>{
 const b=browser();b.events.DOMContentLoaded();b.button.click();assert.equal(b.store.value,'collapsed');b.store.value='expanded';b.storageEvents.storage({key:'artifacty_sidebar'});assert.equal(b.root['data-sidebar'],undefined);
});
test('icon navigation remains named and theme icon buttons retain translated labels',()=>{
 const html=renderDashboard({artifacts:[],baseUrl:'http://localhost',locale:'ko',user:{role:'admin'}});
 assert.match(html,/data-sidebar-toggle hidden aria-expanded="true" aria-label="사이드바 접기"/);
 assert.match(html,/aria-label="아티팩트"[^>]*><svg/);
 assert.match(html,/data-theme-choice="dark"[^>]*aria-label="다크"[^>]*><svg/);
 assert.match(html,/:focus-visible\) .workspace-nav-label/);
});
test('user actions distinguish primary creation, neutral saves, and reset actions',()=>{
 const html=renderAdminUsersPage({baseUrl:'http://localhost',user:{id:'a',role:'admin'},users:[{id:'b',email:'b@example.com',role:'user',active:true}]});
 assert.match(html,/class="btn btn-primary">Create user/);
 assert.match(html,/class="btn btn-outline-secondary">Save/);
 assert.match(html,/class="btn btn-ghost">Reset password/);
 assert.match(html,/class="btn btn-outline-danger">Disable/);
});
