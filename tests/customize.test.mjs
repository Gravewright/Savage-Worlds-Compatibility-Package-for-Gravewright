import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsManager, normalizeSettings, effectiveRules, currencyLabel, SETTINGS_KEY} from '../settings.js';
import {createDeckImporter, validateDeckCatalog} from '../deck-importer.js';

const copy = value => structuredClone(value);
const failure = code => Object.assign(new Error(code), {code});
function store() {
  const rows = new Map();
  return {rows, async get(key){return copy(rows.get(key) ?? null);},
    async set(key, value, {expectedRevision}){
      const old = rows.get(key);
      if ((old?.revision ?? null) !== expectedRevision) throw failure('conflict');
      const next = {value:copy(value),revision:(old?.revision ?? 0)+1}; rows.set(key,next); return copy(next);
    }, async delete(key,{expectedRevision}){
      if (rows.get(key)?.revision !== expectedRevision) throw failure('conflict'); rows.delete(key);
    }};
}
function catalog() {
  return {schemaVersion:1,themes:['ivory','gravewright','adventure'].map(id=>({
    id,back:`assets/action-decks/${id}/back.webp`,preview:`assets/action-decks/${id}/preview.webp`,
    cards:Array.from({length:54},(_,index)=>({name:index<52?`User card ${index+1}`:`User Joker ${index-51}`,front:`assets/action-decks/${id}/front-${index}.webp`})),
  }))};
}
function importerFixture({isGM = true, lostDefine = false, lostInstance = false} = {}) {
  const storage = {user:store()}, decks = new Map(), receipts = new Map(), uploaded = [], read = [], definitions = [];
  const counts = {define:0,instantiate:0}; let defineLost=lostDefine,instanceLost=lostInstance;
  async function command(method,payload,{requestId}) {
    if (!receipts.has(requestId)) {
      if (method === 'define') {counts.define++; definitions.push(copy(payload)); receipts.set(requestId,{deck:{id:`definition-${counts.define}`}});}
      else {counts.instantiate++; const deck={id:`instance-${counts.instantiate}`,name:definitions.at(-1).name}; decks.set(deck.id,deck);receipts.set(requestId,{id:deck.id});}
    }
    if (method === 'define' && defineLost) {defineLost=false;throw failure('unavailable');}
    if (method === 'instantiate' && instanceLost) {instanceLost=false;throw failure('unavailable');}
    return copy(receipts.get(requestId));
  }
  const api = {cards:{state:async()=>({isGM,decks:[...decks.values()].map(copy)}),
    define:(payload,options)=>command('define',payload,options),instantiate:(payload,options)=>command('instantiate',payload,options)}};
  const host = {call:async(name,payload)=>{
    assert.equal(name,'card.asset.upload');assert.ok(payload.file instanceof File);assert.equal(payload.file.type,'image/webp');
    uploaded.push({purpose:payload.purpose,name:payload.file.name});return {assetId:`asset-${uploaded.length}`};
  }};
  const assets = {bytes:async path=>{read.push(path);return new Uint8Array([1,2,3]);}};
  const create = () => createDeckImporter({api,host,assets,storage});
  return {storage,decks,counts,uploaded,read,definitions,api,host,assets,create};
}

test('table rules and currency normalize without changing manual actor overrides',()=>{
  const settings=normalizeSettings({currency:{enabled:false,label:'  Credits  '},rules:{noPowerPoints:true,woundCap:true,jokersWild:false}});
  assert.equal(currencyLabel(settings),'Credits');assert.equal(settings.currency.enabled,false);
  const sheet={rules:{noPowerPoints:false,woundCap:null},resources:{gold:10}},before=copy(sheet);
  const inherited=effectiveRules(sheet,settings);
  assert.equal(inherited.noPowerPoints,false);assert.equal(inherited.woundCap,true);assert.equal(inherited.jokersWild,false);assert.deepEqual(sheet,before);
  assert.equal(inherited.enableWoundPace,true);assert.equal(inherited.applyEncumbrance,true);
  const defaults=normalizeSettings().rules;assert.equal(defaults.noPowerPoints,false);assert.equal(defaults.woundCap,false);assert.equal(defaults.jokersWild,true);
  assert.equal(defaults.enableWoundPace,true);assert.equal(defaults.applyEncumbrance,true);
});

test('settings manager uses GM-only CAS, publishes isolated values, and honors actor-independent storage',async()=>{
  const storage={table:store()},api={cards:{state:async()=>({isGM:true})}},manager=createSettingsManager({api,storage,pollInterval:0});
  await manager.start();const observed=[];const unsubscribe=manager.subscribe(value=>{observed.push(value);value.currency.label='mutated observer';});
  const value=normalizeSettings({currency:{label:'Credits'},rules:{jokersWild:false},deck:{instanceId:'chosen-native'}});
  await manager.save(value);assert.equal(manager.current.currency.label,'Credits');assert.equal(manager.current.deck.instanceId,'chosen-native');assert.equal(observed.length,1);
  const returned=manager.current;returned.rules.jokersWild=true;assert.equal(manager.current.rules.jokersWild,false);
  assert.deepEqual((await storage.table.get(SETTINGS_KEY)).value,value);
  unsubscribe();await manager.save({...value,currency:{enabled:true,label:'Gold'}});assert.equal(observed.length,1);manager.dispose();
  const player=createSettingsManager({api:{cards:{state:async()=>({isGM:false})}},storage,pollInterval:0});await player.start();
  await assert.rejects(player.save(value),{code:'permission_denied'});assert.equal((await storage.table.get(SETTINGS_KEY)).value.currency.label,'Gold');player.dispose();
});

