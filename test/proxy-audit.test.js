import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '../src/server.js';
import {listAuditEvents,createUser,createApiToken,listEventsSince,openDatabase,createArtifact} from '../src/lib/storage.js';

test('trusted requests retain private audit IP, public URLs and administrative audit access',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'artifacty-proxy-'));
 const old=process.env.ARTIFACTY_URL;process.env.ARTIFACTY_URL='https://artifacts.example.test/';
 let app;
 try{
 app=await startServer({home,port:0,trustedProxies:'127.0.0.0/8'});
 const admin=await createUser(app.store,{email:'admin@example.test',password:'test-password-123',role:'admin'});
 const reader=await createUser(app.store,{email:'reader@example.test',password:'test-password-123',role:'user'});
 const a=await createApiToken(app.store,admin.id,{name:'admin',scopes:['read','write','admin']});
 const r=await createApiToken(app.store,reader.id,{name:'reader',scopes:['read','write']});
 const create=address=>fetch(app.url+'/api/artifacts',{method:'POST',headers:{authorization:`Bearer ${a.token}`,'content-type':'application/json','x-forwarded-for':address},body:JSON.stringify({title:'Proxy test',content:'test',format:'text'})});
 const [one,two]=await Promise.all([create('198.51.100.1'),create('198.51.100.2')]);assert.equal(one.status,201);assert.equal(two.status,201);
 const artifacts=await Promise.all([one.json(),two.json()]);
 for(let i=0;i<2;i++){const rows=await listAuditEvents(app.store,{artifactId:artifacts[i].id});assert.equal(rows.find(row=>row.action==='create').metadata.clientAddress,`198.51.100.${i+1}`);}
 const events=await listEventsSince(app.store,0);assert.doesNotMatch(JSON.stringify(events),/clientAddress|198\.51\.100/);
 const userRows=await listAuditEvents(app.store,{access:{userId:reader.id,role:'user'}});assert.doesNotMatch(JSON.stringify(userRows),/clientAddress/);
 assert.equal((await fetch(app.url+'/api/audit',{headers:{authorization:`Bearer ${r.token}`}})).status,403);
 assert.equal((await fetch(app.url+'/api/audit',{headers:{authorization:`Bearer ${a.token}`}})).status,200);
 const login=await (await fetch(app.url+'/login')).text();assert.match(login,/https:\/\/artifacts.example.test/);
 const spec=await (await fetch(app.url+'/openapi.json')).text();assert.match(spec,/https:\/\/artifacts.example.test/);
 const db=openDatabase(app.store);try{db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('network_policy',?)").run(JSON.stringify({allowedCidrs:['198.51.100.1']}));}finally{db.close();}
 assert.equal((await fetch(app.url+'/health',{headers:{'x-forwarded-for':'203.0.113.9,198.51.100.1'}})).status,200);
 assert.equal((await fetch(app.url+'/health',{headers:{'x-forwarded-for':'198.51.100.1,203.0.113.9'}})).status,403);
 const stream=await fetch(app.url+'/api/events',{headers:{authorization:`Bearer ${a.token}`,accept:'text/event-stream','x-forwarded-for':'198.51.100.1'},signal:AbortSignal.timeout(5000)});
 assert.equal(stream.status,200);const streamReader=stream.body.getReader();await streamReader.read();
 await createArtifact(app.store,{title:'SSE check',content:'event',format:'text',visibility:'public'});
 const chunk=await streamReader.read();assert.equal(chunk.done,false);assert.doesNotMatch(new TextDecoder().decode(chunk.value),/clientAddress|198\.51\.100/);
 const policy=openDatabase(app.store);try{policy.prepare("UPDATE meta SET value=? WHERE key='network_policy'").run(JSON.stringify({allowedCidrs:['198.51.100.2']}));}finally{policy.close();}
 const revoked=await createArtifact(app.store,{title:'Revoked SSE',content:'event',format:'text',visibility:'public'});
 let ended=false;for(let i=0;i<20;i++){const value=await streamReader.read();if(value.done){ended=true;break;}assert.ok(!new TextDecoder().decode(value.value).includes(revoked.id));}assert.equal(ended,true);


 } finally {if(app)await app.close();if(old===undefined)delete process.env.ARTIFACTY_URL;else process.env.ARTIFACTY_URL=old;await rm(home,{recursive:true,force:true});}
});


test('invalid trusted proxy configuration fails before startup without echoing its value',async()=>{
 await assert.rejects(startServer({trustedProxies:'invalid-private-configuration',port:0}),e=>e.code==='INVALID_TRUSTED_PROXIES'&&!e.message.includes('invalid-private-configuration'));
});
