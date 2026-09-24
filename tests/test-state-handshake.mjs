// Exercise real restore, migrations, code quarantine and boot ordering.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = n => fs.readFileSync(new URL('../js/' + n, import.meta.url), 'utf8');
const persistence = read('05-persistence.js');
const apply = persistence.slice(persistence.indexOf('function applyLoadedState('), persistence.indexOf('// Async loader.'));
const cardCode = read('23-card-code.js');
const neutralize = cardCode.slice(cardCode.indexOf('function neutralizeUntrustedCode('), cardCode.indexOf('/**\n * Strip code off'));
const snapshot = () => ({threads: [], characterCards: [{id:'a',name:'One',customCodeEnabled:true},{id:'b',name:'Two'}], activeCardId:'b', personaCards:[{id:'p',name:'Reader'}], activePersonaId:'p', settings:{remoteImageNoticeSeen:true}, extensions:{enabled:true}});
function harness({storage='denied', remote=snapshot(), status=200, delayed=false}={}) {
  let release, fail=status;
  const gate = delayed ? new Promise(resolve => {release=resolve;}) : Promise.resolve();
  const calls=[], paints=[], cache=new Map();
  const store={getItem:()=>null,setItem(k,v){if(storage==='denied') throw new Error('Storage denied'); if(storage!=='discard')cache.set(k,v);},removeItem(){}};
  const ctx={console:{log(){},warn(){},error(){}},IS_SERVED:true,window:{location:{origin:'http://local'},innerWidth:1000,addEventListener(){}},
    location:{reload(){throw Error('Unexpected reload');}},localStorage:store,sessionStorage:{getItem:()=> '1',setItem(){}},
    document:{addEventListener(){},getElementById:()=>({classList:{toggle(){}},textContent:''}),querySelector:()=>null},
    state:{threads:[],settings:{},characterCards:[{id:'default',name:'Assistant'}]},isGenerating:false,
    DEFAULT_SETTINGS:{},DEFAULT_CARD:{id:'default'},DEFAULT_PERSONA:{id:'default'},DEFAULT_MACROS:[],STATE_SCHEMA_VERSION:1,
    loadedSchemaVersion:null,hadOwnSettings:false,sortThreadsByOrder(){},migrateExtensions:e=>e||{},
    STORAGE_BACKEND:'localstorage',STORAGE_KEY:'state',_idbFullSaveTimer:null,_idbPendingBlob:null,storageQuotaHit:false,
    setTimeout:()=>1,clearTimeout(){},setInterval(){},TextEncoder,alert(){},confirm:()=>true,
    buildStateBlob:()=>structuredClone(ctx.state),buildStateMeta:()=>({settings:ctx.state.settings}),
    isQuotaError:e=>e.name==='QuotaExceededError',searchEnabled:false,defaultCharacters:[],_appBooted:false,
    loadState:async()=>{},loadServerPresets:async()=>{},seedSettingsFromServerPresets(){},loadActiveModel:async()=>{},loadModelsList(){},
    setupInput(){},applyExtensions(){},applyCardCode(){},applyAvatarScale(){},render(){paints.push(ctx.state.characterCards.map(c=>c.id));},
    scrollToBottom(){},attachScrollPinTracking(){},applyActiveCardBackground(){},saveState(){},updateSchedCount(){},
    checkConnection:async()=>{},checkSchedules(){},resumePendingJobs:async()=>{},
    fetch:async(url,opts={})=>{
      calls.push({url,method:opts.method||'GET'});
      if(url==='default-characters.json')return {ok:true,json:async()=>[]};
      await gate;
      if(fail===0)throw Error('Network unavailable');
      return {ok:fail===200,status:fail,headers:{get:()=> '42'},
        json:async()=>url.includes('/info')?{size:500,mtime:42}:structuredClone(remote),text:async()=>JSON.stringify(remote)};
    }};
  vm.createContext(ctx);
  vm.runInContext(apply+'\n'+neutralize+'\n'+read('06-state-sync.js'),ctx);
  // UI and ledger persistence are not the subject of this harness.
  vm.runInContext('updateSyncIndicator = () => {}; persistSyncMeta = () => {};',ctx);
  return {ctx,calls,paints,cache,release,setStatus:v=>{fail=v;},get:e=>vm.runInContext(e,ctx),boot(){vm.runInContext('ensureSyncLedger=async()=>true; reconcileWithServer=async()=>{};',ctx);vm.runInContext(read('24-boot.js'),ctx);return ctx.window.GobboNet.ready;}};
}
for (const storage of ['denied','discard','working']) {
  const h=harness({storage});
  await h.ctx.checkServerStateOnBoot();
  assert.deepEqual(Array.from(h.ctx.state.characterCards,c=>c.id),['a','b']);
  assert.equal(h.ctx.state.activeCardId,'b');
  assert.equal(h.ctx.state.personaCards[0].name,'Reader');
  assert.equal(h.ctx.state.activePersonaId,'p');
  assert.equal(h.ctx.state.characterCards[0].customCodeEnabled,false);
  assert.equal(h.ctx.state.extensions.enabled,false);
  assert.equal(h.ctx.state.threads.length,0);
  assert.ok(h.calls.every(c=>c.method==='GET'));
  if(storage==='working')assert.ok(h.cache.has('state'));
}
for (const denied of [false, true]) {
 const h=harness();const writes=[];
 h.ctx.STORAGE_BACKEND='idb';
 h.ctx.idbPut=async(store,value)=>{if(denied)throw Error('IDB denied');writes.push(value);};
 h.ctx.idbClearThreads=async()=>writes.push('cleared');
 h.ctx.idbBulkPutThreads=async threads=>writes.push(threads);
 h.ctx.metaPartOf=blob=>{const {threads,...meta}=blob;return meta;};
 await h.ctx.checkServerStateOnBoot();
 assert.equal(h.ctx.state.activeCardId,'b');
 if(!denied){assert.equal(writes[0].characterCards.length,2);assert.equal(writes[1],'cleared');assert.equal(writes[2].length,0);}
}
{
 const remote=snapshot();delete remote.threads;
 const h=harness({remote});await h.ctx.checkServerStateOnBoot();
 assert.equal(h.ctx.state.activeCardId,'b','legacy metadata-only snapshot');
}
{
 const h=harness();h.ctx.state.threads=[{id:'local',messages:[{role:'user',content:'Keep me'}]}];
 assert.equal(await h.ctx.restoreFromServer({silent:true,boot:true}),true);
 assert.equal(h.ctx.state.threads[0].messages[0].content,'Keep me');
}
{
 const remote=snapshot();remote.threads=[{id:'remote',messages:[{role:'user',content:'Server chat'}]}];
 const h=harness({remote});await h.ctx.checkServerStateOnBoot();
 assert.equal(h.ctx.state.threads[0].id,'remote','storage-free boot also restores existing chats');
}
{
 const h=harness({status:0});await h.ctx.checkServerStateOnBoot();
 assert.equal(h.get('stateSync.status'),'error');h.setStatus(200);
 await h.ctx.checkServerStateOnBoot();assert.equal(h.ctx.state.activeCardId,'b','failed attempt does not lock retry');
}
for(const remote of [[],null,{threads:'bad'},{threads:[{id:'x',messages:'bad'}]},{threads:[],characterCards:[null]}]) {
 const h=harness({remote});assert.equal(await h.ctx.restoreFromServer({silent:true,inPlace:true,boot:true}),false);
 assert.equal(h.ctx.state.characterCards[0].id,'default');
 await assert.rejects(h.ctx.window.GobboNet.fetchServerState());
}
{
 const h=harness();const before=JSON.stringify(h.ctx.state);
 const result=await h.ctx.window.GobboNet.fetchServerState({profile:'Dev'});
 assert.equal(result.characterCards[0].customCodeEnabled,true,'read-only fetch does not rewrite the snapshot');
 assert.equal(JSON.stringify(h.ctx.state),before);
 assert.equal(h.calls[0].url,'http://local/state?profile=dev');
 assert.equal(h.calls[0].method,'GET');assert.equal(h.cache.size,0);
 await assert.rejects(h.ctx.window.GobboNet.fetchServerState({profile:'../bad'}));
 h.setStatus(404);assert.equal(await h.ctx.window.GobboNet.fetchServerState(),null);
 h.setStatus(500);await assert.rejects(h.ctx.window.GobboNet.fetchServerState());
}
{
 const h=harness({delayed:true});let settled=false;
 const ready=h.boot().then(result=>{settled=true;return result;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false);assert.equal(h.paints.length,0,'do not paint temporary defaults before restore');
 h.release();const result=await ready;
 assert.equal(result.ok,true);assert.deepEqual(Array.from(h.paints[0]),['a','b']);
}
{
 const h=harness({status:0});const result=await h.boot();
 assert.equal(result.ok,false);assert.match(result.error,/Network unavailable/);
}
console.log('State restore and integration handshake regressions passed');
