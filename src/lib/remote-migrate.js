import { readFile, lstat, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkRemoteEndpoint } from './remotes.js';

function fail(message) { throw Object.assign(new Error(message), {code:'REMOTE_MIGRATION_FAILED'}); }
function base(value) {
  let url; try { url=new URL(value); } catch { fail('Expected an HTTP(S) server URL'); }
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) fail('Server URLs must not contain credentials, queries or fragments');
  return url.href.replace(/\/+$/,'');
}
function endpoint(value) { return value.endsWith('/mcp')?value:value+'/mcp'; }
const CREDENTIAL_KEYS=new Set(['artifactyapitoken','authorization','bearertoken','bearertokenenvvar','apikey','xapikey','xartifactytoken','token','accesstoken','headers','httpheaders','envhttpheaders']);
const secretKey=key=>CREDENTIAL_KEYS.has(String(key).toLowerCase().replace(/[-_]/g,''));
// Splits a dotted TOML key, honoring quoted segments. Returns null when it is not a key.
function tomlKeySegments(value){
  const segments=[];const pattern=/\s*(?:([A-Za-z0-9_-]+)|"((?:\\.|[^"\\])*)"|'([^']*)')\s*(\.|$)/y;let index=0;
  while(index<value.length){pattern.lastIndex=index;const match=pattern.exec(value);if(!match)return null;segments.push(match[1]??match[2]??match[3]);index=pattern.lastIndex;if(!match[4]&&index<value.length)return null;}
  return segments.length?segments:null;
}
function tomlTablePath(line){const match=/^\s*\[\[?([^\[\]]+)\]\]?\s*(?:#.*)?$/.exec(line);return match?tomlKeySegments(match[1]):null;}
function tomlAssignmentKey(code){
  let quote='',escaped=false;
  for(let i=0;i<code.length;i++){const c=code[i];if(quote){if(escaped)escaped=false;else if(c==='\\'&&quote==='"')escaped=true;else if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='=')return tomlKeySegments(code.slice(0,i));}
  return null;
}
function replaceUrl(value,oldUrl,newUrl) {
  if(typeof value!=='string')return value;
  let normalized;try{normalized=base(value);}catch{return value;}
  if(normalized===oldUrl)return newUrl;
  if(normalized===endpoint(oldUrl))return endpoint(newUrl);
  return value;
}
function jsonMigration(text,oldUrl,newUrl,apiToken) {
  let config;try{config=JSON.parse(text);}catch{fail('MCP configuration must be valid JSON; JSONC is not modified');}
  if(!config||typeof config!=='object'||Array.isArray(config))fail('MCP configuration must be a JSON object');
  const target=config.mcpServers?.artifacty??config.servers?.artifacty;
  if(!target||typeof target!=='object'||Array.isArray(target))return null;
  let changed=false;
  for(const key of ['url','serverUrl']){const value=replaceUrl(target[key],oldUrl,newUrl);if(value!==target[key]){target[key]=value;changed=true;}}
  if(target.env&&typeof target.env==='object'&&!Array.isArray(target.env))for(const key of ['ARTIFACTY_URL','ARTIFACTY_MCP_URL']){const value=replaceUrl(target.env[key],oldUrl,newUrl);if(value!==target.env[key]){target.env[key]=value;changed=true;}}
  if(!changed)return null;
  for(const key of Object.keys(target))if(secretKey(key))delete target[key];
  for(const section of [target.env])if(section&&typeof section==='object')for(const key of Object.keys(section))if(secretKey(key))delete section[key];
  if(target.requestInit&&typeof target.requestInit==='object')delete target.requestInit.headers;
  if(target.env?.ARTIFACTY_MCP_URL){
    target.env.ARTIFACTY_MCP_MODE='bridge';
    // Blank, not absent: the bridge falls back to an inherited shell variable.
    if(!apiToken)target.env.ARTIFACTY_API_TOKEN='';
  }
  if(apiToken){if(target.env)target.env.ARTIFACTY_API_TOKEN=apiToken;else target.headers={...(target.headers||{}),Authorization:`Bearer ${apiToken}`};}
  return JSON.stringify(config,null,2)+'\n';
}
function tomlMigration(text,oldUrl,newUrl,apiToken) {
  const lines=text.split(/\r?\n/);let rootSeen=false,current=null,tablePath=[];
  // Artifacty tables need not be adjacent, so classify every line of the file.
  const sections=lines.map(line=>{
    const found=tomlTablePath(line);
    if(found){
      tablePath=found;
      if(found[0]==='mcp_servers'&&found[1]==='artifacty'){
        current=found.slice(2).join('.')||'root';
        if(current==='root'){if(rootSeen)fail('Duplicate Artifacty TOML tables are not supported');rootSeen=true;}
      }else current=null;
    }else if(current===null&&!/^\s*(?:#|$)/.test(line)){
      const key=tomlAssignmentKey(line);
      const dotted=key&&((tablePath.length===0&&key[0]==='mcp_servers'&&key[1]==='artifacty')||(tablePath.length===1&&tablePath[0]==='mcp_servers'&&key[0]==='artifacty'));
      if(dotted)current=undefined;
    }
    const section=current===undefined?'unsupported':current;
    if(current===undefined)current=null;
    return section;
  });
  if(!rootSeen)return null;
  if(sections.includes('unsupported'))fail('Dotted Artifacty TOML settings outside its table are not supported; edit this configuration manually');
  const block=lines.filter((_,index)=>sections[index]!==null);
  if(block.some(line=>line.includes('"""')||line.includes("'''")))fail('Multiline TOML strings are not supported for migration');
  const literal='("(?:\\\\.|[^"\\\\])*"|\'[^\']*\')';
  const decode=value=>{try{return value[0]==='"'?JSON.parse(value):value.slice(1,-1);}catch{fail('Unsupported TOML string in Artifacty settings');}};
  const assignment=new RegExp('^\\s*([A-Za-z_][A-Za-z_0-9]*|"[A-Za-z_][A-Za-z_0-9]*")\\s*=\\s*'+literal+'\\s*$');
  function uncomment(line){let quote='',escaped=false;for(let i=0;i<line.length;i++){const c=line[i];if(quote){if(escaped){escaped=false;continue;}if(c==='\\'&&quote==='"'){escaped=true;continue;}if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='#')return [line.slice(0,i),line.slice(i)];}return [line,''];}
  let changed=false,section='root',envSectionBridge=false;
  const prepared=lines.map((line,index)=>{
    if(sections[index]===null)return {line,outside:true};
    section=sections[index];
    if(tomlTablePath(line))return {line,section,header:true};
    const [code,comment]=uncomment(line);
    // Any spelling of a credential key goes, whether bare, quoted or dotted.
    const keySegments=tomlAssignmentKey(code);
    if(keySegments){
      if(section==='root'&&keySegments[0]==='env'&&keySegments.length>1)fail('Dotted TOML env keys cannot be migrated; use an inline or [env] table');
      if(secretKey(keySegments[0])||secretKey(keySegments[keySegments.length-1]))return {section,drop:true};
    }
    if(/^\s*env\s*=/.test(code)){
      const inline=/^\s*env\s*=\s*\{(.*)\}\s*$/.exec(code);if(!inline)fail('Only single-line TOML env tables can be migrated');
      // Split commas outside strings, then require every env entry to be a string assignment.
      let quote='',escaped=false,start=0;const chunks=[];for(let i=0;i<inline[1].length;i++){const c=inline[1][i];if(quote){if(escaped){escaped=false;continue;}if(c==='\\'&&quote==='"'){escaped=true;continue;}if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c===','){chunks.push(inline[1].slice(start,i));start=i+1;}}chunks.push(inline[1].slice(start));
      const pairs=chunks.filter(x=>x.trim()).map(chunk=>{const match=assignment.exec(chunk);if(!match)fail('Unsupported TOML inline env syntax');return {key:match[1].replaceAll('"',''),value:decode(match[2])};});
      for(const pair of pairs)if(['ARTIFACTY_URL','ARTIFACTY_MCP_URL'].includes(pair.key)){const next=replaceUrl(pair.value,oldUrl,newUrl);if(next!==pair.value){pair.value=next;changed=true;}}
      return {line,section,pairs,comment};
    }
    const match=assignment.exec(code);if(match){const key=match[1].replaceAll('"','');let value=decode(match[2]);if((section==='root'&&key==='url')||(section==='env'&&['ARTIFACTY_URL','ARTIFACTY_MCP_URL'].includes(key))){const next=replaceUrl(value,oldUrl,newUrl);if(next!==value){value=next;changed=true;return {line:`${key} = ${JSON.stringify(value)}${comment?' '+comment:''}`,section,key};}}return {line,section,key};}
    return {line,section,code};
  });
  if(!changed)return null;
  let tokenAdded=false;
  const result=[];
  const secretSection=name=>secretKey(String(name).split('.')[0]);
  for(const entry of prepared){
    if(entry.outside){result.push(entry.line);continue;}
    if(entry.drop||secretSection(entry.section))continue;
    if(entry.section==='env'&&entry.key==='ARTIFACTY_MCP_URL')envSectionBridge=true;
    if(entry.pairs){
      const pairs=entry.pairs.filter(pair=>!secretKey(pair.key));
      if(apiToken){pairs.push({key:'ARTIFACTY_API_TOKEN',value:apiToken});tokenAdded=true;}
      if(pairs.some(pair=>pair.key==='ARTIFACTY_MCP_URL')){
        const mode=pairs.find(pair=>pair.key==='ARTIFACTY_MCP_MODE');if(mode)mode.value='bridge';else pairs.push({key:'ARTIFACTY_MCP_MODE',value:'bridge'});
        // Blank, not absent: the bridge falls back to an inherited shell variable.
        if(!apiToken)pairs.push({key:'ARTIFACTY_API_TOKEN',value:''});
      }
      result.push('env = { '+pairs.map(pair=>`${pair.key} = ${JSON.stringify(pair.value)}`).join(', ')+' }'+(entry.comment?' '+entry.comment:''));
    }
    else result.push(entry.line);
  }
  if(apiToken&&!tokenAdded)fail('Adding a token requires an installer-generated inline env table; configure authentication separately');
  if(envSectionBridge&&!apiToken){const header=result.findIndex(line=>{const found=tomlTablePath(line);return found&&found[0]==='mcp_servers'&&found[1]==='artifacty'&&found[2]==='env'&&found.length===3;});result.splice(header+1,0,'ARTIFACTY_API_TOKEN = ""');}
  return result.join('\n');
}
async function safeFile(filename){
  const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())fail('MCP configuration must be a regular file, not a symbolic link');

  return info;
}
async function atomicWrite(filename,content){const temporary=filename+'.artifacty-'+randomUUID()+'.tmp';try{await writeFile(temporary,content,{flag:'wx',mode:0o600});await rename(temporary,filename);await chmod(filename,0o600);}finally{await unlink(temporary).catch(()=>{});}}
export async function migrateRemote(oldValue,newValue,options={}){
  const oldUrl=base(oldValue),newUrl=base(newValue);
  if(oldUrl===newUrl)return {changed:false,dryRun:Boolean(options.dryRun),files:[]};
  if(oldUrl.startsWith('https:')&&newUrl.startsWith('http:')&&!options.allowInsecureDowngrade)fail('HTTPS to HTTP migration requires --allow-insecure-downgrade');
  const project=path.resolve(options.projectDir||process.cwd()),home=options.userHome||homedir();
  const defaults=[['claude',path.join(project,'.mcp.json')],['gemini',path.join(project,'.gemini','settings.json')],['copilot',path.join(project,'.vscode','mcp.json')],['cursor',path.join(project,'.cursor','mcp.json')],['codex',path.join(home,'.codex','config.toml')]];
  if(options.agent&&!defaults.some(([agent])=>agent===options.agent))fail('Unsupported MCP client');
  if(options.configPath&&!options.agent)fail('--config requires --agent');
  const targets=options.configPath?[[options.agent,path.resolve(options.configPath)]]:defaults.filter(([agent])=>!options.agent||agent===options.agent);
  const plans=[];
  for(const [agent,filename]of targets){try{await safeFile(filename);}catch(error){if(error.code==='ENOENT'&&!options.configPath)continue;throw error;}
    const original=await readFile(filename,'utf8');const next=agent==='codex'?tomlMigration(original,oldUrl,newUrl,options.apiToken):jsonMigration(original,oldUrl,newUrl,options.apiToken);
    if(next!==null)plans.push({agent,path:filename,original,next});
  }
  if(!options.dryRun&&plans.length){const check=await (options.checkEndpoint||checkRemoteEndpoint)(newUrl,{apiToken:options.apiToken,timeoutMs:options.timeoutMs});if(!check.ok)fail('Destination MCP verification failed; no configuration was changed');}
  const files=plans.map(({agent,path})=>({agent,path,changed:true,credentialsCleared:!options.apiToken}));
  // Migration can only change client files. A client that ignores per-server env could still forward this.
  const warnings=plans.length&&!options.apiToken&&(options.env||process.env).ARTIFACTY_API_TOKEN?['ARTIFACTY_API_TOKEN is set in this environment. Unset it before starting MCP clients so the previous token is not sent to the new server.']:[];
  const warningFields=warnings.length?{warnings}:{};
  if(options.dryRun)return {changed:plans.length>0,dryRun:true,files,...warningFields};
  const written=[];
  try{
    for(let i=0;i<plans.length;i++){const plan=plans[i];await safeFile(plan.path);if(await readFile(plan.path,'utf8')!==plan.original)fail('MCP configuration changed during migration');const backup=plan.path+'.artifacty-backup-'+randomUUID();await writeFile(backup,plan.original,{flag:'wx',mode:0o600});files[i].backupPath=backup;}
    for(const plan of plans){await atomicWrite(plan.path,plan.next);written.push(plan);}
  }catch(error){for(const plan of written.reverse())await atomicWrite(plan.path,plan.original);throw error;}
  return {changed:plans.length>0,dryRun:false,files,reconnectRequired:plans.length>0,...warningFields};
}
