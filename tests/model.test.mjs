import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTES, ITEM_TYPES, COLLECTIONS, RESOURCE_LIMITS, createSheet, normalizeSheet,
  createItemSheet, normalizeItemSheet, canonicalItemType, collectionForType, itemToRow, insertItem, cloneData,
} from '../model.js';

test('fresh sheets have independent blank collections and editable structural defaults', () => {
  const first = createSheet(), second = createSheet();
  assert.equal(ATTRIBUTES.length, 5);
  for (const { id } of ATTRIBUTES) assert.deepEqual(first.attributes[id], { die: 4, modifier: 0 });
  for (const collection of COLLECTIONS) assert.deepEqual(first[collection], []);
  assert.equal(first.stats.pace, '');
  assert.equal(first.stats.basePace, 6);
  assert.equal(first.stats.size, 0);
  assert.equal(first.stats.runningDie, 6);
  assert.equal(first.resources.wounds, 0);
  assert.deepEqual(RESOURCE_LIMITS, { wounds: 3, fatigue: 2 });
  first.attributes.agility.die = 8;
  first.inventory.push({ name: 'User-entered item' });
  assert.equal(second.attributes.agility.die, 4);
  assert.deepEqual(second.inventory, []);
});

test('every supported item type maps to its own editable actor collection', () => {
  let sheet = createSheet();
  for (const type of ITEM_TYPES) {
    const item = { id: `library-${type.id}`, type: type.id, name: `Custom ${type.id}`, data: createItemSheet(type.id) };
    sheet = insertItem(sheet, item);
    assert.equal(sheet[type.collection].at(-1).type, type.id);
    assert.equal(sheet[type.collection].at(-1).sourceId, item.id);
  }
  assert.equal(sheet.inventory.length, 6);
  assert.equal(sheet.skills.length, 1);
  assert.equal(sheet.racialFeatures.length, 1);
  assert.equal(Object.values(sheet).filter(Array.isArray).flat().length, ITEM_TYPES.length);
  assert.equal(collectionForType('unknown'), null);
  assert.throws(() => createItemSheet('unknown'), /Unsupported item type/);
});

test('owned copies do not mutate source documents, existing rows or actor drafts', () => {
  const original = createSheet();
  const item = { id: 47, type: 'weapon', name: 'User weapon', data: { damage: 'user value', custom: { labels: ['one'] } } };
  const next = insertItem(original, item);
  const another = insertItem(next, item);
  assert.equal(original.inventory.length, 0);
  assert.notEqual(another.inventory[0].id, another.inventory[1].id);
  another.inventory[1].data.custom.labels.push('two');
  assert.deepEqual(item.data.custom.labels, ['one']);
  assert.deepEqual(next.inventory[0].data.custom.labels, ['one']);
  assert.deepEqual(another.inventory[0].data.custom.labels, ['one']);
  assert.equal(next.inventory[0].sourceId, '47');
});

test('normalization repairs malformed structures and preserves JSON extension fields', () => {
  const input = {
    attributes: { agility: { die: '8', modifier: '2' }, vigor: null },
    resources: { bennies: '3', wounds: -1, fatigue: 'bad', powerPoints: 7 },
    stats: { pace: 'manual value' }, status: { shaken: 'false', vulnerable: true },
    inventory: [null, { type: 'weapon', id: 'existing', name: 'Custom', data: { damage: 'anything' } }],
    skills: null, custom: { future: [1, true, null] },
  };
  const result = normalizeSheet(input);
  assert.deepEqual(result.attributes.agility, { die: 8, modifier: 2 });
  assert.equal(result.attributes.vigor.die, 4);
  assert.equal(result.resources.wounds, 0);
  assert.equal(result.resources.fatigue, 0);
  assert.equal(result.stats.pace, 'manual value');
  assert.equal(result.status.shaken, false);
  assert.equal(result.status.vulnerable, true);
  assert.equal(result.inventory[0].id, 'existing');
  assert.deepEqual(result.skills, []);
  result.custom.future.push(2);
  assert.deepEqual(input.custom.future, [1, true, null]);
  assert.deepEqual(normalizeSheet(result), result);
});

test('version 0.1 actor envelopes migrate values and owned items without game calculations', () => {
  const old = { other: { retained: true }, fields: { savageWorlds: {
    schema: 1, concept: 'Custom concept', advances: 5, bennies: 2, wounds: 1,
    fatigue: 2, powerPoints: 9, powerMax: 12, pace: 7, parryBonus: 17,
    conditions: ['shaken', 'prone'], attributes: { strength: { die: 10, modifier: 1 } },
    items: [
      { id: 'gear-1', sourceId: 10, type: 'gear', name: 'Custom gear', data: { quantity: 2, equipped: true } },
      { id: 'shield-1', type: 'shield', name: 'Custom shield', data: { armor: 3, location: 'arm' } },
      { id: 'ability-1', type: 'ability', name: 'Custom feature', data: { description: 'User text' } },
    ],
  } } };
  const result = normalizeSheet(old);
  assert.equal(result.identity.concept, 'Custom concept');
  assert.equal(result.identity.advances, 5);
  assert.deepEqual(result.resources, { bennies: 2, wounds: 1, fatigue: 2, powerPoints: 9, powerPointsMax: 12, currency: '' });
  assert.equal(result.stats.pace, 7);
  assert.equal(result.stats.parry, '');
  assert.equal(result.parryBonus, 17);
  assert.equal(result.status.shaken, true);
  assert.deepEqual(result.conditions, ['shaken', 'prone']);
  assert.equal(result.inventory[0].id, 'gear-1');
  assert.equal(result.inventory[0].type, 'equipment');
  assert.equal(result.inventory[0].quantity, 2);
  assert.equal(result.inventory[0].equipped, true);
  assert.equal(result.inventory[1].data.protection, 3);
  assert.equal(result.inventory[1].data.coverage, 'arm');
  assert.equal(result.racialFeatures[0].type, 'racial-feature');
  assert.deepEqual(normalizeSheet(result), result);
  assert.equal(old.fields.savageWorlds.items[0].type, 'gear');
});

