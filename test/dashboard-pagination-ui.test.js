import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard } from '../src/lib/render.js';
const decode = value => value.replaceAll('&quot;','"').replaceAll('&amp;','&');
const render = (options={}) => renderDashboard({artifacts:[],baseUrl:'http://localhost',...options});
test('pagination stays visible on empty and single-page lists with disabled boundaries',()=>{
 for(const total of [0,1,50]) {
  const html=render({pagination:{total,limit:50,offset:0,previousOffset:null,nextOffset:null}});
  const section=html.match(/<section class="dashboard-pagination">([\s\S]*?)<\/section>/)[1];
  assert.match(section,/Page 1 of 1/);assert.equal((section.match(/aria-disabled="true"/g)||[]).length,2);
  assert.match(section,/value="50" selected/);assert.match(section,/name="offset" value="0"/);
 }
});
test('page size and page links preserve duplicate query values, language, and current filters',()=>{
 const html=render({locale:'ko',currentPath:'/?q=%22term%22&tag=one&tag=two&limit=25&offset=25&lang=ko#list',filters:{query:'"term"',tag:'one',relation:'depends-on',relatedTo:'a'},pagination:{total:60,limit:25,offset:25,previousOffset:0,nextOffset:50}});
 const section=html.match(/<section class="dashboard-pagination">([\s\S]*?)<\/section>/)[1];
 assert.match(section,/3페이지 중 2페이지/);
 const next=new URL(decode(section.match(/rel="next" href="([^"]+)"/)[1]),'http://localhost');
 assert.deepEqual(next.searchParams.getAll('tag'),['one','two']);assert.equal(next.searchParams.get('offset'),'50');assert.equal(next.searchParams.get('limit'),'25');assert.equal(next.searchParams.get('lang'),'ko');assert.equal(next.searchParams.get('relation'),'depends-on');assert.equal(next.hash,'#list');
 const form=section.match(/<form class="page-size-form"[^>]*>([\s\S]*?)<\/form>/)[1];
 assert.equal((form.match(/name="tag"/g)||[]).length,2);assert.equal((form.match(/name="offset"/g)||[]).length,1);assert.equal((form.match(/name="limit"/g)||[]).length,1);
 assert.doesNotMatch(form,/onchange|value="25" name="offset"/);
 for(const size of [10,25,50,100]) assert.match(form,new RegExp(`value="${size}"`));
 assert.match(form,/name="offset" value="0"/);
});
test('last page disables next and nonstandard valid existing limit remains selected',()=>{
 const html=render({pagination:{total:230,limit:200,offset:200,previousOffset:0,nextOffset:null}});
 assert.match(html,/Page 2 of 2/);assert.match(html,/value="200" selected/);assert.doesNotMatch(html,/rel="next"/);assert.match(html,/rel="prev"/);
});
