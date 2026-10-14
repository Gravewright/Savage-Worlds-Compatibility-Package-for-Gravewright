/** Pure numerical mechanics; no names, catalogs, host APIs or supplied descriptions. */
import {DICE, STAGES, normalizeSheet, normalizeTrait, normalizeModifiers} from './model.js';

const finite = (value, fallback = 0) => {
  if (value === '' || value == null || typeof value === 'boolean') return fallback;
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback;
};
const count = (value, fallback = 0) => Math.max(0, Math.trunc(finite(value, fallback)));
const rows = value => Array.isArray(value) ? value : [];
const override = (sheet, key, fallback) => finite(sheet.overrides?.[key], fallback);
const enabled = row => row?.active !== false && row?.data?.active !== false;
const equipped = row => Boolean(row?.equipped ?? row?.data?.equipped);

export function rankForAdvances(value) {
  const advances = count(value);
  return STAGES.find(stage => advances >= stage.min && (stage.max == null || advances <= stage.max)).id;
}

export function modifiersForSheet(sheet) {
  const result = [];
  for (const row of rows(sheet.inventory)) if (enabled(row) && equipped(row)) result.push(...normalizeModifiers(row.data?.modifiers));
  for (const collection of ['ancestries', 'edges', 'hindrances', 'racialFeatures']) {
    for (const row of rows(sheet[collection])) if (enabled(row)) result.push(...normalizeModifiers(row.data?.modifiers));
  }
  for (const row of rows(sheet.effects)) if (enabled(row) && row.data?.active === true) result.push(...normalizeModifiers(row.data?.modifiers));
  for (const power of rows(sheet.activePowers)) if (power.active !== false) {
    for (const effect of rows(power.effects)) result.push(...normalizeModifiers(effect.modifiers ?? effect.data?.modifiers));
  }
  return result.filter(modifier => modifier.enabled);
}

/** Modifiers execute in stored order. Manual sheet overrides take precedence afterwards. */
export function applyModifiers(value, target, modifiers = []) {
  return normalizeModifiers(modifiers).filter(modifier => modifier.enabled && modifier.target === target)
    .reduce((current, modifier) => modifier.mode === 'override' ? modifier.value : current + modifier.value, finite(value));
}

/** Die steps below d4 and above d12 become fixed modifiers; other bonuses remain. */
export function stepTrait(trait, value = 0) {
  const result = normalizeTrait(trait), steps = Math.trunc(finite(value));
  const prior = finite(result.modifier), boundary = result.die === 12 && prior > 0 || result.die === 4 && prior < 0;
  const level = DICE.indexOf(result.die) + (boundary ? prior : 0) + steps;
  const die = level < 0 ? 4 : level > 4 ? 12 : DICE[level];
  const modifier = (level < 0 ? level : level > 4 ? level - 4 : 0) + (boundary ? 0 : prior);
  return {die, modifier, ...(result.fixedValue != null ? {fixedValue: result.fixedValue} : {})};
}

export function traitValue(trait, {sheet, attribute = '', skillId = '', untrained = false, modifiers} = {}) {
  const normalized = normalizeTrait(trait);
  const base = untrained || trait?.untrained === true || trait?.die === ''
    ? {die: 4, modifier: finite(trait?.modifier) - 2} : {die: normalized.die, modifier: finite(normalized.modifier)};
  if (normalized.fixedValue != null) base.fixedValue = normalized.fixedValue;
  const target = skillId ? `skill.${skillId}` : attribute ? `attribute.${attribute}` : '';
  const active = modifiers ?? (sheet ? modifiersForSheet(sheet) : []);
  const adjusted = target ? stepTrait(base, applyModifiers(0, `${target}.steps`, active)) : base;
  if (target) adjusted.modifier = applyModifiers(adjusted.modifier, target, active);
  return adjusted;
}

/** PDF p.77 uses the edition's approximate conversion: 2 lb = 1 kg. */
export function loadForStrength(die, modifier = 0, unit = 'kg') {
  const trait = normalizeTrait(typeof die === 'object' ? die : {die, modifier});
  if (trait.fixedValue != null) return 0;
  const base = (DICE.indexOf(trait.die) + 1) * 10;
  const limit = base + (trait.die === 12 ? Math.max(0, trait.modifier) * 10 : 0);
  return limit * (unit === 'lb' || unit === 'lbs' ? 2 : 1);
}

