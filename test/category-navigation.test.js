import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCategoryNavigation } from '../src/lib/category-ui.js';
import { categoryArtifactIds, addCategoryArtifacts } from '../src/client/categories.js';

test('category navigation is private to signed-in users and escapes its initial context', () => {
  const view = { currentPath:'/?categoryId=research', raw:key=>key, text:key=>key, href:value=>value };
  assert.equal(renderCategoryNavigation({user:null,view}), '');
  const html = renderCategoryNavigation({user:{id:'user"<script>'},view});
  assert.match(html, /data-category-selected="research"/);
  assert.match(html, /data-category-user="user&quot;&lt;script&gt;"/);
  assert.match(html, /href="\/categories"/);
  assert.doesNotMatch(html, /<script>/);
});

test('drag selection ignores malformed entries, deduplicates and bounds batch size', () => {
  assert.deepEqual(categoryArtifactIds(null), []);
  assert.deepEqual(categoryArtifactIds(['a','a',null,1,'','b']), ['a','b']);
  assert.equal(categoryArtifactIds(Array.from({length:150},(_,i)=>String(i))).length,100);
});

test('adding category memberships preserves existing memberships and offers undo only for new additions', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({url,options}); return {ok:true,json:async()=>({changed:url.endsWith('/new')})}; };
  const result = await addCategoryArtifacts(fetcher,'team/category',['old','new','new']);
  assert.deepEqual(result, {added:['new'],failed:[]});
  assert.equal(calls.length,2);
  assert.ok(calls.every(({url,options})=>url.startsWith('/api/categories/team%2Fcategory/artifacts/')&&options.method==='PUT'&&options.credentials==='same-origin'));
});

test('failed category additions preserve successful additions and never remove anything', async () => {
  const result = await addCategoryArtifacts(async url => {
    if (url.endsWith('/denied')) return {ok:false};
    if (url.endsWith('/network')) throw new Error('network');
    return {ok:true,json:async()=>({changed:true})};
  },'c',['ok','denied','network']);
  assert.deepEqual(result,{added:['ok'],failed:['denied','network']});
});

test('older membership responses do not offer destructive undo', async () => {
  const result = await addCategoryArtifacts(async()=>({ok:true,json:async()=>({present:true})}),'c',['a']);
  assert.deepEqual(result,{added:[],failed:[]});
});

function fakeNode(tag = 'div') {
  return { tagName: tag.toUpperCase(), dataset: {}, children: [], attributes: {}, listeners: {}, hidden: false,
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    classList: { add() {}, remove() {} }
  };
}
function navigationFixture() {
  const makeNavigation = () => {
    const navigation = fakeNode('details');
    navigation.dataset = { categoryUser: 'u', categoryMessages: JSON.stringify({personal:'Personal',teams:'Teams',added:'Added {count} to {name}',undone:'Undone',choose:'Add',saving:'Saving'}), categoryHome:'/', categorySelected:'' };
    navigation.fields = { '[data-category-tree]':fakeNode(), '[data-category-nav-status]':fakeNode('p'), '[data-category-undo]':fakeNode('button') };
    navigation.querySelector = selector => navigation.fields[selector];
    return navigation;
  };
  const navigations = [makeNavigation(), makeNavigation()];
  const row = fakeNode('article'); row.dataset.categoryArtifactId = 'a';
  const document = { location:{href:'https://example.test/'}, createElement:fakeNode, querySelectorAll:selector => selector === '[data-category-navigation]' ? navigations : selector === '[data-category-artifact-id]' ? [row] : [] };
  return {document,navigations,row};
}

test('desktop and mobile trees hydrate once and share addition and undo state', async () => {
  const { enhanceCategoryNavigation } = await import('../src/client/categories.js');
  const {document,navigations,row} = navigationFixture();
  const calls=[];
  await enhanceCategoryNavigation(document, async (url, options) => {
    calls.push({url,options});
    return {ok:true,json:async()=>url==='/api/categories'?{categories:[{id:'c',name:'Research',scope:'personal'}]}:{changed:true}};
  }, null);
  assert.equal(calls.length,1);
  for (const nav of navigations) assert.equal(nav.fields['[data-category-tree]'].children[0].children[1].textContent,'Research');
  assert.equal(row.children.length,1,'fallback select is only installed once');
  const select=row.children[0].children[1];select.value='c';await select.listeners.change();
  for (const nav of navigations) {
    assert.equal(nav.fields['[data-category-nav-status]'].textContent,'Added 1 to Research');
    assert.equal(nav.fields['[data-category-undo]'].hidden,false);
  }
  await navigations[1].fields['[data-category-undo]'].listeners.click();
  assert.equal(calls.filter(call=>call.options?.method==='DELETE').length,1);
  for (const nav of navigations) assert.equal(nav.fields['[data-category-undo]'].hidden,true);
});

test('blocked browser storage does not prevent category navigation', async (t) => {
  const { enhanceCategoryNavigation } = await import('../src/client/categories.js');
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('Blocked');}});
  t.after(()=>previous?Object.defineProperty(globalThis,'localStorage',previous):delete globalThis.localStorage);
  const {document,navigations}=navigationFixture();
  await enhanceCategoryNavigation(document,async()=>({ok:true,json:async()=>({categories:[]})}));
  assert.ok(navigations.every(nav=>nav.fields['[data-category-tree]'].children.length>0));
});

test('the 101st selected artifact is rejected with an explicit limit message', async () => {
  const { enhanceCategoryNavigation } = await import('../src/client/categories.js');
  const fixture=navigationFixture();
  const checkboxes=Array.from({length:101},(_,index)=>Object.assign(fakeNode('input'),{checked:index<100}));
  for (const nav of fixture.navigations) {
    const messages=JSON.parse(nav.dataset.categoryMessages);messages.selectionLimit='Select up to 100 artifacts.';nav.dataset.categoryMessages=JSON.stringify(messages);
  }
  const previous=fixture.document.querySelectorAll;
  fixture.document.querySelectorAll=selector=>selector==='[data-category-selected-artifact]'?checkboxes:selector==='[data-category-selected-artifact]:checked'?checkboxes.filter(input=>input.checked):previous(selector);
  await enhanceCategoryNavigation(fixture.document,async()=>({ok:true,json:async()=>({categories:[]})}),null);
  checkboxes[100].checked=true;checkboxes[100].listeners.change();
  assert.equal(checkboxes[100].checked,false);
  assert.equal(checkboxes.filter(input=>input.checked).length,100);
  for (const nav of fixture.navigations) assert.equal(nav.fields['[data-category-nav-status]'].textContent,'Select up to 100 artifacts.');
});
