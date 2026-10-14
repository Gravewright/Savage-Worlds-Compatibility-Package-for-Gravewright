import test from 'node:test';
import assert from 'node:assert/strict';
import {createSheet, createItemSheet, normalizeSheet, normalizeTrait} from '../model.js';
import {derive, rankForAdvances, stepTrait, traitValue, traitPenalty, penaltyBreakdown,
  modifiersForSheet, applyModifiers, armorAt, equipmentPenalty, carriedWeight, loadForStrength,
  validateProgressLedger, actionRestrictions, weaponAttackPenalty} from '../mechanics.js';
import {effectiveRules} from '../settings.js';

const item = (id, type, data = {}, equipped = false) => ({id, sourceId: '', name: 'User value', type, equipped, quantity: 1, data: {...createItemSheet(type), ...data}});

test('table Pace and load options preserve trait wounds, carried weight and minimum Strength', () => {
  const sheet=createSheet();sheet.resources.wounds=2;sheet.load.carried=15;
  assert.equal(derive(sheet).pace,2);
  const rules=effectiveRules(sheet,{rules:{enableWoundPace:false,applyEncumbrance:false}});
  const stats=derive(sheet,{rules});
  assert.equal(stats.pace,6);assert.equal(stats.runningModifier,0);assert.equal(stats.encumbered,true);
  assert.equal(stats.carried,15);assert.equal(stats.loadLimit,10);
  assert.equal(traitPenalty(sheet,{rules,attribute:'agility'}),-2);
  assert.equal(penaltyBreakdown(sheet,{rules,attribute:'agility'}).encumbrance,0);
  assert.equal(penaltyBreakdown(sheet,{rules,attribute:'vigor',context:'fatigue'}).encumbrance,0);
  sheet.inventory.push(item('heavy-user-equipment','equipment',{minStrength:8},true));
  assert.equal(derive(sheet,{rules}).pace,4);
  assert.equal(penaltyBreakdown(sheet,{rules,attribute:'agility'}).equipment,-2);
  sheet.rules={enableWoundPace:true,applyEncumbrance:true};
  const overrides=effectiveRules(sheet,{rules:{enableWoundPace:false,applyEncumbrance:false}});
  assert.equal(derive(sheet,{rules:overrides}).pace,1);
  assert.equal(derive(sheet,{rules:overrides}).runningModifier,-2);
  assert.equal(penaltyBreakdown(sheet,{rules:overrides,attribute:'agility'}).encumbrance,-2);
  assert.deepEqual(sheet.rules,{enableWoundPace:true,applyEncumbrance:true});
});

test('PDF 78: ranged minimum Strength penalties accept item rows and flat fields', () => {
  const sheet = createSheet();
  const weapon = item('ranged', 'weapon', {attackType: 'ranged', minStrength: 8});
  assert.equal(weaponAttackPenalty(sheet, weapon), -2);
  assert.equal(weaponAttackPenalty(sheet, weapon.data), -2);
  sheet.attributes.strength = {die: 8, modifier: 0};
  assert.equal(weaponAttackPenalty(sheet, weapon), 0);
  weapon.data.minStrength = 12; weapon.data.minStrengthModifier = 2;
  sheet.attributes.strength = {die: 12, modifier: 0};
  assert.equal(weaponAttackPenalty(sheet, weapon), -2);
  sheet.bonuses.minStrengthSteps = 1;
  assert.equal(weaponAttackPenalty(sheet, weapon), -1);
  sheet.edges.push(item('user-strength', 'edge', {modifiers: [{target: 'attribute.strength.steps', value: 1}]}));
  assert.equal(weaponAttackPenalty(sheet, weapon), 0);
  sheet.bonuses.minStrengthSteps = 0; sheet.edges = [];
  for (const attackType of ['melee', 'thrown', '']) {
    assert.equal(weaponAttackPenalty(sheet, {...weapon.data, attackType}), 0);
  }
  assert.equal(weaponAttackPenalty(sheet, {attackType: 'ranged', minStrength: ''}), 0);
});

