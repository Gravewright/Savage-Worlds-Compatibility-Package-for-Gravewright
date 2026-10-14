/** Package-owned mechanical interpretation of the host's native dice facts. */
const dice = [4, 6, 8, 10, 12];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const signed = value => value ? `${value > 0 ? '+' : ''}${value}` : '';

export function nativeResult(message) {
  const result = message?.roll?.result ?? message?.message?.roll?.result ?? message?.result ?? message;
  if (result?.schema !== 'gravewright-dice-result' || result.value?.kind !== 'number' || !Number.isFinite(result.value.value))
    throw new TypeError('A numeric native dice result is required.');
  return result;
}

export function rollOutcome(total, {target = 4, critical = false, opposed = false} = {}) {
  total = finite(total); target = finite(target, 4);
  const success = !critical && (opposed ? total >= 4 && total > target : total >= target);
  return {total, target, critical, success, raises: success ? Math.max(0, Math.floor((total - target) / 4)) : 0};
}

export function traitExpression({die = 4, modifier = 0, wild = true, wildDie = 6, count = 1} = {}) {
  if (!dice.includes(Number(die)) || !dice.includes(Number(wildDie)) || !Number.isInteger(count) || count < 1 || count > 6)
    throw new RangeError('Choose standard trait dice and one to six trait dice.');
  const terms = Array.from({length: count}, () => `1d${die}!`);
  if (wild) terms.push(`1d${wildDie}!`);
  // One trait uses max directly; multiple dice are assigned after reading facts.
  return (terms.length === 1 ? terms[0] : count === 1 ? `max(${terms.join(',')})` : terms.join('+')) + signed(finite(modifier));
}

function termValue(roll) {
  return roll.facts.filter(fact => roll.selection[fact.id] === 'active').reduce((sum, fact) => sum + fact.face, 0);
}
function initial(roll) {return roll.facts.find(fact => fact.cause?.kind === 'initial' || fact.cause === 'initial')?.face ?? roll.facts[0]?.face;}

export function interpretTrait(message, {wild = true, count = 1, modifier = 0, target = 4, opposed = false, confirmation} = {}) {
  const result = nativeResult(message), rolls = result.rolls;
  if (!Array.isArray(rolls) || rolls.length !== count + (wild ? 1 : 0)) throw new TypeError('The trait dice do not match the native result.');
  const traits = rolls.slice(0, count), wildRoll = wild ? rolls[count] : null;
  const ones = traits.filter(roll => initial(roll) === 1).length;
  const wildOne = wild && initial(wildRoll) === 1;
  // The majority includes every rolled die. Wild Cards also require a Wild 1;
  // Extras confirm a single natural 1, but a multi-die majority is critical.
  const potentialCritical = wild ? ones + Number(wildOne) > rolls.length / 2 : ones > count / 2;
  const critical = potentialCritical && (wild ? wildOne : count > 1 || confirmation === 1);
  const values = traits.map(roll => ({total: termValue(roll), naturalOne: initial(roll) === 1}));
  if (wildRoll) values.push({total: termValue(wildRoll), naturalOne: initial(wildRoll) === 1});
  values.sort((a, b) => b.total - a.total);
  const hits = values.slice(0, count).map(value => {
    const outcome = rollOutcome(value.total + finite(modifier), {target, opposed, critical});
    // An Extra's natural 1 is a failure even if its confirmation is not critical.
    return !wild && value.naturalOne ? {...outcome, success: false, raises: 0, automaticFailure: true} : outcome;
  });
  return {...hits[0], hits, needsConfirmation: !wild && count === 1 && potentialCritical && confirmation === undefined,
    initialFaces: rolls.map(initial), diceTotals: rolls.map(termValue)};
}

export function keepReroll(previous, next) {
  if (previous?.critical) throw new Error('A critical failure cannot be rerolled.');
  if (!previous || next.critical) return next;
  // Keep one complete result, never combine separate dice from different rolls.
  return next.total > previous.total ? next : previous;
}

export function actionModifiers({actions = 1, free = false, running = false, distracted = false, joker = false,
  vulnerable = false, drop = false, wildAttack = false, range = 0, cover = 0, illumination = 0,
  gangUp = 0, calledShot = 0, recoil = false, unstable = false, aim = 0, situational = 0} = {}) {
  const multiAction = free ? 0 : -2 * (Math.max(1, Math.min(3, Math.trunc(finite(actions, 1)))) - 1);
  return multiAction + (running ? -2 : 0) + (distracted ? -2 : 0) + (joker ? 2 : 0)
    + Math.max(vulnerable ? 2 : 0, drop ? 4 : 0) + (wildAttack ? 2 : 0)
    + finite(range) + finite(cover) + finite(illumination) + Math.min(4, Math.max(0, finite(gangUp)))
    + finite(calledShot) + (recoil ? -2 : 0) + (unstable ? -2 : 0) + finite(aim) + finite(situational);
}

export function damageExpression(expression, {strength, raise = false, bonus = 0, minimumStrength, weaponType} = {}) {
  let value = String(expression || '').trim();
  if (!value || value.length > 350) throw new TypeError('A damage expression is required.');
  if (strength) {
    let die = Number(strength.die), mod = finite(strength.modifier);
    const fixed = strength.fixedValue === 1;
    if (!fixed && !dice.includes(die)) throw new RangeError('Invalid Strength die.');
    const strengthToken = /\b(?:str|strength|for|força)\b/i.test(value);
    // Melee and thrown weapon dice are capped by Strength even when a template
    // has no minimum field. A firearm's fixed damage never uses that cap.
    if (!fixed && (strengthToken || ['melee', 'thrown'].includes(weaponType))) value = value.replace(/(\d*)d(\d+)(!?)/g,
      (match, count, sides, explode) => Number(sides) > die ? `${count}d${die}${explode}` : match);
    if (strengthToken) value = value.replace(/\b(?:str|strength|for|força)\b/gi, `(${fixed ? '1' : `1d${die}!`}${signed(mod)})`);
  }
  // Templates contain a user-authored sum of dice and numbers, never executable JS.
  if (!/^[\d\s()+\-*.d!]+$/.test(value)) throw new TypeError('Use a sum of dice and numbers for damage.');
  value = value.replace(/(\d*)d(\d+)(!?)/g, (match, count, sides, explode) => {
    if (!dice.includes(Number(sides)) || (count && (Number(count) < 1 || Number(count) > 20))) throw new RangeError('Invalid damage dice.');
    return `${count || 1}d${sides}${explode || '!'}`;
  });
  return `${value}${raise ? '+1d6!' : ''}${signed(finite(bonus))}`;
}

/** Retry the same published roll after transport failure, without rerolling. */
export function nativeRollWorkflow(api, expression, payload, options = {}) {
  const requestId = globalThis.crypto.randomUUID();
  const input = structuredClone(payload), settings = {...options};
  if (typeof input.label === 'string') input.label = input.label.slice(0, 48);
  let message, pending;
  return {run() {
    if (pending) return pending;
    pending = (async () => {
      message ??= await api.dice.roll(expression, structuredClone(input), {...settings, requestId});
      return message;
    })().finally(() => {pending = undefined;});
    return pending;
  }};
}
