import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {migrateRemote} from '../src/lib/remote-migrate.js';
const old='http://192.0.2.10:8787',next='https://artifacty.example.test';
const exec=promisify(execFile);
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'artifacty-remote-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('migration dry run never checks destination, writes secrets or changes unrelated entries',async t=>{
 const root=await fixture(t),file=path.join(root,'.mcp.json');
 const value={other:'kept',mcpServers:{artifacty:{command:'node',args:['server.js'],env:{ARTIFACTY_URL:old,ARTIFACTY_MCP_URL:old+'/mcp',ARTIFACTY_API_TOKEN:'old-secret'}},other:{url:old,headers:{Authorization:'unrelated'}}}};
 await writeFile(file,JSON.stringify(value));
 const plan=await migrateRemote(old,next,{configPath:file,agent:'claude',dryRun:true,checkEndpoint:()=>assert.fail('network disabled')});
 assert.equal(plan.changed,true);assert.doesNotMatch(JSON.stringify(plan),/old-secret|unrelated/);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),value);assert.equal((await readdir(root)).length,1);
 await migrateRemote(old,next,{configPath:file,agent:'claude',checkEndpoint:async(url,options)=>{assert.equal(url,next);assert.equal(options.apiToken,undefined);return {ok:true};}});
 const migrated=JSON.parse(await readFile(file,'utf8'));assert.equal(migrated.mcpServers.artifacty.env.ARTIFACTY_MCP_URL,next+'/mcp');assert.equal(migrated.mcpServers.artifacty.env.ARTIFACTY_API_TOKEN,'');assert.deepEqual(migrated.mcpServers.other,value.mcpServers.other);
 const backup=(await readdir(root)).find(file=>file.includes('artifacty-backup'));assert.ok(backup);assert.deepEqual(JSON.parse(await readFile(path.join(root,backup),'utf8')),value);if(process.platform!=='win32')assert.equal((await stat(path.join(root,backup))).mode&0o777,0o600);
});
test('migration fails before changing files when verification fails or JSONC is unsupported',async t=>{
 const root=await fixture(t),file=path.join(root,'.mcp.json');const original=JSON.stringify({mcpServers:{artifacty:{url:old+'/mcp',headers:{Authorization:'old-secret'}}}});await writeFile(file,original);
 await assert.rejects(migrateRemote(old,next,{configPath:file,agent:'claude',checkEndpoint:async()=>({ok:false})}),/verification failed/);assert.equal(await readFile(file,'utf8'),original);assert.equal((await readdir(root)).length,1);
 await writeFile(file,'// JSONC\n'+original);await assert.rejects(migrateRemote(old,next,{configPath:file,agent:'claude',dryRun:true}),/JSONC/);
});
test('Codex TOML migration preserves neighboring tables and clears inline credentials',async t=>{
 const root=await fixture(t),file=path.join(root,'config.toml');
 const original=`model = "example"\n[mcp_servers.other]\nurl = "${old}/mcp"\n[mcp_servers.artifacty]\ncommand = "node"\nargs = ["server.js"]\nenv = { ARTIFACTY_URL = "${old}", ARTIFACTY_API_TOKEN = "old-secret", ARTIFACTY_MCP_URL = "${old}/mcp", ARTIFACTY_MCP_MODE = "bridge" }\n[other]\nkeep = true\n`;
 await writeFile(file,original);await migrateRemote(old,next,{configPath:file,agent:'codex',checkEndpoint:async()=>({ok:true})});const output=await readFile(file,'utf8');assert.ok(output.includes(`[mcp_servers.other]\nurl = "${old}/mcp"`));assert.match(output,/\[other\]\nkeep = true/);assert.ok(output.includes(`ARTIFACTY_MCP_URL = "${next}/mcp"`));assert.doesNotMatch(output,/old-secret/);assert.ok(output.includes('ARTIFACTY_API_TOKEN = ""'));
});
test('CLI remote migrate keeps --to as a URL and does not initialize artifact storage',async t=>{
 const root=await fixture(t),file=path.join(root,'.mcp.json');await writeFile(file,JSON.stringify({mcpServers:{artifacty:{url:old+'/mcp'}}}));
 const result=await exec(process.execPath,['src/cli.js','remote','migrate',old,'--to',next,'--dry-run','--agent','claude','--config',file],{env:{...process.env,ARTIFACTY_HOME:path.join(root,'must-not-exist'),ARTIFACTY_DATABASE_URL:'invalid-database-configuration'}});assert.equal(JSON.parse(result.stdout).changed,true);assert.ok(!(await readdir(root)).includes('must-not-exist'));
});
test('migration refuses symlinks and unintended HTTPS downgrade',async t=>{
 const root=await fixture(t),file=path.join(root,'real.json');await writeFile(file,'{}');const link=path.join(root,'link.json');if(process.platform!=='win32'){await symlink(file,link);await assert.rejects(migrateRemote(old,next,{agent:'claude',configPath:link,dryRun:true}),/symbolic/);}await assert.rejects(migrateRemote(next,old,{dryRun:true}),/downgrade/);
});