test('user running modifiers apply enabled add and override effects to the final modifier', () => {
  const sheet = createSheet(); sheet.stats.runningModifier = 1; sheet.bonuses.running = 2;
  sheet.effects.push(item('running-effect', 'effect', {active: true, modifiers: [
    {target: 'running', value: 3}, {target: 'running', value: 99, enabled: false},
  ]}));
  assert.equal(derive(sheet).runningModifier, 6);
  sheet.load.encumbered = true;
  assert.equal(derive(sheet).runningModifier, 4);
  sheet.effects[0].data.modifiers.push({target: 'running', mode: 'override', value: 5});
  assert.equal(derive(sheet).runningModifier, 5);
  sheet.effects[0].data.active = false;
  assert.equal(derive(sheet).runningModifier, 1);
});

test('user load modifiers affect both derived encumbrance and contextual penalties before overrides', () => {
  const sheet = createSheet(); sheet.load.carried = 15;
  assert.equal(derive(sheet).loadLimit, 10);
  assert.equal(traitPenalty(sheet, {attribute: 'agility'}), -2);
  sheet.edges.push(item('load-effect', 'edge', {modifiers: [{target: 'load', value: 10}]}));
  assert.equal(derive(sheet).loadLimit, 20);
  assert.equal(derive(sheet).encumbered, false);
  assert.equal(derive(sheet).pace, 6);
  assert.equal(traitPenalty(sheet, {attribute: 'agility'}), 0);
  sheet.edges[0].data.modifiers.push({target: 'load', mode: 'override', value: 5});
  assert.equal(derive(sheet).loadLimit, 5);
  assert.equal(traitPenalty(sheet, {attribute: 'agility'}), -2);
  sheet.overrides.loadLimit = 30;
  assert.equal(derive(sheet).loadLimit, 30);
  assert.equal(traitPenalty(sheet, {attribute: 'agility'}), 0);
  assert.equal(sheet.edges[0].data.modifiers.length, 2);
});

test('PDF 63: stage boundaries are based on progress count', () => {
  for (const [value, expected] of [[0,'novice'],[3,'novice'],[4,'seasoned'],[7,'seasoned'],[8,'veteran'],[11,'veteran'],[12,'heroic'],[15,'heroic'],[16,'legendary'],[80,'legendary']]) {
    assert.equal(rankForAdvances(value), expected);
  }
});

test('PDF 12, 24, 105 and 218: trait steps, untrained tests and fixed strength remain distinct', () => {
  assert.deepEqual(stepTrait({die: 4, modifier: -1}, 1), {die: 4, modifier: 0});
  assert.deepEqual(stepTrait({die: 12, modifier: 2}, -3), {die: 10, modifier: 0});
  assert.deepEqual(stepTrait({die: 12, modifier: 0}, 2), {die: 12, modifier: 2});
  assert.deepEqual(traitValue({die: 8, modifier: 1}, {untrained: true}), {die: 4, modifier: -1});
  assert.deepEqual(traitValue({die: 'd12+2'}), {die: 12, modifier: 2});
  assert.equal(traitValue({fixedValue: 1}).fixedValue, 1);
  assert.equal(normalizeTrait({die: 1}).fixedValue, 1);
  assert.equal(normalizeTrait({die: 13}).originalDie, 13);
});

test('PDF 13 and 110: fresh derived statistics and lack of a trained fighting skill', () => {
  const sheet = createSheet();
  const base = derive(sheet);
  assert.equal(base.parry, 2); assert.equal(base.toughness, 4); assert.equal(base.pace, 6);
  assert.equal(base.armor, 0); assert.equal(base.runningDie, 6); assert.equal(base.loadLimit, 10);
  sheet.skills.push(item('named-only', 'skill', {die: 12}));
  assert.equal(derive(sheet).parry, 2);
  sheet.skills.push(item('empty-role', 'skill', {role: 'fighting', die: ''}));
  assert.equal(derive(sheet).parry, 2);
  sheet.skills[1].data.die = 4;
  assert.equal(derive(sheet).parry, 4);
  sheet.skills[1].data.untrained = true;
  assert.equal(derive(sheet).parry, 2);
  sheet.links.combatSkillId = 'named-only';
  assert.equal(derive(sheet).parry, 8);
});

