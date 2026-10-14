import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createItemSaveController, itemImageUrl} from '../item-editor.js';

const item = (canEdit = true) => ({id: 'library-item', type: 'weapon', name: 'Custom item', version: 2, canEdit, data: {description: '', custom: {retained: true}}});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

test('a close flush serializes edits made while the first versioned write is in flight', async () => {
  const first = deferred(), writes = [];
  const controller = createItemSaveController({item: item(), delay: 60000, write: async payload => {
    writes.push(payload);
    if (writes.length === 1) { await first.promise; return {item: {version: 8}}; }
    return {item: {version: 9}};
  }});
  controller.change('description', 'First draft');
  const closing = controller.flush();
  controller.change('description', 'Latest draft');
  controller.change('core.name', 'User title');
  assert.equal(controller.flush(), closing);
  assert.equal(writes[0].data.description, 'First draft');
  assert.equal(writes[0].version, 2);
  first.resolve(); await closing;
  assert.equal(writes.length, 2);
  assert.equal(writes[1].version, 8);
  assert.equal(writes[1].name, 'User title');
  assert.equal(writes[1].data.description, 'Latest draft');
  assert.deepEqual(writes[1].data.custom, {retained: true});
  assert.equal(controller.dirty, false);
  controller.dispose();
});

test('readonly documents and disposed mounts cannot schedule a mutation', async () => {
  let writes = 0;
  const readonly = createItemSaveController({item: item(false), write: async () => { writes++; }});
  assert.equal(readonly.change('description', 'Attempted change'), false);
  await readonly.flush(); readonly.dispose();
  const abort = new AbortController(), cancelled = createItemSaveController({item: item(), signal: abort.signal, delay: 60000, write: async () => { writes++; }});
  cancelled.change('description', 'Unsaved local draft'); abort.abort();
  assert.equal(cancelled.change('description', 'Later change'), false);
  await cancelled.flush();
  assert.equal(writes, 0);
});

test('conflicts keep the local draft and prevent stale retries or remote replacement', async () => {
  let writes = 0; const conflict = Object.assign(new Error('Concurrent write'), {code: 'conflict'});
  const controller = createItemSaveController({item: item(), delay: 60000, write: async () => { writes++; throw conflict; }});
  controller.change('description', 'Local draft');
  await assert.rejects(controller.flush(), error => error === conflict);
  assert.equal(controller.replace({...item(), version: 3, data: {description: 'Remote draft'}}), false);
  controller.change('description', 'Retained local correction');
  await assert.rejects(controller.flush(), error => error === conflict);
  assert.equal(writes, 1);
  assert.equal(controller.item.data.description, 'Retained local correction');
  assert.equal(controller.dirty, true); controller.dispose();
});

test('a failed transport preserves the draft and allows an explicit successful retry', async () => {
  let writes = 0; const states = [];
  const controller = createItemSaveController({item: item(), delay: 60000, onStatus: state => states.push(state), write: async () => {
    if (++writes === 1) throw Object.assign(new Error('Offline'), {code: 'network_error'});
    return {item: {version: 3}};
  }});
  controller.change('damage', 'User formula');
  await assert.rejects(controller.flush());
  assert.equal(controller.dirty, true);
  await controller.flush();
  assert.equal(controller.item.version, 3);
  assert.equal(controller.dirty, false);
  assert.ok(states.includes('error')); assert.equal(states.at(-1), 'saved'); controller.dispose();
});

test('an idle refresh can update permissions without replacing dirty data', async () => {
  const controller = createItemSaveController({item: item(), delay: 60000, write: async () => ({version: 3})});
  controller.change('description', 'Local draft');
  assert.equal(controller.replace({...item(), version: 5}), false);
  await controller.flush();
  assert.equal(controller.replace({...item(false), version: 5, data: {description: 'Remote update'}}), true);
  assert.equal(controller.item.data.description, 'Remote update');
  assert.equal(controller.change('description', 'Denied'), false); controller.dispose();
});

test('image previews accept web and native media addresses while excluding executable or temporary schemes', () => {
  assert.equal(itemImageUrl('/media/custom.png', 'https://table.example/game/'), 'https://table.example/media/custom.png');
  assert.equal(itemImageUrl('https://images.example/item.webp'), 'https://images.example/item.webp');
  for (const address of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'blob:https://table.example/temp', '//images.example/item.png', '/\\images.example/item.png', 'file:///private.png', '', null]) assert.equal(itemImageUrl(address), '');
});

test('blank names remain in the local draft and cannot reach the native mutation', async () => {
  const writes = [], controller = createItemSaveController({item: item(), delay: 60000, write: async payload => {writes.push(payload); return {version: 3};}});
  controller.change('description', 'Keep this text'); controller.change('core.name', '  ');
  await assert.rejects(controller.flush(), error => error.code === 'validation' && error.field === 'core.name');
  assert.equal(writes.length, 0); assert.equal(controller.item.name, '  ');
  assert.equal(controller.item.data.description, 'Keep this text');
  controller.change('core.name', 'User-defined item'); await controller.flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].data.description, 'Keep this text'); controller.dispose();
});

test('confirmed conflict recovery replaces the local draft and restores editing against the current version', async () => {
  let conflicting = true;
  const controller = createItemSaveController({item: item(), delay: 60000, write: async payload => {
    if (conflicting) throw Object.assign(new Error('Concurrent write'), {code: 'conflict'});
    assert.equal(payload.version, 7); return {version: 8};
  }});
  controller.change('description', 'Local draft'); await assert.rejects(controller.flush());
  assert.equal(controller.conflicted, true);
  assert.equal(controller.replace({...item(), version: 7}), false);
  assert.equal(controller.reload({...item(), version: 7, data: {description: 'Current document'}}), true);
  assert.equal(controller.conflicted, false); assert.equal(controller.dirty, false);
  assert.equal(controller.item.data.description, 'Current document');
  conflicting = false; controller.change('description', 'New edit'); await controller.flush();
  assert.equal(controller.item.version, 8); controller.dispose();
});

test('names follow the native 120 character budget without sending or truncating an oversized draft', async () => {
  const writes = [], controller = createItemSaveController({item: item(), delay: 60000, write: async payload => {writes.push(payload); return {version: 3};}});
  controller.change('core.name', 'A'.repeat(121));
  await assert.rejects(controller.flush(), error => error.code === 'validation' && error.reason === 'too_long' && error.max === 120);
  assert.equal(writes.length, 0); assert.equal(controller.item.name.length, 121);
  controller.change('core.name', 'A'.repeat(120)); await controller.flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].name.length, 120); controller.dispose();
});
