/** Package-owned clocks persisted through the native sheet API. */
import {cloneData} from './model.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 10000 ? number : null;
};
function ownerMatches(clock, event) {
  const owner = Object.hasOwn(clock, 'owner') ? clock.owner : 'self';
  if (owner === 'self') return event.isCurrent === true;
  if (owner !== 'source') return false;
  if (clock.sourceTokenId) return String(clock.sourceTokenId) === event.tokenId;
  if (clock.sourceActorId) return String(clock.sourceActorId) === event.actorId;
  return false;
}
function matches(clock, event) {
  if (clock.phase === 'round') return event.phase === 'end' && event.roundBoundary === true;
  return ['start', 'end'].includes(clock.phase) && clock.phase === event.phase && ownerMatches(clock, event);
}
function claim(event, collection, index, phase) {
  if (!Array.isArray(event.documentKey) || !(event.clockKeys instanceof Set)) return false;
  const key = JSON.stringify(['swade-clock', event.documentKey, collection, index, phase]);
  if (event.clockKeys.has(key)) return false;
  event.clockKeys.add(key); return true;
}

/** The caller owns authorization, native persistence and durable retry markers. */
export function advanceClocks(value, event) {
  const sheet = cloneData(value);
  if (!record(sheet) || !record(event) || !['start', 'end'].includes(event.phase)) return {sheet, changed: false};
  let changed = false;
  if (record(sheet.status) && sheet.status.holding === true && (sheet.status.shaken === true || sheet.status.stunned === true || sheet.status.incapacitated === true)) {
    sheet.status.holding = false; changed = true;
  }
  if (event.phase === 'start' && event.roundBoundary === true && sheet.combat?.cardInitiative === true) return {sheet, changed};
  if (record(sheet.status) && record(sheet.statusClocks)) for (const name of ['distracted', 'vulnerable']) {
    const clock = sheet.statusClocks[name];
    if (sheet.status[name] !== true || !record(clock) || integer(clock.remaining) === null) continue;
    if (clock.awaitingStart === true) {
      if (event.phase === 'start' && ownerMatches(clock, event) && claim(event, 'status', name, 'arm')) {clock.awaitingStart = false; changed = true;}
      continue;
    }
    if (!matches(clock, event) || !claim(event, 'status', name, 'tick')) continue;
    clock.remaining = Math.max(0, integer(clock.remaining) - 1);
    if (clock.remaining === 0) {sheet.status[name] = false; delete sheet.statusClocks[name];}
    changed = true;
  }
  for (const [index, entry] of (Array.isArray(sheet.effects) ? sheet.effects.slice(0, 128) : []).entries()) {
    const data = record(entry) && entry.data;
    if (!record(data) || data.active !== true || integer(data.remaining) === null || !matches(data, event) || !claim(event, 'effects', index, 'tick')) continue;
    data.remaining = Math.max(0, integer(data.remaining) - 1); if (data.remaining === 0) data.active = false;
    changed = true;
  }
  if (event.phase === 'end' && event.isCurrent === true) for (const [index, entry] of (Array.isArray(sheet.activePowers) ? sheet.activePowers.slice(0, 128) : []).entries()) {
    if (!record(entry) || entry.active !== true || [null, 0].includes(integer(entry.durationRounds)) || integer(entry.remainingRounds) === null || !claim(event, 'activePowers', index, 'tick')) continue;
    entry.remainingRounds = Math.max(0, integer(entry.remainingRounds) - 1); if (entry.remainingRounds === 0) entry.active = false;
    changed = true;
  }
  return {sheet, changed};
}

/** Use after the card tracker has selected the actual first actor for a round. */
export function beginTurn(sheet, event) {return advanceClocks(sheet, {...event, phase: 'start'}).sheet;}

/** Freeze the exact forward-turn phases before issuing a native combat command.
 * Backward navigation and manual selection never undo or repeat resolved clocks.
 */
export function combatClockPhases(state, method) {
  if (!['nextTurn', 'nextRound'].includes(method) || !state?.active || !state.combatants?.length) return [];
  const entries = state.combatants.slice(0, 64), previous = entries[state.turn];
  if (!previous) return [];
  let next = state.turn, boundary = method === 'nextRound';
  const skipped = [];
  if (method === 'nextRound') {skipped.push(...entries.slice(state.turn + 1)); next = 0;}
  else {
    if (entries.every(entry => entry.defeated)) return [];
    for (let count = 0; count < entries.length; count++) {
      next++;
      if (next >= entries.length) {next = 0; boundary = true;}
      if (!entries[next].defeated) break;
      skipped.push(entries[next]);
    }
  }
  const phase = (name, entry, roundBoundary = false) => ({phase: name, entry, roundBoundary});
  return [phase('end', previous, boundary),
    ...skipped.flatMap(entry => [phase('start', entry), phase('end', entry)]),
    phase('start', entries[next], boundary)];
}
