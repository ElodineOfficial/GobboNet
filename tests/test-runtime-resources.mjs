import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=n=>fs.readFileSync(new URL('../js/'+n,import.meta.url),'utf8');
const p=read('05-persistence.js');
const writes=[];let fullBuilds=0;
const active={id:'active',messages:[{role:'user',content:'hello',_parseState:{}}]};
const background={id:'background',messages:[{role:'assistant',content:'recovered',attachments:[{name:'keep'}]}]};
const ctx={console, state:{threads:[active,background],activeThreadId:'active'},STORAGE_BACKEND:'idb',
 getActiveThread:()=>active,idbPut:async(store,value)=>writes.push({store,value}),
 buildStateBlob:()=>{fullBuilds++;return {threads:[active,background]};},
 saveFullToIdb:blob=>writes.push({store:'full',value:blob}),scheduleStateSync(){},
 STORAGE_KEY:'state',localStorage:{setItem:(key,value)=>writes.push({store:'local',value})},storageQuotaHit:false};
vm.createContext(ctx);
vm.runInContext(p.slice(p.indexOf('const RUNTIME_MESSAGE_FIELDS'),p.indexOf('// In-memory `state`'))+'\n'+p.slice(p.indexOf('function saveState(opts)'),p.indexOf('function getActiveCard()')),ctx);
ctx.saveState({skipServerSchedule:true});
assert.equal(fullBuilds,0);assert.equal(writes[0].value.id,'active');
assert.equal(writes[0].value.messages[0]._parseState,undefined);
assert.ok(active.messages[0]._parseState,'checkpoint must not mutate live parser state');
ctx.saveState({skipServerSchedule:true,thread:background});
assert.equal(writes.at(-1).value.id,'background','persist generating thread even when another is selected');
assert.equal(writes.at(-1).value.messages[0].attachments[0].name,'keep');
ctx.saveState();assert.equal(fullBuilds,1);assert.equal(writes.at(-1).store,'full');
ctx.STORAGE_BACKEND='localstorage';ctx.saveState({skipServerSchedule:true});
assert.equal(fullBuilds,2);assert.equal(JSON.parse(writes.at(-1).value).threads.length,2,'fallback still saves whole state');

const u=read('18-utils.js');const md={console,
 escapeHtml:s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
 safeCssColor:s=>/^#[0-9a-f]{3,8}$/i.test(s)?s:'',DIALOG_QUOTE_RE:/(?:&quot;)(?:(?!\n\n)[\s\S]){1,400}?(?:&quot;)/g};
vm.createContext(md);vm.runInContext(u.slice(u.indexOf('/* ================================================================\n   MATH RENDERER'),u.indexOf('/* ================================================================\n   COLOR PICKER HELPERS')),md);
vm.runInContext('var parseCount=0; const originalParse=parseMarkdownUncached; parseMarkdownUncached=(...args)=>{parseCount++;return originalParse(...args)};',md);
const get=e=>vm.runInContext(e,md);
const text='**bold** and "dialog"';
const first=md.parseMarkdown(text,'#fff');assert.equal(md.parseMarkdown(text,'#fff'),first);assert.equal(get('parseCount'),1);
assert.notEqual(md.parseMarkdown(text,'#000'),first);assert.equal(get('parseCount'),2);
md.parseMarkdown(text+' changed','#fff');assert.equal(get('parseCount'),3);
for(let i=0;i<200;i++)md.parseMarkdown('Entry '+i+' '.repeat(5000),'');
assert.ok(get('markdownCacheBytes')<=1048576);assert.ok(get('markdownCache.size')<=128);
const large='x'.repeat(600000);md.parseMarkdown(large,'');assert.equal(get('markdownCache.has("\\0" + "x".repeat(600000))'),false);
// Random IDs must remain unique for identical file blocks in different messages.
vm.runInContext('parseMarkdownUncached=()=>mdRenderFileBlock("note.txt","hello");',md);
assert.notEqual(md.parseMarkdown('file-one',''),md.parseMarkdown('file-one',''));

const scroll=read('14-scroll.js');let parses=0;
const paint={parseMarkdown:(text,color)=>{parses++;return text+color;}};vm.createContext(paint);
vm.runInContext(scroll.slice(scroll.indexOf('const streamRenderInputs'),scroll.indexOf('function renderStreamingUpdate')),paint);
const element={innerHTML:''};paint.updateStreamMarkdown(element,'reasoning','#fff');paint.updateStreamMarkdown(element,'reasoning','#fff');assert.equal(parses,1);
paint.updateStreamMarkdown(element,'reasoning changed','#fff');paint.updateStreamMarkdown(element,'reasoning changed','#000');assert.equal(parses,3);
paint.updateStreamMarkdown({innerHTML:''},'reasoning changed','#000');assert.equal(parses,4,'rebuilt DOM still receives its contents');

const gen=read('03-generation.js');let rendered=0,saved=0,now=3000;
const msg={content:''},thread={id:'t',messages:[msg]};
const feederCtx={console:{log(){}},TextDecoder,Date:{now:()=>now},state:{activeThreadId:'t'},document:{visibilityState:'hidden'},
 shouldPaintWhileStreaming:()=>true,extractTokenFromLine:line=>line?{text:line,field:'content'}:null,
 processStreamDelta:(m,text)=>{m.content+=text;},maybeApplySmartLimit:()=>false,
 renderStreamingUpdate:()=>rendered++,saveState:opts=>{saved++;assert.equal(opts.thread,thread);}};
vm.createContext(feederCtx);vm.runInContext(gen.slice(gen.indexOf('function makeStreamFeeder'),gen.indexOf('async function startGenerationJob')),feederCtx);
const feed=feederCtx.makeStreamFeeder(msg,thread);feed.feed(new TextEncoder().encode('hidden\n'));
assert.equal(rendered,0);assert.equal(saved,1);assert.equal(msg.content,'hidden');
feederCtx.document.visibilityState='visible';now+=3000;feed.feed(new TextEncoder().encode('visible\n'));assert.equal(rendered,1);assert.equal(msg.content,'hiddenvisible');
console.log('Runtime save/render/cache regressions passed');
const sync=read('06-state-sync.js');
for(const scenario of ['normal','generating','target']){
 let clock=0,scheduled=0,pushed=0;let ledger={threads:{}};
 const syncCtx={console,Date:{now:()=>clock+=10},state:{threads:[{id:'a'}]},stateSync:{},stateSyncReloading:false,
 syncEnabled:()=>true,ensureSyncLedger:async()=>true,currentLedger:()=>ledger,
 setTimeout:resolve=>{if(scenario==='target')ledger={threads:{}};resolve();},
 stateSyncWouldBeTransient:()=>scenario==='generating',scheduleStateSync:()=>scheduled++,
 isAddressableThreadId:()=>true,pushOneThread:async()=>{pushed++;return 'unchanged';},pushMeta:async()=> 'unchanged',syncTargetLabel:()=> 'shared'};
 vm.createContext(syncCtx);vm.runInContext(sync.slice(sync.indexOf('async function pushChangedConversations(opts)'),sync.indexOf('/* -- Comparing')),syncCtx);
 await syncCtx.pushChangedConversations();
 assert.equal(pushed,scenario==='normal'?1:0);
 assert.equal(scheduled,scenario==='generating'?1:0);
}
