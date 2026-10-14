import { cloneData } from './model.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = power => object(power?.data) ? power.data : object(power) ? power : {};
const finite = value => value !== '' && value !== null && value !== undefined && typeof value !== 'boolean' && Number.isFinite(Number(value));
const numeric = (value, fallback = 0) => finite(value) ? Number(value) : fallback;
const integer = (value, fallback = 0) => Math.max(0, Math.floor(numeric(value, fallback)));
const entries = sheet => Array.isArray(sheet?.activePowers) ? sheet.activePowers : [];
const active = entry => entry?.active === true;
const withoutPowerPoints = (sheet, options) => (options.noPowerPoints ?? sheet?.rules?.noPowerPoints) === true;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `power-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const rejected = (sheet, error, extra = {}) => ({ ok: false, error, sheet: cloneData(sheet), ...extra });

/** Numeric costs only: power-specific effects and modifier names are supplied by the user. */
export function powerCost(power, options = {}) {
  const data = fields(power), errors = [];
  const base = options.baseCost ?? data.powerPoints;
  if (!finite(base) || Number(base) < 0) errors.push('base-cost-required');
  const additional = options.additionalCost ?? data.additionalCost ?? 0;
  if (!finite(additional) || Number(additional) < 0) errors.push('invalid-additional-cost');
  const limitations = options.limitations ?? data.limitations ?? 0;
  if (!finite(limitations) || Number(limitations) < 0 || !Number.isInteger(Number(limitations))) errors.push('invalid-limitations');
  const shorting = options.shorting ?? data.shorting ?? 0;
  if (!finite(shorting) || Number(shorting) < 0 || !Number.isInteger(Number(shorting))) errors.push('invalid-shorting');
  const target = options.targetCount ?? data.targetCount ?? 1;
  if (!finite(target) || Number(target) < 1 || !Number.isInteger(Number(target))) errors.push('invalid-target-count');
  const baseCost = Math.max(0, numeric(base)), additionalCost = Math.max(0, numeric(additional));
  const limitationReduction = integer(limitations), unreducedCost = baseCost + additionalCost;
  const minimumCost = Math.max(0, numeric(options.minimumCost, 1));
  const totalCost = Math.max(minimumCost, unreducedCost - limitationReduction - Math.max(0, numeric(options.costReduction)));
  const shorted = integer(shorting);
  if (shorted > totalCost) errors.push('shorting-exceeds-cost');
  const limitationBonus = limitationReduction > 0 ? Math.min(2, Math.max(0, limitationReduction - unreducedCost + 1)) : 0;
  const allocatedCost = Math.max(0, totalCost - shorted);
  const targetCount = Math.max(1, integer(target, 1));
  let skillModifier = limitationBonus - shorted;
  if (options.noPowerPoints === true) {
    skillModifier = limitationBonus - Math.ceil(totalCost / 2) - integer(options.maintainedCount);
    if (options.prepared) skillModifier = Math.min(limitationBonus - integer(options.maintainedCount), skillModifier + 2);
  }
  return { valid: errors.length === 0, errors, baseCost, additionalCost, limitationReduction, limitationBonus,
    totalCost, allocatedCost, shorting: shorted, skillModifier, targetCount };
}

const deviceRows = sheet => (Array.isArray(sheet?.inventory) ? sheet.inventory : []).filter(row => row?.type === 'arcane-device' && object(row.data));
const deviceKey = id => `device:${String(id)}`;
const allocation = row => Math.min(Math.max(0, numeric(row.data.powerPoints)), Math.max(0, numeric(row.data.allocatedPowerPoints)));
const reservedPoints = (sheet, poolId) => deviceRows(sheet).reduce((sum, row) => sum + (String(row.data.poolId ?? '') === String(poolId) ? allocation(row) : 0), 0);

/** Owned powers are bound explicitly by their row IDs; library/source IDs never grant a device access. */
export function devicePools(sheet, powerId) {
  return deviceRows(sheet).filter(row => powerId === undefined || (Array.isArray(row.data.powerIds) && row.data.powerIds.some(id => String(id) === String(powerId))))
    .map(row => ({ id: deviceKey(row.id), label: String(row.name ?? ''), current: Math.max(0, numeric(row.data.powerPoints)),
      max: finite(row.data.powerPointsMax) ? Math.max(0, Number(row.data.powerPointsMax)) : null, skillId: String(row.data.skillId ?? ''),
      allocatedPowerPoints: allocation(row), originPoolId: String(row.data.poolId ?? '') }));
}

function poolAccess(sheet, poolId = '') {
  if (String(poolId).startsWith('device:')) {
    const row = deviceRows(sheet).find(value => String(value.id) === String(poolId).slice(7));
    if (!row) return null;
    return { kind: 'device', row, current: Math.max(0, numeric(row.data.powerPoints)),
      max: finite(row.data.powerPointsMax) ? Math.max(0, Number(row.data.powerPointsMax)) : null,
      skillId: String(row.data.skillId ?? ''), set(value) {
        const spent = Math.max(0, Math.max(0, numeric(row.data.powerPoints)) - value);
        row.data.allocatedPowerPoints = Math.max(0, allocation(row) - spent);
        row.data.powerPoints = Math.max(0, value);
      } };
  }
  if (poolId) {
    const pool = (Array.isArray(sheet.arcanePools) ? sheet.arcanePools : []).find(entry => String(entry.id) === String(poolId));
    if (!pool) return null;
    const reserved = reservedPoints(sheet, poolId), baseMax = finite(pool.max) ? Math.max(0, Number(pool.max)) : null;
    return { kind: 'personal', pool, current: Math.max(0, numeric(pool.current)), reserved, baseMax,
      max: baseMax === null ? null : Math.max(0, baseMax - reserved),
      set(value) { pool.current = Math.max(0, value); } };
  }
  sheet.resources ??= {};
  const reserved = reservedPoints(sheet, ''), baseMax = finite(sheet.resources.powerPointsMax) ? Math.max(0, Number(sheet.resources.powerPointsMax)) : null;
  return { kind: 'personal', current: Math.max(0, numeric(sheet.resources.powerPoints)), reserved, baseMax,
    max: baseMax === null ? null : Math.max(0, baseMax - reserved),
    set(value) { sheet.resources.powerPoints = Math.max(0, value); } };
}

function endAll(sheet) {
  const ended = [];
  for (const entry of entries(sheet)) if (active(entry)) { entry.active = false; ended.push(entry.id); }
  return ended;
}

/** roll.total is FINAL, including powerCost.skillModifier and ordinary Trait modifiers. */
export function activatePower(sheet, power, roll, options = {}) {
  const data = fields(power), copy = cloneData(sheet);
  copy.activePowers = entries(copy);
  const noPowerPoints = withoutPowerPoints(sheet, options);
  const cost = powerCost(power, { ...options, noPowerPoints, maintainedCount: noPowerPoints ? entries(copy).filter(entry => active(entry) && entry.maintained).length : options.maintainedCount });
  if (!cost.valid) return rejected(sheet, 'invalid-cost', { cost });
  if (!finite(roll?.total)) return rejected(sheet, 'invalid-roll', { cost });
  if (copy.status?.bound) return rejected(sheet, 'bound', { cost });
  if (copy.status?.incapacitated || copy.status?.stunned) return rejected(sheet, 'cannot-act', { cost });
  const poolId = String(options.poolId ?? data.poolId ?? '');
  const isDevice = poolId.startsWith('device:');
  if (isDevice && noPowerPoints) return rejected(sheet, 'device-incompatible-no-power-points', { cost });
  if (isDevice && cost.shorting > 0) return rejected(sheet, 'device-cannot-short', { cost });
  const pool = noPowerPoints ? null : poolAccess(copy, poolId);
  if (!noPowerPoints && !pool) return rejected(sheet, 'pool-not-found', { cost });
  if (isDevice && !(Array.isArray(pool.row.data.powerIds) && pool.row.data.powerIds.some(id => String(id) === String(power.id))))
    return rejected(sheet, 'power-not-in-device', { cost });
  if (!noPowerPoints && pool.current < cost.allocatedCost) return rejected(sheet, 'insufficient-power-points', { cost, available: pool.current });
  const total = Number(roll.total), success = total >= 4;
  const critical = roll.criticalFailure === true || (!success && cost.shorting > 0 && !noPowerPoints);
  const outcome = critical ? 'criticalFailure' : success ? 'success' : 'failure';
  const raises = outcome === 'success' ? Math.max(0, Math.floor((total - 4) / 4)) : 0;
  const failureCost = Math.max(0, numeric(options.failureCost, 1));
  const spent = noPowerPoints ? 0 : outcome === 'success' ? cost.allocatedCost : Math.min(pool.current, failureCost);
  if (pool) pool.set(pool.current - spent);
  let endedPowerIds = [], fatigueAdded = 0, activePower = null;
  if (critical) {
    if (!isDevice) endedPowerIds = endAll(copy);
    copy.resources ??= {}; copy.status ??= {};
    const before = integer(copy.resources.fatigue);
    copy.resources.fatigue = Math.min(2, before + 1);
    fatigueAdded = 1;
    if (before >= 2) { copy.status.incapacitated = true; copy.combat ??= {}; copy.combat.incapacitationCause = 'fatigue'; }
    if (noPowerPoints) copy.status.shaken = true;
  } else if (!success && noPowerPoints) {
    endedPowerIds = endAll(copy); copy.status ??= {}; copy.status.shaken = true;
  } else if (success && (data.maintainable === true || integer(options.durationRounds ?? data.durationRounds) > 0)) {
    const durationRounds = integer(options.durationRounds ?? data.durationRounds);
    activePower = { id: String(options.id ?? newId()), powerId: String(power.id ?? ''), poolId, name: String(power.name ?? ''),
      targetCount: cost.targetCount, targetIds: cloneData(Array.isArray(options.targetIds) ? options.targetIds : []),
      effects: cloneData(Array.isArray(options.effects) ? options.effects : Array.isArray(data.effects) ? data.effects : []), durationRounds,
      remainingRounds: durationRounds > 0 ? durationRounds : null, maintained: false, active: true };
    if (options.sourceActorId !== undefined) activePower.sourceActorId = options.sourceActorId;
    if (options.sourceTokenId !== undefined) activePower.sourceTokenId = options.sourceTokenId;
    copy.activePowers.push(activePower);
  }
  return { ok: true, sheet: copy, outcome, total, raises, cost, spent, activePower, endedPowerIds, fatigueAdded,
    activationSkillId: isDevice ? pool.skillId : String(data.skillId ?? '') };
}

/** One point PER target renews the BASE duration, irrespective of activation modifiers. */
export function maintainPower(sheet, activeId, options = {}) {
  const copy = cloneData(sheet), entry = entries(copy).find(value => String(value.id) === String(activeId));
  if (!entry || !active(entry)) return rejected(sheet, 'power-not-active');
  const noPowerPoints = withoutPowerPoints(sheet, options);
  if (String(entry.poolId ?? '').startsWith('device:') && noPowerPoints) return rejected(sheet, 'device-incompatible-no-power-points');
  const cost = noPowerPoints ? 0 : Math.max(1, integer(entry.targetCount, 1));
  const pool = noPowerPoints ? null : poolAccess(copy, String(entry.poolId ?? ''));
  if (!noPowerPoints && !pool) return rejected(sheet, 'pool-not-found');
  if (pool && pool.current < cost) return rejected(sheet, 'insufficient-power-points', { cost, available: pool.current });
  if (pool) pool.set(pool.current - cost);
  entry.maintained = true;
  const duration = integer(entry.durationRounds);
  entry.remainingRounds = noPowerPoints ? null : duration > 0 ? Math.max(0, integer(entry.remainingRounds)) + duration : null;
  return { ok: true, sheet: copy, spent: cost, activePower: entry };
}

export function endPower(sheet, activeId) {
  const copy = cloneData(sheet), entry = entries(copy).find(value => String(value.id) === String(activeId));
  if (!entry) return rejected(sheet, 'power-not-found');
  const wasActive = active(entry); entry.active = false;
  return { ok: true, sheet: copy, endedPowerIds: wasActive ? [entry.id] : [] };
}

/** Used at the END of the caster's turn, not at every combatant transition. */
export function advancePowers(sheet, rounds = 1) {
  if (!finite(rounds) || Number(rounds) < 0 || !Number.isInteger(Number(rounds))) return rejected(sheet, 'invalid-round-count');
  const copy = cloneData(sheet), endedPowerIds = [];
  for (const entry of entries(copy)) {
    if (!active(entry) || entry.remainingRounds === null || !finite(entry.remainingRounds) || integer(entry.durationRounds) === 0) continue;
    entry.remainingRounds = Math.max(0, integer(entry.remainingRounds) - Number(rounds));
    if (entry.remainingRounds === 0) { entry.active = false; endedPowerIds.push(entry.id); }
  }
  return { ok: true, sheet: copy, endedPowerIds };
}

/** Rest is explicit; a Benny restores five points without the rest restrictions. */
export function rechargePowerPool(sheet, poolId = '', options = {}) {
  if (withoutPowerPoints(sheet, options)) return rejected(sheet, 'no-power-points');
  const copy = cloneData(sheet), pool = poolAccess(copy, String(poolId ?? ''));
  if (!pool) return rejected(sheet, 'pool-not-found');
  if (pool.kind === 'device') return rejected(sheet, 'device-does-not-recharge');
  if (pool.max === null) return rejected(sheet, 'maximum-required');
  if (!options.benny && entries(copy).some(entry => active(entry) && entry.maintained)) return rejected(sheet, 'maintaining-powers');
  const hours = options.hours ?? 1;
  if (!options.benny && (!finite(hours) || Number(hours) < 0)) return rejected(sheet, 'invalid-rest-duration');
  if (!options.benny && options.restAllowed === false) return rejected(sheet, 'rest-not-allowed');
  const requested = options.benny ? 5 : Math.floor(Number(hours) * Math.max(0, numeric(options.rate, 5)));
  const recovered = Math.max(0, Math.min(pool.max, pool.current + requested) - pool.current);
  if (options.benny) {
    copy.resources ??= {};
    if (integer(copy.resources.bennies) < 1) return rejected(sheet, 'insufficient-bennies');
    if (recovered === 0) return rejected(sheet, 'pool-full');
    copy.resources.bennies = integer(copy.resources.bennies) - 1;
  }
  pool.set(pool.current + recovered);
  return { ok: true, sheet: copy, recovered, spentBennies: options.benny ? 1 : 0, reserved: pool.reserved, availableMaximum: pool.max };
}

/** Adjustments transfer at most five OWN points per action and require physical contact. */
export function transferDevicePower(sheet, deviceId, options = {}) {
  const copy = cloneData(sheet), row = deviceRows(copy).find(value => String(value.id) === String(deviceId).replace(/^device:/, ''));
  if (!row) return rejected(sheet, 'device-not-found');
  if (withoutPowerPoints(sheet, options)) return rejected(sheet, 'device-incompatible-no-power-points');
  if (options.physicalContact === false) return rejected(sheet, 'physical-contact-required');
  const amount = options.amount ?? 5;
  if (!finite(amount) || !Number.isInteger(Number(amount)) || Number(amount) < 1 || Number(amount) > 5) return rejected(sheet, 'invalid-transfer-amount');
  const direction = options.direction ?? 'to-device';
  if (!['to-device', 'from-device'].includes(direction)) return rejected(sheet, 'invalid-transfer-direction');
  const poolId = String(options.poolId ?? row.data.poolId ?? '');
  if (poolId.startsWith('device:')) return rejected(sheet, 'personal-pool-required');
  const pool = poolAccess(copy, poolId), device = poolAccess(copy, deviceKey(row.id));
  if (!pool) return rejected(sheet, 'pool-not-found');
  if (pool.max === null || device.max === null) return rejected(sheet, 'maximum-required');
  if (pool.current > pool.max) return rejected(sheet, 'personal-pool-overfilled');
  const allocated = allocation(row), value = Number(amount);
  if (allocated > 0 && String(row.data.poolId ?? '') !== poolId) return rejected(sheet, 'device-allocation-pool-mismatch');
  if (direction === 'to-device') {
    if (pool.current < value) return rejected(sheet, 'insufficient-power-points', { available: pool.current });
    if (device.current + value > device.max) return rejected(sheet, 'device-capacity-exceeded');
    pool.set(pool.current - value); device.set(device.current + value);
    row.data.poolId = poolId; row.data.allocatedPowerPoints = allocated + value;
  } else {
    if (value > allocated || value > device.current) return rejected(sheet, 'insufficient-device-allocation', { available: allocated });
    device.set(device.current - value);
    const restoredPool = poolAccess(copy, poolId);
    if (restoredPool.current + value > restoredPool.max) return rejected(sheet, 'personal-pool-capacity-exceeded');
    restoredPool.set(restoredPool.current + value);
  }
  return { ok: true, sheet: copy, transferred: value, direction, deviceId: String(row.id), poolId,
    allocatedPowerPoints: row.data.allocatedPowerPoints, deviceCurrent: row.data.powerPoints };
}
