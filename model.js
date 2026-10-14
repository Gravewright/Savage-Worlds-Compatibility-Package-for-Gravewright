/** Original SWADE structures and numeric metadata. No supplied game content. */
export const SCHEMA_VERSION = 2;
export const DICE = Object.freeze([4, 6, 8, 10, 12]);
export const CHARACTER_KINDS = Object.freeze(['wild-card', 'extra']);
export const WEIGHT_UNITS = Object.freeze(['kg', 'lb']);
export const SKILL_ROLES = Object.freeze(['', 'fighting', 'shooting', 'athletics', 'healing', 'notice', 'driving', 'piloting', 'arcane']);
export const STATUSES = Object.freeze(['shaken', 'distracted', 'vulnerable', 'stunned', 'entangled',
  'bound', 'prone', 'incapacitated', 'bleedingOut', 'dead', 'holding', 'aiming', 'defending']);
export const STAGES = Object.freeze([
  ['novice', 0, 3], ['seasoned', 4, 7], ['veteran', 8, 11], ['heroic', 12, 15], ['legendary', 16, null],
].map(([id, min, max]) => Object.freeze({ id, min, max, labelKey: `rules.rank.${id}` })));

export const ATTRIBUTES = Object.freeze(['agility', 'smarts', 'spirit', 'strength', 'vigor']
  .map(id => Object.freeze({ id, labelKey: `attribute.${id}` })));

export const ITEM_TYPES = Object.freeze([
  ['weapon', 'inventory', 'Sword'], ['armor', 'inventory', 'ShieldCheck'],
  ['equipment', 'inventory', 'Backpack'], ['consumable', 'inventory', 'Backpack'],
  ['skill', 'skills', 'Sparkle'], ['edge', 'edges', 'Sparkle'],
  ['hindrance', 'hindrances', 'User'], ['ancestry', 'ancestries', 'User'],
  ['racial-feature', 'racialFeatures', 'User'], ['power', 'powers', 'Scroll'],
  ['effect', 'effects', 'Sparkle'],
  ['vehicle', 'inventory', 'Backpack'], ['arcane-device', 'inventory', 'Scroll'],
].map(([id, collection, icon]) => Object.freeze({ id, collection, icon, labelKey: `item.type.${id}` })));

export const ITEM_TYPE_IDS = Object.freeze(ITEM_TYPES.map(type => type.id));
export const COLLECTIONS = Object.freeze([...new Set(ITEM_TYPES.map(type => type.collection))]);
export const RESOURCE_LIMITS = Object.freeze({ wounds: 3, fatigue: 2 });

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'constructor', 'prototype'].includes(key);

/** Produce JSON-compatible copies without retaining aliases to native documents. */
export function cloneData(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(entry => cloneData(entry) ?? null);
  if (record(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => safeKey(key) && entry !== undefined && typeof entry !== 'function')
    .map(([key, entry]) => [key, cloneData(entry)]));
  return null;
}

