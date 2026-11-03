import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, chmod, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { addRemote, useRemote, listRemotes, resolveRemote, checkRemote, checkRemoteEndpoint, normalizeRemoteUrl, remoteMcpUrl } from "../src/lib/remotes.js";

async function fixture(t) {
  const configDir = await mkdtemp(path.join(tmpdir(), "artifacty-remotes-"));
  t.after(() => rm(configDir, {recursive:true,force:true}));
  return {configDir};
}
test("remote profiles are private, atomic, selectable and redact credentials", async t => {
  const options=await fixture(t);
  await Promise.all([addRemote('company','https://artifacts.example.test/',{...options,apiToken:'test-private-token'}),addRemote('lab','http://127.0.0.1:8787',options)]);
  assert.equal((await listRemotes(options)).length,2);
  assert.doesNotMatch(JSON.stringify(await listRemotes(options)),/test-private-token/);
  await assert.rejects(resolveRemote(options),{code:'REMOTE_NOT_SELECTED'});
  assert.deepEqual(await useRemote('company',options),{name:'company',url:'https://artifacts.example.test',hasToken:true,active:true});
  const resolved=await resolveRemote(options);assert.equal(resolved.apiToken,'test-private-token');assert.equal(resolved.mcpUrl,'https://artifacts.example.test/mcp');
  if(process.platform!=='win32')assert.equal((await stat(path.join(options.configDir,'remoteprofiles.json'))).mode&0o777,0o600);
  await addRemote('company','https://artifacts.example.test',options);assert.equal((await resolveRemote(options)).apiToken,'test-private-token');
  await addRemote('company','https://new-artifacts.example.test',options);assert.equal((await resolveRemote(options)).apiToken,'');
  await assert.rejects(addRemote('company','http://new-artifacts.example.test',options),{code:'REMOTE_TLS_DOWNGRADE'});
  await addRemote('company','http://new-artifacts.example.test',{...options,allowInsecureDowngrade:true});
  assert.equal((await resolveRemote(options)).url,'http://new-artifacts.example.test');
});
test("remote configuration rejects unsafe URLs, names, malformed stores and symlinks",async t=>{
  const options=await fixture(t);
  for(const name of ['active','Active','../escape','_name','a'.repeat(65)])await assert.rejects(addRemote(name,'https://example.test',options));
  for(const url of ['not a URL','file:///tmp/x','https://user:password@example.test','https://example.test?token=secret','https://example.test#fragment'])assert.throws(()=>normalizeRemoteUrl(url));
  assert.equal(remoteMcpUrl('https://example.test/team/'),'https://example.test/team/mcp');assert.equal(remoteMcpUrl('https://example.test/mcp/'),'https://example.test/mcp');
  await addRemote('company','https://example.test',options);
  const file=path.join(options.configDir,'remoteprofiles.json');await writeFile(file,'{malformed');await assert.rejects(listRemotes(options));
  await rm(file);
  try { await symlink('nonexistent',file); await assert.rejects(listRemotes(options),{code:'UNSAFE_REMOTE_CONFIG'}); await rm(file); }
  catch(error) { if(process.platform!=='win32' || !['EPERM','EACCES'].includes(error.code)) throw error; }

  if(process.platform!=='win32'){await chmod(options.configDir,0o755);await assert.rejects(listRemotes(options),{code:'UNSAFE_REMOTE_CONFIG'});await chmod(options.configDir,0o700);}
});
test("remote checks use profile credentials only and verify real MCP discovery",async t=>{
 const options=await fixture(t);const received=[];
 const server=http.createServer(async(request,response)=>{
  let text='';for await(const chunk of request)text+=chunk;const message=JSON.parse(text);received.push({method:message.method,authorization:request.headers.authorization});
  response.setHeader('content-type','application/json');
  if(!message.id){response.writeHead(202);response.end();return;}
  const result=message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'artifacty_list'}]};
  response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}`;
 await addRemote('local',url,{...options,apiToken:'profile-token'});await useRemote('local',options);
 const old=process.env.ARTIFACTY_API_TOKEN;process.env.ARTIFACTY_API_TOKEN='unrelated-environment-token';
 try{assert.deepEqual(await checkRemote(undefined,options),{ok:true,name:'local',url,toolsCount:1});assert.ok(received.every(item=>item.authorization==='Bearer profile-token'));
 received.length=0;await addRemote('local',url,{...options,apiToken:null});await checkRemote(undefined,options);assert.ok(received.every(item=>item.authorization===undefined));
 }finally{if(old===undefined)delete process.env.ARTIFACTY_API_TOKEN;else process.env.ARTIFACTY_API_TOKEN=old;}
});
test("remote check failures reject redirects and never echo server errors or tokens",async()=>{
 let init=0;
 await assert.rejects(checkRemoteEndpoint('https://example.test',{apiToken:'private-token',fetch:async(_url,options)=>{assert.equal(options.redirect,'error');init++;return new Response('private-token server secret',{status:401});}}),e=>e.code==='REMOTE_CHECK_FAILED'&&!e.message.includes('private-token'));
 assert.equal(init,1);
 await assert.rejects(checkRemoteEndpoint('https://example.test',{fetch:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))}),{code:'REMOTE_CHECK_FAILED'});
});
