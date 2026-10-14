import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceClocks,beginTurn} from '../clocks.js';
const event=changes=>({phase:'end',roundBoundary:false,isCurrent:true,actorId:'caster',tokenId:'caster-token',documentKey:['actor','owner'],clockKeys:new Set(),...changes});
const sheet=()=>({status:{distracted:true},statusClocks:{distracted:{remaining:1,phase:'end',owner:'self',awaitingStart:true}},
  effects:[{data:{active:true,remaining:2,phase:'start',owner:'self',duration:'User text'}}],combat:{cardInitiative:true}});

test('card boundary waits for sorted first-actor selection, then arms and ticks exact clocks',()=>{
  const initial=sheet();assert.deepEqual(advanceClocks(initial,event({phase:'start',roundBoundary:true})),{sheet:initial,changed:false});
  const start=event({phase:'start'}),armed=beginTurn(initial,start);
  assert.equal(armed.statusClocks.distracted.awaitingStart,false);assert.equal(armed.effects[0].data.remaining,1);
  assert.equal(initial.statusClocks.distracted.awaitingStart,true);
  assert.equal(advanceClocks(armed,start).changed,false);
  const end=advanceClocks(armed,event());assert.equal(end.sheet.status.distracted,false);assert.deepEqual(end.sheet.statusClocks,{});
  assert.equal(end.sheet.effects[0].data.duration,'User text');
});

test('source effects advance on another owner while independent snapshots have their own clock key',()=>{
  const initial={effects:[{data:{active:true,remaining:3,phase:'start',owner:'source',sourceActorId:'caster'}}]};
  const source=event({phase:'start',isCurrent:false}),first=advanceClocks(initial,source);
  assert.equal(first.sheet.effects[0].data.remaining,2);assert.equal(advanceClocks(first.sheet,source).changed,false);
  const independent=advanceClocks(initial,{...source,documentKey:['token','independent']});assert.equal(independent.sheet.effects[0].data.remaining,2);
});

test('invalid or descriptive clock values do not become accidental numeric durations',()=>{
  for(const remaining of ['',null,true,[],{},'0x10',-1,1.5,10001]){
    const initial={effects:[{data:{active:true,remaining,phase:'end',owner:'self'}}]};
    assert.equal(advanceClocks(initial,event()).changed,false);
  }
});
