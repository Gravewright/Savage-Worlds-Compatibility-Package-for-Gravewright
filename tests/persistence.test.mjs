import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaveQueue} from '../persistence.js';

test('close flush includes edits made while the first write is in flight', async () => {
  let value = 1, release; const writes = [];
  const queue = createSaveQueue({read: () => ({value}), delay: 60000, write: async data => {
    writes.push(data); if (writes.length === 1) await new Promise(resolve => {release = resolve;});
  }});
  queue.mark(); const flush = queue.flush(); value = 2; queue.mark(); release(); await flush;
  assert.deepEqual(writes, [{value: 1}, {value: 2}]); assert.equal(queue.dirty, false); queue.dispose();
});

test('revision conflict keeps the draft dirty and prevents stale automatic retries', async () => {
  let calls = 0; const error = Object.assign(new Error('changed'), {code: 'conflict'});
  const queue = createSaveQueue({read: () => ({value: 1}), write: async () => {calls++; throw error;}, delay: 60000});
  queue.mark(); await assert.rejects(queue.flush(), error); queue.mark(); await assert.rejects(queue.flush(), error);
  assert.equal(calls, 1); assert.equal(queue.dirty, true); assert.equal(queue.conflicted, true); queue.dispose();
});

test('a transient save failure can retry the same unsaved draft', async () => {
  let calls = 0;
  const queue = createSaveQueue({read: () => ({value: 7}), write: async () => {if (++calls === 1) throw new Error('network');}, delay: 60000});
  queue.mark(); await assert.rejects(queue.flush()); assert.equal(queue.dirty, true);
  await queue.flush(); assert.equal(queue.dirty, false); assert.equal(calls, 2); queue.dispose();
});

test('a lost commit response replays the same receipt before saving edits made afterwards', async () => {
  let value=1,lost=true;const receipts=new Map(),requests=[];
  const queue=createSaveQueue({read:()=>({value}),delay:60000,write:async(data,{requestId})=>{
    requests.push({data,requestId});
    if(receipts.has(requestId))return receipts.get(requestId);
    receipts.set(requestId,structuredClone(data));
    if(lost){lost=false;throw new Error('response lost after commit');}
  }});
  queue.mark();await assert.rejects(queue.flush());value=2;queue.mark();await queue.flush();
  assert.deepEqual(requests.map(request=>request.data.value),[1,1,2]);
  assert.equal(requests[0].requestId,requests[1].requestId);
  assert.notEqual(requests[1].requestId,requests[2].requestId);
  assert.equal(receipts.size,2);assert.equal(queue.dirty,false);queue.dispose();
});