const text = value => typeof value === 'string' ? value : value == null ? '' : String(value);
const manual = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : '';
const number = (value, fallback = 0) => {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const integer = (value, fallback = 0) => Math.trunc(number(value, fallback));
const flag = value => value === true;
const merged = (defaults, value) => ({ ...defaults, ...(record(value) ? cloneData(value) : {}) });

export function normalizeTrait(value, { empty = false, fallbackDie = 4 } = {}) {
  const result = record(value) ? cloneData(value) : { die: value };
  const input = typeof result.die === 'string' ? result.die.trim().replace(/\s/g, '') : result.die;
  const expression = typeof input === 'string' ? /^d?(4|6|8|10|12)([+-]\d+)?$/i.exec(input) : null;
  const parsed = expression ? Number(expression[1]) : number(input, fallbackDie);
  const modifier = integer(result.modifier, 0) + (expression?.[2] ? Number(expression[2]) : 0);
  result.die = empty && (input === '' || input == null) ? '' : DICE.includes(parsed) ? parsed : fallbackDie;
  if (parsed === 1 && !Object.hasOwn(result, 'fixedValue')) result.fixedValue = 1;
  if (Object.hasOwn(result, 'fixedValue')) result.fixedValue = result.fixedValue === '' || result.fixedValue == null ? null : number(result.fixedValue, null);
  if (input !== '' && input != null && !DICE.includes(parsed) && parsed !== 1 && !Object.hasOwn(result, 'originalDie')) result.originalDie = cloneData(input);
  result.modifier = empty && result.die === '' && (result.modifier === '' || result.modifier == null) ? '' : modifier;
  return result;
}

export function normalizeModifiers(value) {
  return (Array.isArray(value) ? value : []).filter(record).map(entry => ({
    ...cloneData(entry), target: text(entry.target), value: number(entry.value, 0),
    mode: entry.mode === 'override' ? 'override' : 'add', enabled: entry.enabled !== false,
  }));
}

export function canonicalItemType(type) {
  const aliases = { racialFeature: 'racial-feature', gear: 'equipment', shield: 'armor', ability: 'racial-feature' };
  const id = Object.hasOwn(aliases, type) ? aliases[type] : text(type);
  return ITEM_TYPE_IDS.includes(id) ? id : null;
}

export function collectionForType(type) {
  return ITEM_TYPES.find(candidate => candidate.id === canonicalItemType(type))?.collection ?? null;
}

export function createSheet(options = {}) {
  const actorType = typeof options === 'string' ? options : options.actorType;
  const kind = actorType === 'npc' ? 'extra' : 'wild-card';
  return {
    schemaVersion: SCHEMA_VERSION,
    identity: { player: '', concept: '', ancestry: '', rank: '', advances: '' },
    attributes: Object.fromEntries(ATTRIBUTES.map(({ id }) => [id, { die: 4, modifier: 0 }])),
    profile: { kind,role:actorType==='npc'?'enemy':'player', wildDie: 6, woundCapacity: '', animalSmarts: false, initiative: { draw: 1, keep: 'highest', redrawBelow: 0 } },
    calculation: { automatic: true },
    links: { combatSkillId: '' },
    stats: { pace: '', basePace: 6, parry: '', toughness: '', armor: '', size: 0, runningDie: 6, runningModifier: 0 },
    bonuses: { parry: 0, toughness: 0, armor: 0, pace: 0, running: 0, load: 0, loadSteps: 0, minStrengthSteps: 0, woundCapacity: 0 },
    overrides: { parry: null, toughness: null, armor: null, pace: null, runningDie: null, loadLimit: null, rank: null },
    load: { unit: 'kg', limit: '', carried: '', encumbered: false },
    movements: { fly: '', swim: '', burrow: '' }, allies: { group: '', count: 1, ammoLevel: '' },
    advancement: { attributePoints: 5, skillPoints: 12, hindrancePoints: 0, ledger: [] },
    resources: { bennies: kind === 'extra' ? 0 : 3, wounds: 0, fatigue: 0, powerPoints: '', powerPointsMax: '', currency: '' },
    status: Object.fromEntries(STATUSES.map(key => [key, false])),
    ...Object.fromEntries(COLLECTIONS.map(key => [key, []])),
    arcanePools: [], activePowers: [], biography: '', notes: '',
  };
}

const COMMON_ITEM = Object.freeze({ img: '', description: '', notes: '', source: '', modifiers: [] });
const PHYSICAL_ITEM = Object.freeze({ quantity: 1, weight: '', weightUnit: '', cost: '', equipped: false, carried: true, minStrength: '', minStrengthModifier: 0 });
const ITEM_FIELDS = Object.freeze({
  weapon: { ...PHYSICAL_ITEM, attackType:'melee', category: '', damage: '', range: '', rangeBands: { short: '', medium: '', long: '' }, armorPiercing: '', rateOfFire: '', minStrength: '', shots: '', capacity: '', caliber: '', reload: 1, parryBonus: 0, reach: 0, heavy: false, properties: '' },
  armor: { ...PHYSICAL_ITEM, kind: 'armor', protection: '', coverage: '', locations: ['torso'], minStrength: '', parryBonus: 0, cover: 0, hardness: '', ballisticProtection: 0, heavy: false, properties: '' },
  equipment: { ...PHYSICAL_ITEM, category: '', properties: '' },
  consumable: { ...PHYSICAL_ITEM, category: '', uses: '', maxUses: '' },
  skill: { attribute: '', die: '', modifier: '', role: '', untrained: false },
  edge: { rank: '', requirements: '' },
  hindrance: { severity: '' },
  ancestry: { size: '', pace: '' },
  'racial-feature': { ancestry: '', requirements: '' },
  power: { rank: '', powerPoints: '', poolId: '', additionalCost: 0, limitations: 0, shorting: 0, targetCount: 1, durationRounds: 0, maintainable: false, range: '', duration: '', activation: '', skill: '', trapping: '' },
  effect: { category: '', duration: '', active: false },
  vehicle: { ...PHYSICAL_ITEM, carried: false, handling: '', topSpeed: '', size: '', protection: '', armor: '', heavy: false, crew: '', passengers: '', cargo: '', fuel: '', fuelMax: '', wounds: 0, woundsMax: 3, properties: '' },
  'arcane-device': { ...PHYSICAL_ITEM, powerIds: [], poolId: '', powerPoints: '', powerPointsMax: '', allocatedPowerPoints:0, skillId: '', properties: '' },
});

export function createItemSheet(type) {
  const id = canonicalItemType(type);
  if (!id) throw new TypeError(`Unsupported item type: ${type}`);
  const result = cloneData({ ...COMMON_ITEM, ...ITEM_FIELDS[id] });
  if (type === 'shield') { result.kind = 'shield'; result.locations = []; }
  return result;
}

export function normalizeItemSheet(type, value) {
  const defaults = createItemSheet(type);
  const source = record(value?.savageWorlds) ? { ...cloneData(value), ...cloneData(value.savageWorlds) } : value;
  const result = merged(defaults, source);
  const aliases = { ap: 'armorPiercing', rof: 'rateOfFire', armor: 'protection', pp: 'powerPoints', location: 'coverage' };
  if (record(source)) for (const [oldKey, key] of Object.entries(aliases)) {
    if (Object.hasOwn(defaults, key) && !Object.hasOwn(source, key) && Object.hasOwn(source, oldKey)) result[key] = cloneData(source[oldKey]);
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    if (typeof fallback === 'boolean') result[key] = flag(result[key]);
    else if (key === 'quantity') result[key] = Math.max(0, number(result[key], 1));
    else if (Array.isArray(fallback)) result[key] = Array.isArray(result[key]) ? cloneData(result[key]) : cloneData(fallback);
    else if (record(fallback)) result[key] = merged(fallback, result[key]);
    else if (typeof fallback === 'number') result[key] = number(result[key], fallback);
    else result[key] = manual(result[key]);
  }
  result.modifiers = normalizeModifiers(result.modifiers);
  if (canonicalItemType(type) === 'skill') {
    const trait = normalizeTrait(result, { empty: true });
    result.die = trait.die; result.modifier = trait.modifier;
  }
  if (canonicalItemType(type) === 'armor') {
    if (type === 'shield' && !Object.hasOwn(source ?? {}, 'kind')) result.kind = 'shield';
    if (result.kind !== 'shield') result.kind = 'armor';
    if (result.kind === 'shield' && !Object.hasOwn(source ?? {}, 'locations')) result.locations = [];
    else if (!Object.hasOwn(source ?? {}, 'locations') && result.coverage) {
      const value = String(result.coverage).toLowerCase(), locations = [];
      for (const [id, pattern] of [['torso', /torso|tronco/], ['head', /head|cabeça|cabeza/], ['arms', /arms|braços|brazos/], ['legs', /legs|pernas|piernas/], ['all', /whole|inteir|entero|\ball\b/]]) {
        if (pattern.test(value)) locations.push(id);
      }
      if (locations.length) result.locations = locations;
    }
    if (!Object.hasOwn(source ?? {}, 'parryBonus') && Object.hasOwn(source ?? {}, 'parry')) result.parryBonus = number(source.parry, 0);
    result.locations = result.locations.filter(location => typeof location === 'string');
  }
  return result;
}

function uniqueId() {
  return globalThis.crypto?.randomUUID?.() ?? `swade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Convert an api.items.sheet document to a new, independently editable row. */
export function itemToRow(item) {
  if (!record(item)) throw new TypeError('An item document is required');
  const type = canonicalItemType(item.type);
  if (!type) throw new TypeError(`Unsupported item type: ${item.type}`);
  const data = normalizeItemSheet(item.type, item.data);
  return {
    id: uniqueId(), sourceId: text(item.sourceId ?? item.id), type,
    name: text(item.name), img: text(item.img ?? data.img), data,
    quantity: Math.max(0, number(item.quantity ?? data.quantity, 1)),
    equipped: flag(item.equipped ?? data.equipped), prepared: flag(item.prepared),
  };
}

function normalizeRow(value) {
  if (!record(value)) return null;
  const type = canonicalItemType(value.type);
  if (!type) return null;
  const result = itemToRow(value);
  result.id = text(value.id) || result.id;
  return { ...cloneData(value), ...result };
}

export function normalizeSheet(value) {
  const defaults = createSheet();
  const legacy = !Object.hasOwn(record(value) ? value : {}, 'schemaVersion')
    ? record(value?.fields?.savageWorlds) ? value.fields.savageWorlds
      : record(value?.savageWorlds) ? value.savageWorlds
        : record(value) && value.schema === 1 ? value : null
    : null;
  const source = legacy ? { ...cloneData(value), ...cloneData(legacy) } : value;
  const result = merged(defaults, source);
  const migrating = record(source) && number(source.schemaVersion, 0) < SCHEMA_VERSION;
  if (legacy) {
    result.identity = merged(defaults.identity, source.identity);
    for (const key of ['concept', 'advances']) if (!Object.hasOwn(source.identity ?? {}, key) && Object.hasOwn(legacy, key)) result.identity[key] = legacy[key];
    result.stats = merged(defaults.stats, source.stats);
    for (const key of ['pace', 'parry', 'toughness', 'armor']) if (!Object.hasOwn(source.stats ?? {}, key) && Object.hasOwn(legacy, key)) result.stats[key] = legacy[key];
    result.resources = merged(defaults.resources, source.resources);
    for (const [oldKey, key] of Object.entries({ bennies: 'bennies', wounds: 'wounds', fatigue: 'fatigue', powerPoints: 'powerPoints', powerMax: 'powerPointsMax' })) {
      if (!Object.hasOwn(source.resources ?? {}, key) && Object.hasOwn(legacy, oldKey)) result.resources[key] = legacy[oldKey];
    }
    result.status = merged(defaults.status, source.status);
    for (const key of Object.keys(defaults.status)) if (!Object.hasOwn(source.status ?? {}, key)) result.status[key] = Array.isArray(legacy.conditions) && legacy.conditions.includes(key);
    for (const item of Array.isArray(legacy.items) ? legacy.items : []) {
      const collection = collectionForType(item?.type);
      if (collection && !Object.hasOwn(source, collection)) result[collection].push(cloneData(item));
    }
  }
  result.profile = merged(defaults.profile, result.profile);
  if (!Object.hasOwn(source?.profile ?? {}, 'kind') && typeof source?.wildCard === 'boolean') result.profile.kind = source.wildCard ? 'wild-card' : 'extra';
  if (!CHARACTER_KINDS.includes(result.profile.kind)) result.profile.kind = 'wild-card';
  if (!Object.hasOwn(source?.profile ?? {}, 'wildDie') && Object.hasOwn(source ?? {}, 'wildDie')) result.profile.wildDie = source.wildDie;
  result.profile.wildDie = normalizeTrait({ die: result.profile.wildDie }, { fallbackDie: 6 }).die;
  result.profile.animalSmarts = flag(result.profile.animalSmarts);
  if (!Object.hasOwn(source?.profile ?? {}, 'woundCapacity') && source?.wildCard !== false && Object.hasOwn(source ?? {}, 'woundMax')) result.profile.woundCapacity = source.woundMax;
  result.profile.woundCapacity = result.profile.woundCapacity === '' || result.profile.woundCapacity == null ? '' : Math.max(0, integer(result.profile.woundCapacity, 0));
  result.profile.initiative = merged(defaults.profile.initiative, result.profile.initiative);
  result.profile.initiative.draw = Math.max(1, integer(result.profile.initiative.draw, 1));
  result.profile.initiative.keep = result.profile.initiative.keep === 'lowest' ? 'lowest' : 'highest';
  result.profile.initiative.redrawBelow = Math.max(0, integer(result.profile.initiative.redrawBelow, 0));
  result.calculation = merged(defaults.calculation, result.calculation);
  if (migrating && !Object.hasOwn(source?.calculation ?? {}, 'automatic')) result.calculation.automatic = false;
  result.calculation.automatic = flag(result.calculation.automatic);
  result.links = merged(defaults.links, result.links);
  result.links.combatSkillId = text(result.links.combatSkillId);
  result.bonuses = merged(defaults.bonuses, result.bonuses);
  for (const key of Object.keys(defaults.bonuses)) {
    if (!Object.hasOwn(source?.bonuses ?? {}, key) && Object.hasOwn(source ?? {}, `${key}Bonus`)) result.bonuses[key] = source[`${key}Bonus`];
    result.bonuses[key] = number(result.bonuses[key], 0);
  }
  result.overrides = merged(defaults.overrides, result.overrides);
  if (migrating) {
    for (const key of ['parry', 'toughness', 'armor', 'pace', 'runningDie']) {
      const prior = source?.stats?.[key];
      if (!Object.hasOwn(source?.overrides ?? {}, key) && prior !== '' && prior != null) result.overrides[key] = cloneData(prior);
    }
    if (!Object.hasOwn(source?.overrides ?? {}, 'loadLimit') && source?.loadLimit !== '' && source?.loadLimit != null) result.overrides.loadLimit = cloneData(source.loadLimit);
    if (!Object.hasOwn(source?.overrides ?? {}, 'rank') && source?.identity?.rank) result.overrides.rank = text(source.identity.rank);
  }
  for (const key of Object.keys(defaults.overrides)) {
    if (result.overrides[key] === '' || result.overrides[key] === undefined) result.overrides[key] = null;
  }
  result.load = merged(defaults.load, result.load);
  result.load.unit = result.load.unit === 'lb' || result.load.unit === 'lbs' ? 'lb' : 'kg';
  result.load.limit = manual(result.load.limit);
  result.load.carried = manual(result.load.carried);
  if (!Object.hasOwn(source?.load ?? {}, 'encumbered') && typeof source?.encumbered === 'boolean') result.load.encumbered = source.encumbered;
  result.load.encumbered = flag(result.load.encumbered);
  result.movements = merged(defaults.movements, result.movements);
  for (const key of Object.keys(defaults.movements)) result.movements[key] = manual(result.movements[key]);
  result.allies = merged(defaults.allies, result.allies);
  result.allies.group = text(result.allies.group); result.allies.ammoLevel = manual(result.allies.ammoLevel);
  result.allies.count = Math.max(1, integer(result.allies.count, 1));
  result.advancement = merged(defaults.advancement, result.advancement);
  for (const key of ['attributePoints', 'skillPoints', 'hindrancePoints']) result.advancement[key] = Math.max(0, integer(result.advancement[key], defaults.advancement[key]));
  result.advancement.ledger = Array.isArray(result.advancement.ledger) ? cloneData(result.advancement.ledger) : [];
  for (const key of ['arcanePools', 'activePowers']) result[key] = Array.isArray(result[key]) ? cloneData(result[key]) : [];
  result.schemaVersion = SCHEMA_VERSION;
  result.identity = merged(defaults.identity, result.identity);
  for (const key of Object.keys(defaults.identity)) result.identity[key] = manual(result.identity[key]);
  result.identity.advances = result.identity.advances === '' ? '' : Math.max(0, integer(result.identity.advances, 0));
  result.attributes = merged(defaults.attributes, result.attributes);
  for (const { id } of ATTRIBUTES) {
    result.attributes[id] = normalizeTrait(merged(defaults.attributes[id], result.attributes[id]));
  }
  result.stats = merged(defaults.stats, result.stats);
  for (const key of Object.keys(defaults.stats)) result.stats[key] = manual(result.stats[key]);
  if (!Object.hasOwn(source?.stats ?? {}, 'size') && Object.hasOwn(source ?? {}, 'size')) result.stats.size = source.size;
  result.stats.size = integer(result.stats.size, 0);
  if (!Object.hasOwn(source?.stats ?? {}, 'runningDie') && Object.hasOwn(source ?? {}, 'runningDie')) result.stats.runningDie = source.runningDie;
  const running = normalizeTrait({ die: result.stats.runningDie, modifier: result.stats.runningModifier }, { fallbackDie: 6 });
  result.stats.runningDie = running.die; result.stats.runningModifier = running.modifier;
  result.resources = merged(defaults.resources, result.resources);
  for (const key of ['bennies', 'wounds', 'fatigue']) result.resources[key] = Math.max(0, integer(result.resources[key], 0));
  for (const key of ['powerPoints', 'powerPointsMax', 'currency']) result.resources[key] = manual(result.resources[key]);
  if (!Object.hasOwn(source?.resources ?? {}, 'currency') && Object.hasOwn(source ?? {}, 'currency')) result.resources.currency = manual(source.currency);
  result.status = merged(defaults.status, result.status);
  for (const key of Object.keys(defaults.status)) result.status[key] = flag(result.status[key]);
  for (const key of COLLECTIONS) result[key] = (Array.isArray(result[key]) ? result[key] : [])
    .map(normalizeRow).filter(row => row && collectionForType(row.type) === key);
  result.biography = text(result.biography);
  result.notes = text(result.notes);
  return result;
}

/** Append without mutating the actor, the item document, or another row. */
export function insertItem(sheet, item) {
  const result = normalizeSheet(sheet), row = itemToRow(item);
  result[collectionForType(row.type)].push(row);
  return result;
}
