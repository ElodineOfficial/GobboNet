// Runs the real sync client. Server conditional writes are independently tested
// in internal/state/seed_guard_test.go; this harness exercises browser decisions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../js/06-state-sync.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('const STATE_SYNC_AVAILABLE'), src.indexOf('async function restoreFromServer')) + '\n' + src.slice(src.indexOf('/** What is on the server.'));
const thread = (id, content='hello') => ({id, messages:[{role:'user',content}]});
function harness({ remote={threads:[thread('a'),thread('other-device')]}, indexError=false, infoError=false, race=false, protocol='2' }={}) {
 const calls=[];
 let server=structuredClone(remote), revision=1;
 const context={
  console:{log(){},warn(){},error(){}}, IS_SERVED:true,
  window:{location:{origin:'http://localhost'}},
  localStorage:{getItem:()=>null,setItem(){}}, sessionStorage:{getItem:()=>null,setItem(){}},
  setTimeout:()=>0,clearTimeout(){}, TextEncoder,
  state:{threads:[thread('a')],settings:{}}, isGenerating:false,
  RUNTIME_MESSAGE_FIELDS:[], cleanThread:t=>t,
  getActiveThread:()=>null, updateSyncIndicator(){}, persistSyncMeta(){},
  confirm:()=>{throw Error('unexpected prompt');}, alert(){},
  buildStateMeta:()=>({settings:{}}),
  fetch:async(url,options={})=>{
   const path=new URL(url).pathname, method=options.method||'GET';
   calls.push({path,method,headers:options.headers});
   const response=(status,data)=>({ok:status>=200&&status<300,status,headers:{get:()=>protocol},json:async()=>data});
   if(path==='/state/info')return response(infoError?500:404,{});
   if(path==='/state/index') {
    if(indexError)return response(500,{});
    if(!server)return response(404,{});
    return response(200,{threads:server.threads.map(t=>({id:t.id,messages:t.messages.length,etag:'thread-'+revision})),meta:'meta-'+revision,documentEtag:'doc-'+revision});
   }
   if(path==='/state'&&method==='PUT') {
    if(race){server={threads:[thread('racing-device')]};revision++;}
    if((options.headers['If-None-Match']==='*'&&server)||(options.headers['If-Match']&&options.headers['If-Match']!=='doc-'+revision)) return response(412,{});
    server=JSON.parse(options.body); revision++; return response(200,{mtime:revision});
   }
   throw Error('Unexpected request '+method+' '+path);
  }
 };
 context.redactedSyncJson=()=>JSON.stringify(context.state);
 vm.createContext(context); vm.runInContext(code,context);
 return {ctx:context,calls,get:expression=>vm.runInContext(expression,context),remote:()=>server};
}
let h=harness({infoError:true});
await h.ctx.checkServerStateOnBoot();
await h.ctx.ensureSyncLedger();
assert.equal(h.calls.filter(c=>c.method==='PUT').length,0,'failed boot check must not overwrite history');
assert.equal(h.remote().threads.length,2);
assert.deepEqual(Object.keys(h.get('currentLedger().threads')),[],'unknown content is not falsely adopted');

h=harness({indexError:true});
await assert.rejects(h.ctx.ensureSyncLedger());
assert.equal(h.calls.filter(c=>c.method==='PUT').length,0,'failed index is not an empty server');

h=harness({remote:null,protocol:''});
await assert.rejects(h.ctx.ensureSyncLedger(),/Update the GobboNet server/);
assert.equal(h.calls.filter(c=>c.method==='PUT').length,0,'legacy 404 must not authorize a blind write');

h=harness({remote:null,race:true});
await assert.rejects(h.ctx.ensureSyncLedger(),/412/);
assert.equal(h.remote().threads[0].id,'racing-device','racing create survives');
assert.equal(h.get('currentLedger().seeded'),false);

h=harness({remote:null});
assert.equal(await h.ctx.ensureSyncLedger(),true);
assert.equal(h.calls.find(c=>c.method==='PUT').headers['If-None-Match'],'*');
assert.deepEqual(Object.keys(h.get('currentLedger().threads')),[],'seed must not infer equality from message counts');

h=harness();
h.ctx.invalidateLedger(undefined,true);
assert.equal(await h.ctx.ensureSyncLedger(),true);
assert.equal(h.calls.find(c=>c.method==='PUT').headers['If-Match'],'doc-1');
assert.equal(h.remote().threads.length,1,'explicit replace remains available');

h=harness({race:true});
h.ctx.invalidateLedger(undefined,true);
await assert.rejects(h.ctx.ensureSyncLedger(),/412/);
assert.equal(h.remote().threads[0].id,'racing-device');
assert.equal(h.get("overwriteSyncTargets.has('shared')"),false,'conflict must not arm a blind retry');
console.log('7 sync initialization regression scenarios passed');
