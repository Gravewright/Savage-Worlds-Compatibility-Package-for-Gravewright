import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopyWorkflow, createItemWorkflow, searchText} from '../workflow.js';

test('library search matches accents and capitalization', () => {
  assert.equal(searchText('Perícia Ágil'), 'pericia agil');
  assert.ok(searchText('Perícia pessoal').includes(searchText('PERICIA')));
});

test('retry after an actor save failure does not create a second item or copy', async () => {
  let creates = 0, copies = 0, saves = 0;
  const workflow = createItemWorkflow({create: async input => {creates++; return {...input, id: 'source'};},
    append: () => {copies++;}, flush: async () => {if (++saves === 1) throw new Error('network');}});
  await assert.rejects(workflow.run({name: 'Authored item'}));
  await workflow.run({name: 'Authored item'});
  assert.deepEqual([creates, copies, saves], [1, 1, 2]);
});

test('a creation retry reuses its receipt and original payload', async () => {
  const writes = []; let copies = 0;
  const workflow = createItemWorkflow({create: async (input, options) => {
    writes.push({input, options}); if (writes.length === 1) throw new Error('response lost'); return {id: 'source'};
  }, append: () => {copies++;}, flush: async () => {}});
  const input = {name: 'Original', data: {notes: 'Original'}};
  await assert.rejects(workflow.run(input)); input.data.notes = 'Edited externally';
  await workflow.run(input);
  assert.deepEqual(writes[0], writes[1]); assert.equal(copies, 1);
});

test('double submission shares one in-flight workflow', async () => {
  let release, creates = 0, copies = 0;
  const workflow = createItemWorkflow({create: async () => {creates++; await new Promise(resolve => {release = resolve;}); return {id: 'source'};},
    append: () => {copies++;}, flush: async () => {}});
  const first = workflow.run({name: 'Item'}), second = workflow.run({name: 'Item'});
  assert.equal(first, second); release(); await first; assert.deepEqual([creates, copies], [1, 1]);
});

test('a library copy retry saves the same appended row without reading or appending twice', async () => {
  let reads = 0, copies = 0, saves = 0;
  const copy = createCopyWorkflow({read: async () => {reads++; return {id: 'source'};},
    append: () => {copies++;}, flush: async () => {if (++saves === 1) throw new Error('network');}});
  await assert.rejects(copy.run()); assert.equal(copy.failed, true); assert.equal(copy.added, true);
  await copy.run(); assert.equal(copy.failed, false);
  assert.deepEqual([reads, copies, saves], [1, 1, 2]);
});

test('a library row redrawn while pending still shares one copy operation', async () => {
  let release, copies = 0;
  const copy = createCopyWorkflow({read: async () => {await new Promise(resolve => {release = resolve;}); return {id: 'source'};},
    append: async () => {copies++;}, flush: async () => {}});
  const first = copy.run(); assert.equal(copy.pending, true); assert.equal(copy.run(), first);
  release(); await first; assert.equal(copy.pending, false); assert.equal(copies, 1);
});

test('revoking the copy context during a read prevents a late append', async () => {
  let release, copies = 0, saves = 0; const controller = new AbortController();
  const copy = createCopyWorkflow({signal: controller.signal,
    read: async () => {await new Promise(resolve => {release = resolve;}); return {id: 'source'};},
    append: () => {copies++;}, flush: async () => {saves++;}});
  const reading = copy.run(); controller.abort(); release();
  await assert.rejects(reading, error => error.code === 'cancelled');
  assert.deepEqual([copies, saves], [0, 0]);
});