test('settings conflict preserves the other GM update and refresh publishes it instead of overwriting',async()=>{
  const storage={table:store()},api={cards:{state:async()=>({isGM:true})}};
  const first=createSettingsManager({api,storage,pollInterval:0}),second=createSettingsManager({api,storage,pollInterval:0});
  await first.start();await second.start();await first.save(normalizeSettings({currency:{label:'Credits'}}));
  await assert.rejects(second.save(normalizeSettings({currency:{label:'Coins'}})),{code:'conflict'});
  assert.equal((await storage.table.get(SETTINGS_KEY)).value.currency.label,'Credits');await second.refresh();assert.equal(second.current.currency.label,'Credits');first.dispose();second.dispose();
});

test('three-theme catalog requires unique 54 faces and rejects invalid package paths',()=>{
  assert.equal(validateDeckCatalog(catalog()).themes.length,3);
  for (const mutate of [value=>value.themes.pop(),value=>value.themes[1].id='ivory',value=>value.themes[0].cards.pop(),
    value=>value.themes[0].cards[1].name=value.themes[0].cards[0].name,value=>value.themes[0].cards[1].front=value.themes[0].cards[0].front,
    value=>value.themes[0].back='assets/action-decks/../private.png']) {
    const invalid=catalog();mutate(invalid);assert.throws(()=>validateDeckCatalog(invalid),{code:'deck-catalog-invalid'});
  }
});

test('an explicit theme import uploads one back and 54 fronts before one native definition and instance',async()=>{
  const theme=catalog().themes[0],f=importerFixture(),progress=[];
  const result=await f.create().importTheme(theme,{name:'My chosen deck',onProgress:value=>progress.push(value)});
  assert.deepEqual(result,{instanceId:'instance-1',themeId:'ivory',name:'My chosen deck'});
  assert.equal(f.uploaded.length,55);assert.equal(f.uploaded.filter(value=>value.purpose==='card_back').length,1);assert.equal(f.counts.define,1);assert.equal(f.counts.instantiate,1);
  assert.equal(f.definitions[0].cards.length,54);assert.equal(f.definitions[0].default_back_asset_id,'asset-1');assert.equal(f.definitions[0].cards[0].front_asset_id,'asset-2');
  assert.equal(progress.at(-1).stage,'complete');assert.equal(progress.at(-1).completed,55);
  assert.deepEqual(await f.create().importTheme(theme),result);assert.equal(f.uploaded.length,55);assert.equal(f.counts.instantiate,1);
});

test('import retries lost native definition and instance responses under the same receipts',async()=>{
  for (const configuration of [{lostDefine:true},{lostInstance:true}]) {
    const theme=catalog().themes[1],f=importerFixture(configuration);
    await assert.rejects(f.create().importTheme(theme,{name:'Shared artwork'}),{code:'unavailable'});
    const result=await f.create().importTheme(theme);assert.equal(result.instanceId,'instance-1');
    assert.equal(f.uploaded.length,55);assert.equal(f.counts.define,1);assert.equal(f.counts.instantiate,1);
  }
});

test('a committed image checkpoint survives a lost storage response without uploading the image again',async()=>{
  const theme=catalog().themes[2],f=importerFixture(),set=f.storage.user.set;let lost=false;
  f.storage.user.set=async(key,value,options)=>{const result=await set(key,value,options);if(!lost&&Object.keys(value.assets??{}).length===1){lost=true;throw failure('unavailable');}return result;};
  await assert.rejects(f.create().importTheme(theme),{code:'unavailable'});assert.equal(f.uploaded.length,1);
  await f.create().importTheme(theme);assert.equal(f.uploaded.length,55);assert.equal(f.counts.define,1);assert.equal(f.counts.instantiate,1);
});

test('a removed native instance reuses the saved image assets and definition with a fresh instantiate receipt',async()=>{
  const theme=catalog().themes[0],f=importerFixture();await f.create().importTheme(theme);f.decks.delete('instance-1');
  const recreated=await f.create().importTheme(theme);assert.equal(recreated.instanceId,'instance-2');assert.equal(f.uploaded.length,55);assert.equal(f.counts.define,1);assert.equal(f.counts.instantiate,2);
});

test('players never upload, define or instantiate; cancellation retains a resumable completed-image checkpoint',async()=>{
  const theme=catalog().themes[0],player=importerFixture({isGM:false});
  await assert.rejects(player.create().importTheme(theme),{code:'permission_denied'});assert.equal(player.uploaded.length,0);assert.equal(player.storage.user.rows.size,0);
  const f=importerFixture(),abort=new AbortController();
  await assert.rejects(f.create().importTheme(theme,{signal:abort.signal,onProgress:()=>abort.abort()}),{code:'cancelled'});
  assert.equal(f.uploaded.length,1);assert.equal(f.counts.define,0);assert.equal(f.counts.instantiate,0);
  await f.create().importTheme(theme);assert.equal(f.uploaded.length,55);assert.equal(f.counts.instantiate,1);
});