function weightIn(value, from, to) {
  const weight = Math.max(0, finite(value));
  return from === to ? weight : from === 'lb' ? weight / 2 : weight * 2;
}

export function carriedWeight(sheet, unit = sheet.load?.unit ?? 'kg') {
  return rows(sheet.inventory).reduce((total, row) => {
    const data = row?.data ?? {}, from = data.weightUnit === 'lb' || data.weightUnit === 'lbs' ? 'lb' : data.weightUnit === 'kg' ? 'kg' : unit;
    if (data.carried === false || row.carried === false) return total;
    return total + weightIn(data.weight, from, unit) * Math.max(0, finite(row.quantity ?? data.quantity, 1));
  }, 0);
}

function strengthSteps(value) {
  const trait = normalizeTrait(value);
  return DICE.indexOf(trait.die) + (trait.die === 12 ? Math.max(0, trait.modifier) : 0);
}

function strengthGap(sheet, data, extraSteps = 0) {
  if (data.minStrength === '' || data.minStrength == null) return 0;
  const strength = traitValue(sheet.attributes.strength, {sheet, attribute: 'strength'});
  const adjusted = stepTrait(strength, Math.trunc(finite(sheet.bonuses.minStrengthSteps)));
  const required = normalizeTrait({die: data.minStrength, modifier: data.minStrengthModifier});
  return Math.max(0, strengthSteps(required) + extraSteps - strengthSteps(adjusted));
}

/** PDF p.78: only ranged attacks lose one point per missing Strength step. */
export function weaponAttackPenalty(sheet, weaponOrData) {
  const data = weaponOrData?.data ?? weaponOrData ?? {};
  if (data.attackType !== 'ranged') return 0;
  const gap = strengthGap(normalizeSheet(sheet), data);
  return gap ? -gap : 0;
}

function loadLimitFor(sheet, modifiers) {
  const strength = traitValue(sheet.attributes.strength, {sheet, attribute: 'strength', modifiers});
  const adjusted = stepTrait(strength, finite(sheet.bonuses.loadSteps));
  const base = finite(sheet.load.limit, loadForStrength(adjusted, 0, sheet.load.unit) + finite(sheet.bonuses.load));
  return Math.max(0, override(sheet, 'loadLimit', applyModifiers(base, 'load', modifiers)));
}

function locationOf(data) {
  if (Array.isArray(data.locations)) return data.locations;
  const coverage = String(data.coverage ?? '').toLowerCase();
  if (/head|cabeça|cabeza/.test(coverage) && !/torso|tronco|body|corpo|cuerpo/.test(coverage)) return ['head'];
  return ['torso'];
}

export function armorAt(sheet, location = 'torso') {
  const layers = rows(sheet.inventory).filter(row => row.type === 'armor' && row.data?.kind !== 'shield' && enabled(row) && equipped(row)
    && (locationOf(row.data).includes(location) || locationOf(row.data).includes('all')))
    .map(row => Math.max(0, finite(row.data.protection))).sort((a, b) => b - a);
  const worn = (layers[0] ?? 0) + Math.floor((layers[1] ?? 0) / 2);
  return Math.max(0, applyModifiers(worn + finite(sheet.bonuses?.armor), 'armor', modifiersForSheet(sheet)));
}

export function equipmentPenalty(sheet) {
  const worn = rows(sheet.inventory).filter(row => ['armor', 'equipment'].includes(row.type) && equipped(row) && enabled(row));
  const layers = worn.filter(row => row.type === 'armor' && row.data?.kind !== 'shield'
    && locationOf(row.data).includes('torso')).sort((a, b) => finite(b.data.protection) - finite(a.data.protection));
  return worn.reduce((total, row) => total + strengthGap(sheet, row.data,
    layers.length > 1 && row.id === layers[0].id ? 1 : 0), 0);
}

function effectiveResources(sheet, modifiers) {
  return {wounds: Math.max(0, applyModifiers(sheet.resources.wounds, 'wounds', modifiers)),
    fatigue: Math.max(0, applyModifiers(sheet.resources.fatigue, 'fatigue', modifiers))};
}