test('Codex comments cannot trigger migration and multiline strings fail closed',async t=>{
 const root=await fixture(t),file=path.join(root,'config.toml');
 const comment=`[mcp_servers.artifacty]\n# ARTIFACTY_URL = "${old}"\nenv = { ARTIFACTY_URL = "https://unchanged.example.test", ARTIFACTY_API_TOKEN = "keep-secret" }\n`;
 await writeFile(file,comment);const result=await migrateRemote(old,next,{configPath:file,agent:'codex',dryRun:true});assert.equal(result.changed,false);assert.equal(await readFile(file,'utf8'),comment);
 await writeFile(file,`[mcp_servers.artifacty]\nurl = """${old}"""\n`);await assert.rejects(migrateRemote(old,next,{configPath:file,agent:'codex',dryRun:true}),/Multiline/);
});
test('native JSON and TOML migrations remove all old header credentials',async t=>{
 const root=await fixture(t),file=path.join(root,'config.json');await writeFile(file,JSON.stringify({mcpServers:{artifacty:{url:old+'/mcp',http_headers:{'X-API-Key':'secret'},headers:{Authorization:'secret'}}}}));
 await migrateRemote(old,next,{configPath:file,agent:'claude',checkEndpoint:async()=>({ok:true})});const json=JSON.parse(await readFile(file,'utf8'));assert.equal(json.mcpServers.artifacty.headers,undefined);assert.equal(json.mcpServers.artifacty.http_headers,undefined);
 const toml=path.join(root,'config.toml');await writeFile(toml,`[mcp_servers.artifacty]\nurl = "${old}/mcp"\nhttp_headers = { "Authorization" = "secret" }\n[mcp_servers.artifacty.http_headers]\n"X-API-Key" = "secret"\n[mcp_servers.other]\nurl = "${old}"\n`);
 await migrateRemote(old,next,{configPath:toml,agent:'codex',checkEndpoint:async()=>({ok:true})});const text=await readFile(toml,'utf8');assert.doesNotMatch(text,/secret|http_headers/);assert.ok(text.includes(`[mcp_servers.other]\nurl = "${old}"`));
});

test('CLI add, use and list remote profiles preserve existing tokens when omitted',async t=>{
 const root=await fixture(t),dir=path.join(root,'profiles');const env={...process.env,ARTIFACTY_CONFIG_HOME:dir,ARTIFACTY_DATABASE_URL:'invalid',ARTIFACTY_HOME:path.join(root,'no-store')};
 const run=args=>exec(process.execPath,['src/cli.js','remote',...args],{env});
 await run(['add','company',next,'--api-token','test-new-secret']);await run(['add','company',next]);const used=await run(['use','company']);assert.doesNotMatch(used.stdout,/test-new-secret/);const listed=await run(['list']);assert.match(listed.stdout,/company/);assert.match(listed.stdout,/"hasToken": true/);assert.doesNotMatch(listed.stdout,/test-new-secret/);assert.ok(!(await readdir(root)).includes('no-store'));
});


test('migration removes environment-derived HTTP header credentials too',async t=>{
 const root=await fixture(t),file=path.join(root,'headers.toml');
 await writeFile(file,`[mcp_servers.artifacty]\nurl = "${old}/mcp"\n[mcp_servers.artifacty.env_http_headers]\nAuthorization = "OLD_TOKEN_ENV"\n[other]\nkeep = true\n`);
 await migrateRemote(old,next,{agent:'codex',configPath:file,checkEndpoint:async()=>({ok:true})});
 const changed=await readFile(file,'utf8');assert.doesNotMatch(changed,/OLD_TOKEN_ENV|env_http_headers/);assert.match(changed,/keep = true/);
});

