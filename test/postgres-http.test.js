import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/server.js';
import { createStore, createUser, createSession, createApiToken, createArtifact, getArtifact, checkStoreIntegrity, listEventsSince, addComment, transaction } from '../src/lib/storage.js';
import { createCategory, setCategoryArtifact, listCategories } from '../src/lib/categories.js';
import { exportStoreToString, importStoreFromString } from '../src/lib/backup.js';
const exec=promisify(execFile);
const url=process.env.ARTIFACTY_TEST_POSTGRES_URL;

test('PostgreSQL HTTP permissions, categories, histories and cross-backend full backup', {skip:!url,timeout:120000}, async()=>{
  const {Client}=await import('pg');
  const schema='test_http_'+randomBytes(6).toString('hex');
  const targetSchema=schema+'_restore';
  const restoredHome=await mkdtemp(path.join(tmpdir(),'artifacty-pg-restored-'));
  const home=await mkdtemp(path.join(tmpdir(),'artifacty-pg-http-'));
  const sqliteHome=await mkdtemp(path.join(tmpdir(),'artifacty-pg-sqlite-'));
  let app;
  try {
    app=await startServer({home,port:0,databaseUrl:url,databaseSchema:schema});
    assert.equal((await (await fetch(app.url+'/health')).json()).databaseBackend,'postgres');
    const admin=await createUser(app.store,{email:'admin@example.test',password:'Demo-password-2026',role:'admin'});
    const reader=await createUser(app.store,{email:'reader@example.test',password:'Demo-password-2026',role:'user'});
    const access={userId:admin.id,role:'admin'};
    const session=await createSession(app.store,admin.id);
    const token=await createApiToken(app.store,admin.id,{name:"Integration",scopes:["read","write","admin"]});
    const cookie=`artifacty_session=${session.token}`;
    const authorization=`Bearer ${token.token}`;
    const created=await fetch(app.url+'/api/artifacts',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({title:'PostgreSQL guide',format:'markdown',content:'# PostgreSQL\n\n한국어 본문 검색 example.',visibility:'private'})});
    assert.equal(created.status,201);const artifact=await created.json();
    assert.equal((await fetch(app.url+'/api/artifacts/'+artifact.id)).status,401);
    const result=await fetch(app.url+'/api/artifacts/'+artifact.id,{headers:{authorization}});assert.equal(result.status,200);assert.match((await result.json()).content,/한국어/);
    const search=await fetch(app.url+'/api/artifacts?q='+encodeURIComponent('한국어'),{headers:{authorization}});assert.equal(search.status,200);assert.equal((await search.json()).artifacts.length,1);
    const category=await createCategory(app.store,{name:'Database reading',scope:'personal'},{access});
    await setCategoryArtifact(app.store,category.id,artifact.id,true,{access});
    assert.equal((await listCategories(app.store,{access})).length,1);
    await addComment(app.store,artifact.id,{body:'Verified PostgreSQL content',access});
    const backup=await exportStoreToString(app.store,{scope:'full'});
    assert.doesNotMatch(backup,/artifacty-test-only|postgresql:\/\//);
    const sqlite=createStore({home:sqliteHome,databaseUrl:null});
    await importStoreFromString(sqlite,backup,{confirm:'replace-all'});
    assert.equal((await getArtifact(sqlite,artifact.id,{access})).content,'# PostgreSQL\n\n한국어 본문 검색 example.');
    assert.equal((await checkStoreIntegrity(sqlite)).ok,true);
    assert.equal((await checkStoreIntegrity(app.store)).ok,true);
    const file=path.join(sqliteHome,'migration.json');
    await exec(process.execPath,['src/cli.js','export','--home',sqliteHome,'--file',file,'--full'],{env:{...process.env,ARTIFACTY_DATABASE_URL:'',ARTIFACTY_EMBEDDINGS_PROVIDER:'disabled'}});
    const env={...process.env,ARTIFACTY_DATABASE_URL:url,ARTIFACTY_DATABASE_SCHEMA:targetSchema,ARTIFACTY_EMBEDDINGS_PROVIDER:'disabled'};
    const imported=await exec(process.execPath,['src/cli.js','import-store','--home',restoredHome,'--file',file,'--confirm','replace-all'],{env});
    assert.ok(JSON.parse(imported.stdout));
    const restored=createStore({home:restoredHome,databaseUrl:url,databaseSchema:targetSchema});
    assert.equal((await getArtifact(restored,artifact.id,{access})).content,(await getArtifact(sqlite,artifact.id,{access})).content);
    assert.equal((await checkStoreIntegrity(restored)).ok,true);
    assert.equal(reader.role,'user');
  } finally {
    if(app)await app.close();
    const client=new Client({connectionString:url});await client.connect();await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);await client.end();
    await rm(home,{recursive:true,force:true});await rm(sqliteHome,{recursive:true,force:true});await rm(restoredHome,{recursive:true,force:true});
  }
});


test('transaction preserves connection failures when rollback is unavailable', () => {
  const original = new Error('connection lost');
  assert.throws(() => transaction({exec(){throw original;}},()=>assert.fail('must not write')), error=>error===original);
  assert.throws(() => transaction({exec(sql){if(sql==='ROLLBACK')throw new Error('closed connection');}},()=>{throw original;}),error=>error===original);
});
