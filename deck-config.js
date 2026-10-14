import { cloneData } from './model.js';
import { parseCard } from './initiative.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => Object.assign(new Error(code), { code });

/** Only instances projected by the native API are eligible. No deck is created here. */
export function validateDeckChoice(state, deckId) {
  if (state?.isGM !== true) throw failure('permission_denied');
  if (typeof deckId !== 'string' || !deckId.trim()) throw failure('deck-required');
  if (!Array.isArray(state.decks)) throw failure('invalid-deck-response');
  const found = state.decks.find(deck => deck?.id === deckId.trim());
  if (!found) throw failure('deck-not-found');
  if (typeof found.name !== 'string' || !found.name.trim()) throw failure('invalid-deck-response');
  return { id: found.id, name: found.name };
}

export function deckChoices(state) {
  if (state?.isGM !== true || !Array.isArray(state.decks)) return [];
  return state.decks.filter(deck => typeof deck?.id === 'string' && deck.id && typeof deck.name === 'string' && deck.name.trim())
    .map(deck => ({ id: deck.id, name: deck.name }));
}

function nativeImage(url, expected) {
  if (url === null || url === undefined || url === '') return null;
  if (typeof url !== 'string' || url !== expected) throw failure('invalid-card-image');
  return url;
}

/** Interpret a drawn authorized card. A user mapping may supply values, never identity or artwork. */
export function nativeCardFacts(card, { deckId, mapping, requireFace = false } = {}) {
  if (!record(card) || typeof card.id !== 'string' || !card.id || typeof card.deck_instance_id !== 'string' || !card.deck_instance_id
      || typeof card.name !== 'string' || !card.name) throw failure('invalid-card-response');
  if (deckId !== undefined && card.deck_instance_id !== deckId) throw failure('card-deck-mismatch');
  if (mapping !== undefined && !Array.isArray(mapping)) throw failure('invalid-card-mapping');
  const matches = (mapping ?? []).filter(entry => record(entry) && entry.name === card.name);
  if (matches.length > 1) throw failure('card-name-ambiguous');
  const values = matches[0];
  let parsed;
  try {
    // Native card_data has no rank/suit properties. Ignore unexpected injected
    // values; the name or the user's explicit mapping supplies those mechanics.
    const input = { name: card.name };
    if (values) {
      if (values.joker !== undefined) {
        if (typeof values.joker === 'boolean' || ![1, 2].includes(Number(values.joker))) throw new TypeError('Invalid Joker');
        input.joker = Number(values.joker);
      } else {
        const rank = Number(values.rank);
        if (typeof values.rank === 'boolean' || !Number.isInteger(rank) || rank < 2 || rank > 14 || values.suit === undefined) throw new TypeError('Invalid card values');
        input.rank = rank; input.suit = values.suit;
      }
    }
    parsed = parseCard(input);
  } catch { throw failure('card-values-required'); }
  const frontUrl = nativeImage(card.frontUrl, `/game/cards/card/${card.id}/front`);
  const backUrl = nativeImage(card.backUrl, `/game/cards/deck/${card.deck_instance_id}/back`);
  if (requireFace && !frontUrl) throw failure('card-face-required');
  return { ...cloneData(card), deckId: card.deck_instance_id, rank: parsed.rank ?? null, suit: parsed.suit ?? '', joker: parsed.joker ?? 0,
    score: parsed.score, frontUrl, backUrl };
}

/** A GM hand is private; other members can display fronts only after native publication. */
export function nativeFaceUrl(card, { isGM = false, ownHand = false } = {}) {
  if (!record(card)) return null;
  const deckId = card.deck_instance_id ?? card.deckId;
  const frontUrl = nativeImage(card.frontUrl, `/game/cards/card/${card.id}/front`);
  const backUrl = nativeImage(card.backUrl, `/game/cards/deck/${deckId}/back`);
  const publicFace = typeof card.sceneId === 'string' && !!card.sceneId && card.face_state === 'face_up';
  return (isGM === true || ownHand === true || publicFace ? frontUrl : null) || backUrl;
}