test('PDF 13: only post-d12 fixed trait values contribute half their modifier to derived stats', () => {
  const sheet = createSheet();
  sheet.skills.push(item('fight', 'skill', {role: 'fighting', die: 12, modifier: 1}));
  assert.equal(derive(sheet).parry, 8);
  sheet.skills[0].data.modifier = 2;
  assert.equal(derive(sheet).parry, 9);
  sheet.attributes.vigor = {die: 6, modifier: 2};
  assert.equal(derive(sheet).toughness, 5);
  sheet.attributes.vigor = {die: 12, modifier: 2}; sheet.stats.size = 1;
  assert.equal(derive(sheet).toughness, 10);
});

test('PDF 77, 82 and 13: torso layers, natural armor and shields have separate effects', () => {
  const sheet = createSheet(); sheet.attributes.strength.die = 12;
  sheet.bonuses.armor = 2;
  sheet.inventory.push(item('outer', 'armor', {protection: 4, minStrength: 10}, true));
  sheet.inventory.push(item('inner', 'armor', {protection: 3, minStrength: 8}, true));
  sheet.inventory.push(item('head', 'armor', {protection: 8, locations: ['head']}, true));
  sheet.inventory.push(item('shield', 'armor', {kind: 'shield', protection: 10, parryBonus: 2, locations: []}, true));
  assert.equal(armorAt(sheet), 7);
  assert.equal(armorAt(sheet, 'head'), 10);
  assert.equal(derive(sheet).toughness, 11);
  assert.equal(derive(sheet).parry, 4);
  sheet.inventory[0].equipped = false;
  assert.equal(armorAt(sheet), 5);
});

test('PDF 78: insufficient strength for worn equipment affects agility and movement', () => {
  const sheet = createSheet();
  sheet.inventory.push(item('armor', 'armor', {protection: 3, minStrength: 8}, true));
  assert.equal(equipmentPenalty(sheet), 2);
  assert.equal(derive(sheet).pace, 4);
  assert.equal(traitPenalty(sheet, {attribute: 'agility'}), -2);
  assert.equal(traitPenalty(sheet, {attribute: 'strength'}), 0);
  sheet.attributes.strength.die = 8;
  assert.equal(equipmentPenalty(sheet), 0);
});

test('PDF 79: carrying limits use this edition kg/lb convention and explicit carried quantities', () => {
  for (const [die, kg] of [[4,10],[6,20],[8,30],[10,40],[12,50]]) {
    assert.equal(loadForStrength(die), kg); assert.equal(loadForStrength(die, 0, 'lb'), kg * 2);
  }
  assert.equal(loadForStrength(12, 2), 70);
  const sheet = createSheet();
  const first = item('first', 'equipment', {weight: 5, weightUnit: 'kg'}); first.quantity = 2;
  sheet.inventory.push(first, item('second', 'equipment', {weight: 4, weightUnit: 'lb'}), item('stored', 'equipment', {weight: 100, carried: false}), item('vehicle', 'vehicle', {weight: 1000}));
  assert.equal(carriedWeight(sheet), 12); assert.equal(derive(sheet).encumbered, true);
  assert.equal(derive(sheet).pace, 4); assert.equal(derive(sheet).runningModifier, -2);
  assert.equal(traitPenalty(sheet, {attribute: 'agility'}), -2);
  assert.equal(traitPenalty(sheet, {attribute: 'strength'}), 0);
  assert.equal(traitPenalty(sheet, {attribute: 'vigor'}), 0);
  assert.equal(traitPenalty(sheet, {attribute: 'vigor', context: 'fatigue'}), -2);
  sheet.load.unit = 'lb'; assert.equal(carriedWeight(sheet), 24); assert.equal(derive(sheet).loadLimit, 20);
});

