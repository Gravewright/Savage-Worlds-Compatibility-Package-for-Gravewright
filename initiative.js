/** Original generic playing-card labels and numeric order; no copyrighted artwork. */
export const SUITS = Object.freeze([
  Object.freeze({ id: 'clubs', symbol: '♣', value: 1 }), Object.freeze({ id: 'diamonds', symbol: '♦', value: 2 }),
  Object.freeze({ id: 'hearts', symbol: '♥', value: 3 }), Object.freeze({ id: 'spades', symbol: '♠', value: 4 }),
]);
const face = rank => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] ?? String(rank);

export function cardScore(card) {
  if (card?.joker === 1 || card?.joker === 2) return 59 + card.joker;
  const suit = SUITS.find(value => value.id === card?.suit || value.symbol === card?.suit || value.value === card?.suit);
  const rank = Number(card?.rank);
  if (!suit || !Number.isInteger(rank) || rank < 2 || rank > 14) throw new TypeError('Invalid playing card');
  // Subtract two from rank so A♠ cannot collide with reserved Joker60/61.
  return (rank - 2) * 4 + suit.value;
}

export function cardFromScore(value) {
  const score = Number(value);
  if (score === 60 || score === 61) return { joker: score - 59, score };
  if (!Number.isInteger(score) || score < 1 || score > 52) return null;
  return { rank: Math.floor((score - 1) / 4) + 2, suit: SUITS[(score - 1) % 4].id, score };
}

export function cardDisplay(card) {
  if (!card) return '—';
  if (card.joker) return `★ ${card.joker}`;
  const suit = SUITS.find(value => value.id === card.suit);
  return suit ? `${face(card.rank)} ${suit.symbol}` : '—';
}

export function parseCard(card) {
  if (card?.joker || card?.rank) return { ...card, score: cardScore(card) };
  const name = String(card?.name ?? card ?? '').trim();
  const joker = /^★\s*([12])$/.exec(name);
  const normal = /^(2|3|4|5|6|7|8|9|10|J|Q|K|A)\s*([♣♦♥♠])$/.exec(name);
  if (!joker && !normal) throw new TypeError('Card does not belong to the generic action deck');
  const parsed = joker ? { joker: Number(joker[1]) } : { rank: ({ J: 11, Q: 12, K: 13, A: 14 })[normal[1]] ?? Number(normal[1]),
    suit: SUITS.find(value => value.symbol === normal[2]).id };
  return { ...(card && typeof card === 'object' ? card : {}), ...parsed, score: cardScore(parsed) };
}

export function initiativeConfig(sheet) {
  const source = sheet?.profile?.initiative ?? {};
  const incapacitated = sheet?.status?.incapacitated === true;
  return { draw: incapacitated ? 1 : Math.min(10, Math.max(1, Math.floor(Number(source.draw) || 1))),
    keep: incapacitated || source.keep !== 'lowest' ? 'highest' : 'lowest',
    redrawBelow: incapacitated ? 0 : Math.min(15, Math.max(0, Math.floor(Number(source.redrawBelow) || 0))),
    holding: sheet?.status?.holding === true && !sheet?.status?.shaken && !sheet?.status?.stunned && !incapacitated,
    groupId: String(source.groupId ?? '') };
}

/** Hesitant always keeps a Joker; Quick redraws never apply to Benny cards. */
export function selectCard(cards, keep = 'highest') {
  const parsed = cards.map(parseCard);
  if (!parsed.length) return null;
  const jokers = parsed.filter(card => card.joker);
  return [...(jokers.length ? jokers : parsed)].sort((a, b) => keep === 'lowest' && !jokers.length ? a.score - b.score : b.score - a.score)[0];
}

export function mustRedraw(card, config) {
  const value = parseCard(card);
  return !value.joker && config.keep !== 'lowest' && config.redrawBelow > 0 && value.rank < config.redrawBelow;
}

/** Group members share one draw; the first member supplies explicit group configuration. */
export function groupCombatants(combatants, sheets = new Map()) {
  const groups = new Map();
  for (const combatant of combatants) {
    if (combatant.defeated) continue;
    const sheet = sheets instanceof Map ? sheets.get(combatant.id) : sheets[combatant.id];
    const config = initiativeConfig(sheet);
    const key = config.groupId ? `group:${config.groupId}` : `combatant:${combatant.id}`;
    if (!groups.has(key)) groups.set(key, { id: key, config, combatants: [] });
    groups.get(key).combatants.push(combatant);
  }
  return [...groups.values()];
}
