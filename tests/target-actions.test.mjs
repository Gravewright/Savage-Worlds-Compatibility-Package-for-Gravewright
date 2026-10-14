import test from 'node:test';
import assert from 'node:assert/strict';
import {createSheet} from '../model.js';
import {applySupport, createTargetWriteWorkflow} from '../target-actions.js';

const success = {success: true, critical: false, raises: 0};
const raise = {...success, raises: 1};

test('support caps the current total, keeps Strength uncapped and expires on the recipient turn', () => {
  const initial = createSheet(); initial.notes = 'Authored';
  let sheet = applySupport(initial, raise, 'skill.custom', {name: 'Authored label', sourceActorId: 'source'});
  sheet = applySupport(sheet, raise, 'skill.custom');
  assert.equal(sheet.effects.length, 2);
  assert.equal(applySupport(sheet, success, 'skill.custom'), null);
  const penalty = applySupport(sheet, {critical: true}, 'skill.custom');
  assert.equal(penalty.effects.at(-1).data.modifiers[0].value, -2);
  const restored = applySupport(penalty, raise, 'skill.custom');
  assert.equal(restored.effects.at(-1).data.modifiers[0].value, 2);
  let strength = createSheet(); for (let i = 0; i < 3; i++) strength = applySupport(strength, raise, 'attribute.strength');
  assert.equal(strength.effects.length, 3);
  assert.deepEqual({...sheet.effects[0].data, modifiers: undefined, description: undefined, notes: undefined, img: undefined, source: undefined, duration: undefined},
    {category: 'support', active: true, remaining: 1, phase: 'end', owner: 'self', sourceActorId: 'source', sourceTokenId: '', modifiers: undefined, description: undefined, notes: undefined, img: undefined, source: undefined, duration: undefined});
  assert.equal(initial.effects.length, 0); assert.equal(sheet.notes, 'Authored');
});

test('inactive and disabled support does not consume the bonus budget', () => {
  let sheet = applySupport(createSheet(), raise, 'attribute.spirit');
  sheet.effects[0].active = false;
  sheet = applySupport(sheet, raise, 'attribute.spirit');
  sheet.effects[1].data.modifiers[0].enabled = false;
  assert.equal(applySupport(sheet, raise, 'attribute.spirit').effects.at(-1).data.modifiers[0].value, 2);
  assert.equal(applySupport(sheet, {success: false, critical: false}, 'attribute.spirit'), null);
});

test('a lost target-save response retries the exact receipt and transformed version once', async () => {
  let reads = 0, mutations = 0, writes = 0; const payloads = [], receipts = new Map();
  const current = {name: 'Recipient', canEdit: true, version: 7, sheetVersion: 11, data: createSheet()};
  const api = {actors: {sheet: async () => {reads++; return structuredClone(current);}, saveSheet: async (payload, options) => {
    payloads.push({payload: structuredClone(payload), requestId: options.requestId});
    if (!receipts.has(options.requestId)) {writes++; receipts.set(options.requestId, {version: 8, sheetVersion: 12});}
    if (payloads.length === 1) throw Error('Response lost');
    return receipts.get(options.requestId);
  }}};
  const workflow = createTargetWriteWorkflow({api, actorId: 'recipient', tokenId: 'independent', transform: (data, outcome) => {
    mutations++; return applySupport(data, outcome, 'attribute.spirit');
  }});
  await assert.rejects(workflow.run(raise));
  current.data.notes = 'Concurrent local mutation'; current.version = 99;
  const saved = await workflow.run({critical: true});
  await workflow.run(raise);
  assert.deepEqual(payloads[0], payloads[1]); assert.deepEqual([reads, mutations, writes], [1, 1, 1]);
  assert.equal(payloads[0].payload.tokenId, 'independent'); assert.equal(saved.version, 8); assert.equal(saved.data.effects.length, 1);
  assert.equal(saved.data.effects[0].data.modifiers[0].value, 2);
});

test('target writes coalesce and recheck permissions before a transformation', async () => {
  let release, writes = 0; const read = new Promise(resolve => {release = resolve;});
  const api = {actors: {sheet: () => read, saveSheet: async () => {writes++;}}};
  const workflow = createTargetWriteWorkflow({api, actorId: 'recipient', transform: () => {throw Error('Must not transform');}});
  const first = workflow.run(success), second = workflow.run(success); assert.equal(first, second);
  release({canEdit: false, data: createSheet()});
  await assert.rejects(first, error => error.code === 'forbidden'); assert.equal(writes, 0);
});

test('cancellation and outcomes with no target change do not issue a native write', async () => {
  let writes = 0; const controller = new AbortController();
  const api = {actors: {sheet: async () => ({canEdit: true, data: createSheet()}), saveSheet: async () => {writes++;}}};
  const unchanged = createTargetWriteWorkflow({api, actorId: 'recipient', transform: () => null});
  assert.equal((await unchanged.run({success: false})).unchanged, true); assert.equal(unchanged.completed, true);
  controller.abort();
  await assert.rejects(createTargetWriteWorkflow({api, actorId: 'recipient', signal: controller.signal, transform: data => data}).run(success), error => error.code === 'cancelled');
  assert.equal(writes, 0);
});
