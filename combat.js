/** Combat state transitions owned entirely by the Savage Worlds package. */
import {cloneData, normalizeSheet} from './model.js';
import {derive} from './mechanics.js';
const integer = value => Math.max(0, Math.trunc(Number(value) || 0));

export function woundCapacity(sheet) {
  return integer(derive(sheet).woundsMax);
}

export function damageResult({damage, toughness, armor = 0, armorPiercing = 0, shaken = false, physical = true,
  heavyArmor = false, heavyWeapon = false} = {}) {
  const effectiveArmor = Math.max(0, Number(armor) - Math.max(0, Number(armorPiercing) || 0));
  const threshold = Number(toughness) - Math.max(0, Number(armor) || 0) + effectiveArmor;
  const margin = Number(damage) - threshold;
  if (!Number.isFinite(margin)) throw new TypeError('Damage and Toughness must be numeric.');
  if (margin < 0 || heavyArmor && !heavyWeapon) return {damage: Number(damage), toughness: threshold, wounds: 0, shaken: false, blocked: heavyArmor && !heavyWeapon};
  const raises = Math.floor(margin / 4);
  return {damage: Number(damage), toughness: threshold, wounds: raises || (shaken && physical ? 1 : 0), shaken: true, raises, blocked: false};
}

export function applyDamage(sheet, result, {soaked = 0, nonlethal = false, woundCap = false} = {}) {
  const next = normalizeSheet(sheet);
  let incoming = integer(result.wounds); if (woundCap) incoming = Math.min(incoming, 4);
  const remaining = Math.max(0, incoming - integer(soaked));
  if (integer(soaked) > 0 && remaining === 0) next.status.shaken = false;
  else if (result.shaken) next.status.shaken = true;
  const capacity = woundCapacity(next), previous = integer(next.resources.wounds);
  if (previous + remaining > capacity) {
    next.status.incapacitated = true;
    next.combat ??= {}; next.combat.incapacitationCause = nonlethal ? 'nonlethal' : 'wounds';
  }
  next.resources.wounds = Math.min(capacity, previous + remaining);
  if (next.status.shaken || next.status.stunned || next.status.incapacitated) next.status.holding = false;
  return next;
}

export function soakAmount(outcome, incoming) {
  return outcome.success && !outcome.critical ? Math.min(integer(incoming), 1 + integer(outcome.raises)) : 0;
}

export function spendBenny(sheet, effect = 'spend') {
  const next = normalizeSheet(sheet);
  if (next.resources.bennies < 1) throw new RangeError('No Benny is available.');
  next.resources.bennies--;
  if (effect === 'unshake') next.status.shaken = false;
  return next;
}

export function applyFatigue(sheet, levels = 1, {canIncapacitate = true} = {}) {
  const next = normalizeSheet(sheet), value = next.resources.fatigue + Math.trunc(Number(levels) || 0);
  if (value > 2 && canIncapacitate) {
    next.status.incapacitated = true; next.combat ??= {}; next.combat.incapacitationCause = 'fatigue';
  }
  next.resources.fatigue = Math.max(0, Math.min(2, value));
  if (levels < 0 && next.combat?.incapacitationCause === 'fatigue') {
    next.status.incapacitated = false; next.combat.incapacitationCause = '';
  }
  if (next.status.incapacitated) next.status.holding = false;
  return next;
}

export function recoverShaken(sheet, outcome) {
  const next = normalizeSheet(sheet); if (outcome.success) next.status.shaken = false; return next;
}

export function recoverStunned(sheet, outcome) {
  const next = normalizeSheet(sheet);
  if (!outcome.success) return next;
  next.status.stunned = false; next.status.vulnerable = true;
  next.statusClocks ??= {};
  next.statusClocks.vulnerable = {remaining: 1, phase: 'end', owner: 'self', awaitingStart: outcome.raises === 0};
  return next;
}

export function applyState(sheet, key, active = true) {
  const next = normalizeSheet(sheet); next.status[key] = active;
  if (next.status.shaken || next.status.stunned || next.status.incapacitated) next.status.holding = false;
  next.statusClocks ??= {};
  if (!active) {delete next.statusClocks[key]; return next;}
  if (key === 'distracted' || key === 'vulnerable') next.statusClocks[key] = {remaining: 1, phase: 'end', owner: 'self', awaitingStart: true};
  if (key === 'stunned') {
    next.status.prone = next.status.distracted = next.status.vulnerable = true;
    next.statusClocks.distracted = {remaining: 1, phase: 'end', owner: 'self', awaitingStart: true};
  }
  return next;
}

export function escapeRestraint(sheet, outcome) {
  const next = normalizeSheet(sheet);
  if (outcome.success) {
    if (next.status.bound && outcome.raises === 0) {next.status.bound = false; next.status.entangled = true;}
    else next.status.bound = next.status.entangled = false;
  }
  return next;
}

export function healingResult(sheet, outcome, {natural = false, stabilization = false} = {}) {
  const next = normalizeSheet(sheet);
  if (stabilization) {if (outcome.success) next.status.bleedingOut = false; return next;}
  if (outcome.critical) {
    const capacity = woundCapacity(next), value = next.resources.wounds + 1;
    next.resources.wounds = Math.min(capacity, value);
    if (value > capacity) {next.status.incapacitated = true; next.combat ??= {}; next.combat.incapacitationCause = natural ? 'infection' : 'wounds';}
  } else if (outcome.success) {
    const previous = next.resources.wounds;
    next.resources.wounds = Math.max(0, previous - (outcome.raises > 0 ? 2 : 1));
    if (next.resources.wounds < previous) {
      next.status.incapacitated = false; if (next.combat) next.combat.incapacitationCause = '';
    }
  }
  if (next.status.incapacitated) next.status.holding = false;
  return next;
}

export function incapacitationResult(sheet, outcome, {bleeding = false} = {}) {
  const next = normalizeSheet(sheet);
  next.status.holding = false;
  if (bleeding) {
    if (!outcome.success) next.status.dead = true;
    else if (outcome.raises > 0) next.status.bleedingOut = false;
  } else if (outcome.critical) next.status.dead = true;
  else {
    next.status.bleedingOut = !outcome.success;
    next.combat ??= {};
    // Injury details are user-authored; no rulebook injury table is bundled.
    next.combat.injuryDuration = !outcome.success ? 'permanent' : outcome.raises > 0 ? '24-hours-or-healed' : 'until-healed';
  }
  return next;
}

export function supportBonus(outcome, current = 0, {strength = false} = {}) {
  if (outcome.critical) return Number(current) - 2;
  return outcome.success ? Math.min(strength ? Infinity : 4, Number(current) + (outcome.raises > 0 ? 2 : 1)) : Number(current);
}

export function testResult(sheet, outcome, state = 'distracted') {
  let next = normalizeSheet(sheet);
  if (outcome.success) {
    next = applyState(next, state === 'vulnerable' ? 'vulnerable' : 'distracted');
    if (outcome.raises > 0) next.status.shaken = true;
    if (next.status.shaken) next.status.holding = false;
  }
  return next;
}
