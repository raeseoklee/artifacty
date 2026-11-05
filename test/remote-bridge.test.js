import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRemoteMcpJsonRpcHandler} from '../src/mcp-server.js';
import {createMcpServerConfig} from '../src/lib/installer.js';
import {addRemote,useRemote} from '../src/lib/remotes.js';

test('one bridge follows the active profile without forwarding unrelated environment credentials',async()=>{
 const configDir=await mkdtemp(path.join(tmpdir(),'artifacty-remote-bridge-'));
 const calls=[];const servers=[];
 const server=async label=>{const app=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const message=JSON.parse(text);calls.push({label,auth:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{label}}));});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));servers.push(app);return `http://127.0.0.1:${app.address().port}`;};
 try{
 const first=await server('first'),second=await server('second');
 await addRemote('first',first,{configDir,apiToken:'first-only'});await addRemote('second',second,{configDir});await useRemote('first',{configDir});
 const bridge=createRemoteMcpJsonRpcHandler({remote:'active',configDir,apiToken:'must-not-follow'});
 assert.equal((await bridge({jsonrpc:'2.0',id:1,method:'ping'})).result.label,'first');
 await useRemote('second',{configDir});assert.equal((await bridge({jsonrpc:'2.0',id:2,method:'ping'})).result.label,'second');
 assert.deepEqual(calls,[{label:'first',auth:'Bearer first-only'},{label:'second',auth:undefined}]);
 }finally{for(const app of servers)await new Promise(resolve=>app.close(resolve));await rm(configDir,{recursive:true,force:true});}
});
test('profile installer pins only the profile selector, not static endpoints or credentials',()=>{
 const config=createMcpServerConfig({remote:'active',url:'https://old.example.test',mcpUrl:'https://old.example.test/mcp',apiToken:'old-secret'});
 assert.equal(config.env.ARTIFACTY_REMOTE,'active');assert.equal(config.env.ARTIFACTY_MCP_MODE,'bridge');assert.equal(config.env.ARTIFACTY_API_TOKEN,undefined);assert.equal(config.env.ARTIFACTY_MCP_URL,undefined);assert.equal(config.env.ARTIFACTY_URL,undefined);
});

test('a bridge entry with a blank token does not forward a token inherited from the shell',async()=>{
 const seen=[];const server=http.createServer((request,response)=>{seen.push(request.headers.authorization);request.resume();request.on('end',()=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const previous=process.env.ARTIFACTY_API_TOKEN;
 try{
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  process.env.ARTIFACTY_API_TOKEN='';
  await createRemoteMcpJsonRpcHandler({url})({jsonrpc:'2.0',id:1,method:'ping'});
  assert.equal(seen[0],undefined);
 }finally{
  if(previous===undefined)delete process.env.ARTIFACTY_API_TOKEN;else process.env.ARTIFACTY_API_TOKEN=previous;
  await new Promise(resolve=>server.close(resolve));
 }
});