const clearedToml=async(t,body)=>{const root=await fixture(t),file=path.join(root,'config.toml');await writeFile(file,body);const result=await migrateRemote(old,next,{agent:'codex',configPath:file,env:{},checkEndpoint:async()=>({ok:true})});return {text:await readFile(file,'utf8'),result};};
test('TOML migration clears credentials in every key spelling and table position',async t=>{
 const cases={
  dotted:`[mcp_servers.artifacty]\nurl = "${old}/mcp"\nhttp_headers.Authorization = "old-secret"\n`,
  quoted:`[mcp_servers.artifacty]\nurl = "${old}/mcp"\n"http_headers" = { Authorization = "old-secret" }\n`,
  singleQuoted:`[mcp_servers.artifacty]\nurl = "${old}/mcp"\n'bearer_token' = "old-secret"\n`,
  spaced:`[mcp_servers.artifacty]\nurl = "${old}/mcp"\nhttp_headers . Authorization = "old-secret"\n`,
  apart:`[mcp_servers.artifacty]\nurl = "${old}/mcp"\n[other]\nkeep = true\n[mcp_servers.artifacty.http_headers]\nAuthorization = "old-secret"\n`,
  quotedTable:`[mcp_servers.artifacty]\nurl = "${old}/mcp"\n[mcp_servers.artifacty."http_headers"]\nAuthorization = "old-secret"\n[other]\nkeep = true\n`,
  spacedTable:`[ mcp_servers . artifacty ]\nurl = "${old}/mcp"\n[ mcp_servers . artifacty . http_headers ]\nAuthorization = "old-secret"\n`
 };
 for(const [name,body] of Object.entries(cases)){const {text,result}=await clearedToml(t,body);assert.doesNotMatch(text,/old-secret/,name);assert.ok(text.includes(`url = "${next}/mcp"`),name);assert.equal(result.files[0].credentialsCleared,true,name);if(body.includes('keep = true'))assert.match(text,/\[other\]\nkeep = true/,name);}
});
test('TOML env tables blank the inherited bridge token and dotted forms fail closed',async t=>{
 const {text}=await clearedToml(t,`[mcp_servers.artifacty]\ncommand = "node"\n[mcp_servers.artifacty.env]\nARTIFACTY_MCP_URL = "${old}/mcp"\nARTIFACTY_API_TOKEN = "old-secret"\n`);
 assert.doesNotMatch(text,/old-secret/);assert.match(text,/\[mcp_servers\.artifacty\.env\]\nARTIFACTY_API_TOKEN = ""\n/);assert.ok(text.includes(`ARTIFACTY_MCP_URL = "${next}/mcp"`));
 for(const body of [`[mcp_servers.artifacty]\nurl = "${old}/mcp"\nenv.ARTIFACTY_API_TOKEN = "old-secret"\n`,`mcp_servers.artifacty.http_headers.Authorization = "old-secret"\n[mcp_servers.artifacty]\nurl = "${old}/mcp"\n`,`[mcp_servers]\nartifacty.http_headers.Authorization = "old-secret"\n[mcp_servers.artifacty]\nurl = "${old}/mcp"\n`]){
  const root=await fixture(t),file=path.join(root,'config.toml');await writeFile(file,body);
  await assert.rejects(migrateRemote(old,next,{agent:'codex',configPath:file,env:{},checkEndpoint:async()=>({ok:true})}),{code:'REMOTE_MIGRATION_FAILED'});assert.equal(await readFile(file,'utf8'),body);
 }
 const unrelated=await clearedToml(t,`[mcp_servers.artifacty]\nurl = "${old}/mcp"\n[tools]\nartifacty = "kept"\n[notes]\ntext = "[mcp_servers.other]"\n`);assert.match(unrelated.text,/artifacty = "kept"/);
});
test('JSON migration clears camelCase credentials and warns about an inherited token',async t=>{
 const root=await fixture(t),file=path.join(root,'.mcp.json');
 await writeFile(file,JSON.stringify({mcpServers:{artifacty:{url:old+'/mcp',bearerToken:'old-secret',bearerTokenEnvVar:'OLD_ENV',apiKey:'old-secret',requestInit:{headers:{Authorization:'old-secret'}}}}}));
 const result=await migrateRemote(old,next,{agent:'claude',configPath:file,env:{ARTIFACTY_API_TOKEN:'from-shell'},checkEndpoint:async()=>({ok:true})});
 const text=await readFile(file,'utf8');assert.doesNotMatch(text,/old-secret|OLD_ENV/);assert.match(result.warnings[0],/ARTIFACTY_API_TOKEN/);assert.doesNotMatch(JSON.stringify(result),/from-shell/);
 const clean=path.join(root,'clean.json');await writeFile(clean,JSON.stringify({mcpServers:{artifacty:{url:old+'/mcp'}}}));
 assert.equal((await migrateRemote(old,next,{agent:'claude',configPath:clean,env:{},checkEndpoint:async()=>({ok:true})})).warnings,undefined);
});
