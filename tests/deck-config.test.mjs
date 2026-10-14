import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeckChoice, deckChoices, nativeCardFacts, nativeFaceUrl } from '../deck-config.js';

const state = () => ({ isGM: true, decks: [{ id: 'native-deck', name: 'User native deck', draw_count: 54, discard_count: 0, version: 1 }] });
const card = values => ({ id: 'native-card', deck_instance_id: 'native-deck', name: 'K ♠',
  frontUrl: '/game/cards/card/native-card/front', backUrl: '/game/cards/deck/native-deck/back',
  face_state: 'face_up', sceneId: null, version: 3, ...values });

test('the GM must explicitly select an existing authorized native instance', () => {
  const input = state(), before = structuredClone(input);
  assert.throws(() => validateDeckChoice(input, ''), { code: 'deck-required' });
  assert.throws(() => validateDeckChoice(input, 'a-deck-from-another-table'), { code: 'deck-not-found' });
  assert.deepEqual(validateDeckChoice(input, 'native-deck'), { id: 'native-deck', name: 'User native deck' });
  assert.deepEqual(deckChoices(input), [{ id: 'native-deck', name: 'User native deck' }]);
  assert.deepEqual(input, before);
});

test('a player cannot turn a readable deck into permission to configure combat', () => {
  const input = { ...state(), isGM: false };
  assert.throws(() => validateDeckChoice(input, 'native-deck'), { code: 'permission_denied' });
  assert.deepEqual(deckChoices(input), []);
});

test('native draw facts retain actual card identity and art instead of generating a replacement face', () => {
  const input = card(), before = structuredClone(input);
  const result = nativeCardFacts(input, { deckId: 'native-deck', requireFace: true });
  assert.equal(result.id, input.id); assert.equal(result.version, 3); assert.equal(result.rank, 13); assert.equal(result.suit, 'spades');
  assert.equal(result.frontUrl, input.frontUrl); assert.equal(result.backUrl, input.backUrl);
  assert.equal(result.score, 48); assert.deepEqual(input, before);
});

test('user mappings support artwork titles while identity, URLs and versions stay native', () => {
  const input = card({ name: 'User artwork title' });
  const mapping = [{ name: input.name, rank: 9, suit: 'hearts', id: 'foreign-card', frontUrl: 'https://external.example/front.png', version: 99 }];
  const result = nativeCardFacts(input, { mapping });
  assert.equal(result.rank, 9); assert.equal(result.suit, 'hearts');
  assert.equal(result.id, 'native-card'); assert.equal(result.frontUrl, input.frontUrl); assert.equal(result.version, 3);
  assert.equal(nativeCardFacts(card({ name: 'User Joker art' }), { mapping: [{ name: 'User Joker art', joker: '2' }] }).joker, 2);
});

test('missing or ambiguous values, the wrong instance and missing required artwork reject before scoring', () => {
  assert.throws(() => nativeCardFacts(card(), { deckId: 'another-deck' }), { code: 'card-deck-mismatch' });
  assert.throws(() => nativeCardFacts(card({ name: 'Unconfigured artwork', rank: 14, suit: 'spades' })), { code: 'card-values-required' });
  assert.throws(() => nativeCardFacts(card(), { mapping: [{ name: 'K ♠', rank: 13, suit: 'spades' }, { name: 'K ♠', rank: 2, suit: 'clubs' }] }), { code: 'card-name-ambiguous' });
  assert.throws(() => nativeCardFacts(card({ frontUrl: null }), { requireFace: true }), { code: 'card-face-required' });
  assert.throws(() => nativeCardFacts(card(), { mapping: [{ name: 'K ♠', joker: 3 }] }), { code: 'card-values-required' });
  for (const values of [{ rank: 0, suit: 'clubs' }, { suit: 'clubs' }, { rank: 13 }, { rank: true, suit: 'clubs' }])
    assert.throws(() => nativeCardFacts(card(), { mapping: [{ name: 'K ♠', ...values }] }), { code: 'card-values-required' });
});

test('a private GM card shows its back to other members until it is genuinely face up in a native scene', () => {
  const input = nativeCardFacts(card());
  assert.equal(nativeFaceUrl(input, { isGM: true }), input.frontUrl);
  assert.equal(nativeFaceUrl(input, { ownHand: true }), input.frontUrl);
  assert.equal(nativeFaceUrl(input), input.backUrl);
  assert.equal(nativeFaceUrl({ ...input, sceneId: 'native-scene' }), input.frontUrl);
  assert.equal(nativeFaceUrl({ ...input, sceneId: 'native-scene', face_state: 'face_down' }), input.backUrl);
});

test('configured metadata cannot replace native image URLs with remote or different card resources', () => {
  assert.throws(() => nativeCardFacts(card({ frontUrl: 'https://external.example/front.png' })), { code: 'invalid-card-image' });
  assert.throws(() => nativeCardFacts(card({ frontUrl: '/game/cards/card/different-card/front' })), { code: 'invalid-card-image' });
  assert.throws(() => nativeFaceUrl(card({ backUrl: '/game/cards/deck/different-deck/back' })), { code: 'invalid-card-image' });
});