test('PDF 112, 115, 122 and 124: penalties respect context and never penalize a vulnerable target', () => {
  const sheet = createSheet(); sheet.resources.wounds = 5; sheet.resources.fatigue = 2; sheet.status.distracted = true; sheet.status.vulnerable = true;
  assert.equal(traitPenalty(sheet), -7);
  assert.equal(traitPenalty(sheet, {ignoreWounds: true}), -4);
  assert.equal(traitPenalty(sheet, {actions: 3, running: true}), -13);
  assert.equal(traitPenalty(sheet, {actions: 3, running: true, freeAction: true}), -7);
  assert.equal(traitPenalty(sheet, {context: 'damage'}), 0);
  assert.equal(traitPenalty(sheet, {context: 'running'}), 0);
  sheet.status.distracted = false; sheet.status.bound = true;
  assert.equal(penaltyBreakdown(sheet).conditions, -2);
  assert.equal(actionRestrictions(sheet).canPhysicalAct, false);
  assert.equal(actionRestrictions(sheet).canEscape, true);
  sheet.status.bound = false; sheet.status.entangled = true;
  assert.equal(penaltyBreakdown(sheet).conditions, 0);
  assert.equal(actionRestrictions(sheet).canMove, false);
  assert.equal(actionRestrictions(sheet).vulnerable, true);
});

test('stored numeric modifiers select active and equipped sources without recognizing content names', () => {
  const sheet = createSheet(); sheet.attributes.vigor.die = 6;
  sheet.effects.push(item('active', 'effect', {active: true, modifiers: [{target: 'attribute.vigor', value: 2}]}));
  sheet.effects.push(item('inactive', 'effect', {active: false, modifiers: [{target: 'toughness', value: 99}]}));
  assert.equal(traitValue(sheet.attributes.vigor, {sheet, attribute: 'vigor'}).modifier, 2);
  assert.equal(derive(sheet).toughness, 5);
  sheet.effects[0].data.modifiers.push({target: 'attribute.vigor.steps', value: 1});
  assert.equal(derive(sheet).toughness, 6);
  sheet.inventory.push(item('unequipped', 'equipment', {modifiers: [{target: 'toughness', value: 99}]}));
  assert.equal(derive(sheet).toughness, 6);
  assert.equal(modifiersForSheet(sheet).length, 2);
  assert.equal(applyModifiers(3, 'parry', [{target:'parry',value:2},{target:'parry',value:9,mode:'override'}]), 9);
  sheet.overrides.toughness = 17; assert.equal(derive(sheet).toughness, 17);
});

test('manual migrations preserve entered totals and automatic snapshots do not accumulate movement penalties', () => {
  const old = normalizeSheet({schemaVersion: 1, stats: {pace: 8, parry: 12, toughness: 16, armor: 4}, resources: {wounds: 2}});
  assert.equal(derive(old).pace, 8); assert.equal(derive(old).parry, 12); assert.equal(derive(old).toughness, 16);
  const sheet = createSheet(); sheet.resources.wounds = 2;
  sheet.stats.pace = derive(sheet).pace;
  assert.equal(derive(sheet).pace, 4);
});

test('PDF 217–219: wound capacity depends on profile and scale without clamping creature size', () => {
  const sheet = createSheet(); assert.equal(derive(sheet).woundsMax, 3);
  sheet.profile.kind = 'extra'; assert.equal(derive(sheet).woundsMax, 0);
  for (const [size, capacity] of [[4,1],[8,2],[12,3],[20,3]]) { sheet.stats.size = size; assert.equal(derive(sheet).woundsMax, capacity); }
  sheet.profile.woundCapacity = 2; assert.equal(derive(sheet).woundsMax, 2);
});

test('PDF 63: progress ledger detects overspending and attribute frequency including unsorted legendary entries', () => {
  const sheet = createSheet(); sheet.identity.advances = 20;
  sheet.advancement.ledger = [{advance: 15,kind:'attribute'}, {advance: 16,kind:'attribute'}, {advance: 18,kind:'attribute'}];
  assert.equal(validateProgressLedger(sheet).valid, true);
  sheet.advancement.ledger.push({advance: 17,kind:'attribute'});
  assert.ok(validateProgressLedger(sheet).errors.some(error => error.code === 'attribute-frequency'));
  sheet.advancement.ledger = [{advance: 6,kind:'hindrance',cost:2}, {advance:5,kind:'edge'}, {advance:21,kind:'edge'}];
  const result = validateProgressLedger(sheet);
  assert.ok(result.errors.some(error => error.code === 'duplicate'));
  assert.ok(result.errors.some(error => error.code === 'advance'));
  sheet.advancement.ledger = [{advance: 1,kind:'edge',cost:1e9}];
  assert.ok(validateProgressLedger(sheet).errors.some(error => error.code === 'cost'));
});
