import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, cardScore, cardFromScore, cardDisplay, initiativeConfig, selectCard, mustRedraw, groupCombatants } from '../initiative.js';

test('authorized native card labels round trip through noncolliding initiative ranks without creating a deck', () => {
  const cards = [{name: '2 ♣', score: 1}, {name: '7 ♥', score: 23}, {name: 'A ♠', score: 52}, {name: '★ 1', score: 60}, {name: '★ 2', score: 61}];
  for (const card of cards) {
    assert.equal(parseCard(card).score, card.score);
    assert.equal(cardDisplay(cardFromScore(card.score)), card.name);
  }
  assert.equal(cardScore({ rank: 14, suit: 'spades' }), 52);
  assert.equal(cardFromScore(60).joker, 1); assert.equal(cardFromScore(61).joker, 2);
  assert.equal(cardFromScore(53), null); assert.equal(cardFromScore(null), null);
});

test('rank and suit order is spades, hearts, diamonds, clubs, with Jokers above Aces', () => {
  assert.equal(selectCard(['A ♣', 'K ♠']).name, undefined);
  assert.equal(selectCard(['A ♣', 'K ♠']).score, cardScore({ rank: 14, suit: 'clubs' }));
  assert.equal(selectCard(['7 ♣', '7 ♥', '7 ♦', '7 ♠']).suit, 'spades');
  assert.equal(selectCard(['A ♠', '★ 1']).joker, 1);
});

test('lowest-card configuration retains Joker exception and Quick redraws only low ranks', () => {
  assert.equal(selectCard(['K ♠', '2 ♥'], 'lowest').rank, 2);
  assert.equal(selectCard(['★ 1', '2 ♣'], 'lowest').joker, 1);
  const config = initiativeConfig({ profile: { initiative: { draw: 2, redrawBelow: 6 } } });
  assert.equal(config.draw, 2); assert.equal(mustRedraw('5 ♠', config), true);
  assert.equal(mustRedraw('6 ♣', config), false); assert.equal(mustRedraw('★ 1', config), false);
  assert.equal(mustRedraw('2 ♣', { ...config, keep: 'lowest' }), false);
});

test('incapacitation ignores draw advantages and holding is cancelled by Shaken or Stunned', () => {
  const profile = { initiative: { draw: 3, keep: 'lowest', redrawBelow: 6 } };
  assert.deepEqual(initiativeConfig({ profile, status: { incapacitated: true, holding: true } }),
    { draw: 1, keep: 'highest', redrawBelow: 0, holding: false, groupId: '' });
  assert.equal(initiativeConfig({ status: { holding: true } }).holding, true);
  assert.equal(initiativeConfig({ status: { holding: true, stunned: true } }).holding, false);
});

test('manual groups share one draw and defeated combatants receive none', () => {
  const combatants = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', defeated: true }];
  const sheets = new Map([['a', { profile: { initiative: { groupId: 'user-group' } } }], ['b', { profile: { initiative: { groupId: 'user-group' } } }]]);
  const grouped = groupCombatants(combatants, sheets);
  assert.equal(grouped.length, 2); assert.deepEqual(grouped[0].combatants.map(value => value.id), ['a', 'b']);
  assert.equal(grouped[1].combatants[0].id, 'c');
});