export function penaltyBreakdown(sheet, options = {}) {
  const state = normalizeSheet(sheet), modifiers = modifiersForSheet(state), resources = effectiveResources(state, modifiers);
  const rules = options.rules ?? state.rules ?? {};
  const attribute = options.attribute ?? '', role = options.role ?? '';
  const isTrait = !['running', 'damage'].includes(options.context);
  const wounds = !isTrait || options.ignoreWounds ? 0 : -Math.min(3, Math.max(0, resources.wounds - count(options.woundReduction)));
  const fatigue = !isTrait || options.ignoreFatigue ? 0 : -Math.min(2, Math.max(0, resources.fatigue - count(options.fatigueReduction)));
  const conditions = !isTrait || options.ignoreConditions ? 0 : state.status.distracted || state.status.bound ? -2 : 0;
  const automatic = state.calculation.automatic;
  const unit = state.load.unit, limit = loadLimitFor(state, modifiers);
  const carried = finite(state.load.carried, carriedWeight(state, unit));
  const encumbered = automatic ? state.load.encumbered || carried > limit : state.load.encumbered;
  const affected = attribute === 'agility' || options.context === 'running' || (attribute === 'vigor' && options.context === 'fatigue');
  const encumbrance = rules.applyEncumbrance !== false && options.context !== 'damage' && !options.ignoreEncumbrance && encumbered && affected ? -2 : 0;
  const equipment = isTrait && !options.ignoreEquipment && attribute === 'agility' ? -equipmentPenalty(state) : 0;
  const actions = !isTrait || options.freeAction || options.ignoreActions ? 0 : -2 * Math.min(2, Math.max(0, count(options.actions, 1) - 1 - count(options.actionReduction)));
  const running = isTrait && options.running && !options.freeAction ? -2 : 0;
  const prone = isTrait && !options.ignoreConditions && state.status.prone && role === 'fighting' ? -2 : 0;
  const total = wounds + fatigue + conditions + encumbrance + equipment + actions + running + prone;
  return {wounds, fatigue, conditions, encumbrance, equipment, actions, running, prone, total};
}

export function traitPenalty(sheet, options = {}) { return penaltyBreakdown(sheet, options).total; }

export function actionRestrictions(sheet) {
  const status = sheet.status ?? {}, incapacitated = status.dead || status.incapacitated;
  return {canAct: !(incapacitated || status.stunned), canMove: !(incapacitated || status.stunned || status.bound || status.entangled),
    canPhysicalAct: !(incapacitated || status.stunned || status.bound), canEscape: !(incapacitated || status.stunned),
    freeOnly: Boolean(status.shaken), vulnerable: Boolean(status.vulnerable || status.bound || status.entangled || status.stunned),
    distracted: Boolean(status.distracted || status.bound)};
}