test('legacy item envelopes and aliases remain readable with no inferred content', () => {
  const value = { extra: true, savageWorlds: { ap: 2, rof: 3, damage: 'User damage', equipped: true } };
  const result = normalizeItemSheet('weapon', value);
  assert.equal(result.armorPiercing, 2);
  assert.equal(result.rateOfFire, 3);
  assert.equal(result.damage, 'User damage');
  assert.equal(result.extra, true);
  assert.equal(itemToRow({ type: 'gear', name: 'Custom', data: {} }).type, 'equipment');
  assert.equal(canonicalItemType('ability'), 'racial-feature');
  assert.equal(canonicalItemType('racialFeature'), 'racial-feature');
  assert.equal(createItemSheet('power').description, '');
  assert.equal(createItemSheet('power').rank, '');
});

test('JSON copies omit dangerous prototype keys and nonfinite values', () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"bad":true},"custom":{"ok":1}}');
  const result = cloneData(value);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
  assert.equal(Object.hasOwn(result, 'constructor'), false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(cloneData({ invalid: Infinity, list: [NaN] }), { invalid: null, list: [null] });
});

test('schema 1 manual values and bonuses migrate without enabling automatic replacement', () => {
  const original = {schemaVersion: 1, identity: {rank: 'User stage', advances: 7},
    stats: {pace: 9, parry: 11, toughness: 13, armor: 5}, parryBonus: 2,
    status: {customStatus: true}, resources: {bennies: 1}};
  const state = normalizeSheet(original);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.calculation.automatic, false);
  assert.deepEqual(state.overrides, {pace: 9, parry: 11, toughness: 13, armor: 5, rank: 'User stage', runningDie: null, loadLimit: null});
  assert.equal(state.bonuses.parry, 2);
  assert.equal(state.status.customStatus, true);
  assert.equal(state.resources.bennies, 1);
  assert.deepEqual(normalizeSheet(state), state);
  assert.equal(original.schemaVersion, 1);
});

test('new NPC defaults are Extras while stored profiles and creature sizes are preserved', () => {
  assert.equal(createSheet({actorType: 'npc'}).profile.kind, 'extra');
  const state = normalizeSheet({schemaVersion: 2, profile: {kind: 'wild-card', animalSmarts: true}, stats: {size: 20},
    movements: {fly: 24}, allies: {group: 'User group', count: 4}, arcanePools: [{id: 'pool', current: 7}], activePowers: [{id: 'cast', targetIds: ['actor']}]});
  assert.equal(state.profile.kind, 'wild-card');
  assert.equal(state.profile.animalSmarts, true);
  assert.equal(state.stats.size, 20);
  assert.equal(state.movements.fly, 24);
  assert.equal(state.allies.count, 4);
  assert.equal(state.arcanePools[0].current, 7);
  assert.deepEqual(state.activePowers[0].targetIds, ['actor']);
});

test('legacy shields retain their own role and do not become body armor', () => {
  const state = normalizeSheet({fields: {savageWorlds: {schema: 1, items: [
    {id: 'shield', type: 'shield', name: 'User shield', data: {armor: 2, parry: 3, equipped: true}},
  ]}}});
  assert.equal(state.inventory[0].type, 'armor');
  assert.equal(state.inventory[0].data.kind, 'shield');
  assert.deepEqual(state.inventory[0].data.locations, []);
  assert.equal(state.inventory[0].data.parryBonus, 3);
  assert.equal(state.inventory[0].data.protection, 2);
  assert.deepEqual(normalizeSheet(state), state);
});

test('new templates retain structured mechanics without inserting named game content', () => {
  const armor = normalizeItemSheet('armor', {coverage: 'cabeça, braços', modifiers: [{target: 'armor', value: '2', enabled: true}]});
  assert.deepEqual(armor.locations, ['head', 'arms']);
  assert.equal(armor.modifiers[0].value, 2);
  assert.equal(createItemSheet('vehicle').carried, false);
  assert.equal(createItemSheet('vehicle').woundsMax, 3);
  assert.deepEqual(createItemSheet('arcane-device').powerIds, []);
  assert.deepEqual(createItemSheet('power').modifiers, []);
  assert.equal(createItemSheet('skill').role, '');
  assert.equal(createItemSheet('skill').untrained, false);
});