/** No mutation: callers render these values or explicitly persist a prepared snapshot. */
export function derive(sheet, options = {}) {
  const state = normalizeSheet(sheet), modifiers = modifiersForSheet(state), auto = state.calculation.automatic;
  const rules = options.rules ?? state.rules ?? {}, penalizedLoad = rules.applyEncumbrance !== false;
  const fighting = rows(state.skills).find(row => row.id === state.links.combatSkillId && enabled(row))
    ?? rows(state.skills).find(row => row.data?.role === 'fighting' && enabled(row));
  const rating = (trait, target) => stepTrait(trait, applyModifiers(0, `${target}.steps`, modifiers));
  const fight = fighting && !fighting.data.untrained && fighting.data.die !== '' ? rating(fighting.data, `skill.${fighting.id}`) : null;
  const vigor = rating(state.attributes.vigor, 'attribute.vigor');
  const half = trait => trait.die / 2 + (trait.die === 12 ? Math.floor(finite(trait.modifier) / 2) : 0);
  const size = Math.trunc(finite(state.stats.size));
  const armorComputed = armorAt(state);
  const armor = override(state, 'armor', !auto ? finite(state.stats.armor, armorComputed) : armorComputed);
  const weapons = rows(state.inventory).filter(row => ['weapon', 'armor'].includes(row.type) && equipped(row) && enabled(row));
  const parryValues = weapons.map(row => ({kind: row.type === 'armor' && row.data.kind === 'shield' ? 'shield' : 'weapon',
    bonus: finite(row.data.parryBonus) > 0 && strengthGap(state, row.data) > 0 ? 0 : finite(row.data.parryBonus)}));
  const weaponParry = Math.max(0, ...parryValues.filter(value => value.kind === 'weapon').map(value => value.bonus))
    + Math.max(0, ...parryValues.filter(value => value.kind === 'shield').map(value => value.bonus))
    + parryValues.filter(value => value.bonus < 0).reduce((sum, value) => sum + value.bonus, 0);
  const parryBase = 2 + (fight ? half(fight) : 0) + finite(state.bonuses.parry) + weaponParry
    + (state.status.defending ? 4 : 0) - (state.status.prone ? 2 : 0);
  const parry = override(state, 'parry', !auto ? finite(state.stats.parry, parryBase) : applyModifiers(parryBase, 'parry', modifiers));
  const toughBase = 2 + half(vigor) + size + armor + finite(state.bonuses.toughness);
  const toughness = override(state, 'toughness', !auto ? finite(state.stats.toughness, toughBase) : applyModifiers(toughBase, 'toughness', modifiers));
  const loadLimit = loadLimitFor(state, modifiers);
  const carried = finite(state.load.carried, carriedWeight(state));
  const encumbered = auto ? state.load.encumbered || carried > loadLimit : state.load.encumbered;
  const resource = effectiveResources(state, modifiers);
  const woundsPenalty = rules.enableWoundPace === false ? 0 : Math.min(3, resource.wounds);
  const paceBase = finite(state.stats.basePace, 6) + finite(state.bonuses.pace) - woundsPenalty - (penalizedLoad && encumbered ? 2 : 0) - equipmentPenalty(state);
  const pace = Math.max(1, override(state, 'pace', !auto ? finite(state.stats.pace, 6) : applyModifiers(paceBase, 'pace', modifiers)));
  const running = normalizeTrait({die: override(state, 'runningDie', state.stats.runningDie), modifier: state.stats.runningModifier}, {fallbackDie: 6});
  const runningModifier = applyModifiers(running.modifier + finite(state.bonuses.running) - (penalizedLoad && encumbered ? 2 : 0), 'running', modifiers);
  const rank = state.overrides.rank ?? (!auto && state.identity.rank ? state.identity.rank : rankForAdvances(state.identity.advances));
  const scaleWounds = size >= 12 ? 3 : size >= 8 ? 2 : size >= 4 ? 1 : 0;
  const woundsMax = Math.max(0, finite(state.profile.woundCapacity, (state.profile.kind === 'extra' ? 0 : 3) + scaleWounds + finite(state.bonuses.woundCapacity)));
  return {parry, toughness, armor, pace, runningDie: running.die, runningModifier, size, rank, loadLimit, carried,
    encumbered, penalty: traitPenalty(state,{rules}), woundsMax};
}

export function validateProgressLedger(sheet) {
  const state = normalizeSheet(sheet), ledger = rows(state.advancement.ledger), errors = [], used = new Map(), attributes = new Map();
  const available = count(state.identity.advances);
  const error = (index, code) => errors.push({index, code});
  ledger.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { error(index, 'entry'); return; }
    const advance = Number(entry.advance), cost = Number(entry.cost ?? 1);
    if (!Number.isInteger(advance) || advance < 1 || advance > available) error(index, 'advance');
    if (!Number.isInteger(cost) || cost < 1 || cost > 2 || (entry.kind !== 'hindrance' && cost !== 1)) error(index, 'cost');
    if (!['attribute', 'skill', 'edge', 'hindrance'].includes(entry.kind)) error(index, 'kind');
    if (Number.isInteger(advance) && advance >= 1 && Number.isInteger(cost) && cost >= 1 && cost <= 2) for (let spent = advance - cost + 1; spent <= advance; spent++) {
      if (spent < 1 || used.has(spent)) error(index, 'duplicate'); else used.set(spent, index);
    }
    if (entry.kind === 'attribute' && Number.isInteger(advance)) {
      const rank = rankForAdvances(advance), prior = attributes.get(rank) ?? [];
      if (prior.some(value => rank !== 'legendary' || Math.abs(advance - value) < 2)) error(index, 'attribute-frequency');
      attributes.set(rank, [...prior, advance]);
    }
    const changes = rows(entry.changes);
    if (entry.kind === 'skill' && changes.length > 2) error(index, 'skill-count');
    if (entry.kind === 'skill' && changes.length === 2 && changes.some(change => {
      if (!change.before || !change.attribute) return false;
      const before = normalizeTrait(change.before), attribute = normalizeTrait(change.attribute);
      return strengthSteps(before) >= strengthSteps(attribute);
    })) error(index, 'skill-cost');
  });
  return {valid: errors.length === 0, errors, spent: used.size, available: Math.max(0, available - used.size)};
}
