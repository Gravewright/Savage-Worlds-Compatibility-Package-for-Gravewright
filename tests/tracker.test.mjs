import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackerController } from '../tracker.js';
import { advanceClocks } from '../clocks.js';

const copy = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
function store() {
  const values = new Map();
  return { values, async get(key) { return copy(values.get(key) ?? null); },
    async set(key, value, { expectedRevision }) {
      const previous = values.get(key);
      if ((previous?.revision ?? null) !== expectedRevision) throw fail('conflict');
      const result = { value: copy(value), revision: (previous?.revision ?? 0) + 1 }; values.set(key, result); return copy(result);
    }, async delete(key, { expectedRevision }) {
      if (values.get(key)?.revision !== expectedRevision) throw fail('conflict'); values.delete(key);
    } };
}
function fixture({ names = ['A ♠', '★ 1'], isGM = true, lostDraw = false, lostAward = false, lostClock = false, lostTransition = false,
  existingDeck = true, selectedDeck = true, active = true, deckCount = 12, cardImages = true, settings } = {}) {
  const storage = { table: store(), user: store() }, receipts = new Map(), count = { drawn: 0, create: 0, award: 0, reset: 0, transition: 0, start: 0, nextTurn: 0, previousTurn: 0, setTurn: 0, actorSaves: 0 };
  const actors = new Map(['a', 'b'].map(id => [id, { id, actorType: 'character', name: id, version: 1, sheetVersion: 1, canEdit: true,
    data: { profile: { role: 'player', kind: 'wild-card', initiative: {} }, status: {}, resources: { bennies: 3 } } }]));
  const encounter = { sceneId: 'scene', encounterId: 'encounter', version: 1, active, round: active ? 1 : 0, turn: 0,
    combatants: ['a', 'b'].map(id => ({ id, actor_id: id, token_id: null, name: id, canControl: true, initiative: null })) };
  let deck = existingDeck ? {id: 'deck', name: 'User configured native deck', version: 1, draw_count: deckCount, discard_count: 0} : null;
  let queue = [...names], hand = [], nextId = 0, drawLost = lostDraw, awardLost = lostAward, clockLost = lostClock, transitionLost = lostTransition;
  if (selectedDeck) storage.table.values.set('initiative.scene.scene', {revision: 1, value: {
    schemaVersion: 1, deckId: 'deck', deckName: 'User configured native deck', deckConfigured: true, encounterId: '', round: 0, needsShuffle: true, phase: 'ready', gmBennies: 0, operation: null,
  }});
  const current = () => copy({ ...encounter, combatants: encounter.combatants.map((entry, index) => ({ ...entry, current: encounter.active && index === encounter.turn })) });
  const receipt = async (options, task) => {
    if (receipts.has(options.requestId)) return copy(receipts.get(options.requestId));
    const result = task(); receipts.set(options.requestId, copy(result)); return result;
  };
  const api = { actors: {
    async list() { return [...actors.values()].map(value => ({ id: value.id })); },
    async sheet(id) { return copy(actors.get(id)); },
    async saveSheet(payload) {
      const actor = actors.get(payload.actorId); if (actor.version !== payload.version || actor.sheetVersion !== payload.sheetVersion) throw fail('conflict');
      const before = actor.data.resources.bennies;
      const wasAwaiting = actor.data.statusClocks?.distracted?.awaitingStart;
      actor.data = copy(payload.data); actor.version++; actor.sheetVersion++;
      count.actorSaves++;
      if (actor.data.resources.bennies > before) { count.award++; if (awardLost) { awardLost = false; throw fail('unavailable'); } }
      if (wasAwaiting && actor.data.statusClocks?.distracted?.awaitingStart === false && clockLost) { clockLost = false; throw fail('unavailable'); }
      return { version: actor.version, sheetVersion: actor.sheetVersion };
    },
  }, cards: {
    async state() { return { isGM, decks: deck ? [copy(deck)] : [], hand: isGM ? copy(hand) : [], cards: [] }; },
    async create() { count.create++; throw Error('The package must never create an Action Card deck'); },
    async shuffle(payload, options) { return receipt(options, () => { if (payload.version !== deck.version) throw fail('conflict'); deck.version++; return {}; }); },
    async reset(payload, options) { return receipt(options, () => { count.reset++; deck.version++; deck.draw_count = deckCount; queue = [...names]; hand = []; return {}; }); },
    async draw(payload, options) {
      const result = await receipt(options, () => {
        if (!deck || deck.draw_count < 1) throw fail('invalid_data');
        count.drawn++; deck.draw_count--; deck.version++;
        const card = {id: `card-${++nextId}`, deck_instance_id: deck.id, name: queue.shift() ?? '7 ♣', version: 1, face_state: 'face_up', frontUrl: cardImages ? `/game/cards/card/card-${nextId}/front` : null};
        hand.push(card); return {cards: [copy(card)]};
      });
      if (drawLost) { drawLost = false; throw fail('unavailable'); } return result;
    },
  }, combat: {
    async state() { return current(); },
    async setInitiative(payload, options) { return receipt(options, () => {
      if (payload.version !== encounter.version) throw fail('conflict');
      const entry = encounter.combatants.find(value => value.id === (payload.actorId ?? payload.tokenId)); entry.initiative = payload.value;
      encounter.combatants.sort((a, b) => b.initiative - a.initiative); encounter.version++; return {};
    }); },
    async setTurn(payload, options) { return receipt(options, () => { count.setTurn++; encounter.turn = encounter.combatants.findIndex(value => value.id === (payload.actorId ?? payload.tokenId)); encounter.version++; return {}; }); },
    async nextTurn(payload, options) { return receipt(options, () => {
      if (payload.version !== encounter.version) throw fail('conflict');
      count.nextTurn++;
      const previous = encounter.combatants[encounter.turn], actor = actors.get(previous.actor_id);
      const clocks = advanceClocks(actor.data, {phase: 'end', isCurrent: true, actorId: previous.actor_id, tokenId: null,
        roundBoundary: encounter.turn === encounter.combatants.length - 1, documentKey: ['actor', actor.id], clockKeys: new Set()});
      if (clocks.changed) {actor.data = clocks.sheet; actor.version++; actor.sheetVersion++;}
      encounter.turn++; if (encounter.turn >= encounter.combatants.length) {encounter.turn = 0; encounter.round++;}
      encounter.version++; return current();
    }); },
    async previousTurn(payload, options) { return receipt(options, () => {
      if (payload.version !== encounter.version) throw fail('conflict'); count.previousTurn++;
      encounter.turn = Math.max(0, encounter.turn - 1); encounter.version++; return current();
    }); },
    async nextRound(payload, options) {
      const result = await receipt(options, () => { count.transition++; encounter.round++; encounter.turn = 0; encounter.version++; return {}; });
      if (transitionLost) { transitionLost = false; throw fail('unavailable'); } return result;
    },
    async start(payload, options) { return receipt(options, () => {
      count.start++; encounter.active = true; encounter.encounterId = `started-${count.start}`; encounter.round = 1; encounter.turn = 0; encounter.version++; return current();
    }); },
    async stop() { encounter.active = false; encounter.round = 0; encounter.version++; return {}; },
  } };
  return { api, storage, count, actors, encounter, failNextDraw() { drawLost = true; }, removeDeck() {deck = null;},
    enableCardImages() {cardImages = true;},
    controller: () => createTrackerController({ api, storage, sceneId: 'scene', settings }) };
}

function tableSettings({instanceId = 'deck', jokersWild = true} = {}) {
  return {current: {deck: {instanceId, themeId: '', name: 'Chosen in table settings'}, rules: {jokersWild}}};
}

test('deal publishes native card scores, awards each player once, keeps private faces out of table storage, and skips repeated round reads', async () => {
  const f = fixture(), controller = f.controller(); await controller.dealRound();
  assert.equal(f.count.create, 0); assert.equal(f.count.drawn, 2); assert.equal(f.count.award, 2);
  assert.equal(f.actors.get('a').data.resources.bennies, 4); assert.equal(f.actors.get('b').data.resources.bennies, 4);
  assert.equal(f.encounter.combatants[0].initiative, 60);
  const view = await controller.refresh(); assert.equal(view.tracker.phase, 'ready'); assert.equal(view.tracker.needsShuffle, true);
  assert.doesNotMatch(JSON.stringify([...f.storage.table.values.values()]), /★|A ♠|frontUrl|\/game\/cards\/card/);
  await f.controller().dealRound(); assert.equal(f.count.drawn, 2); assert.equal(f.count.award, 2);
  await controller.beginRound(); assert.equal((await controller.refresh()).tracker.phase, 'playing');
});

test('a lost native draw response survives a new controller and reuses exactly the same request instead of drawing twice', async () => {
  const f = fixture({ lostDraw: true });
  await assert.rejects(f.controller().dealRound(), { code: 'unavailable' });
  assert.equal(f.count.drawn, 1);
  await f.controller().dealRound(); assert.equal(f.count.drawn, 2); assert.equal(f.count.create, 0); assert.equal(f.count.reset, 1);
});

test('a lost actor award response reconciles the marker in current actor data without incrementing Bennies twice', async () => {
  const f = fixture({ lostAward: true });
  await assert.rejects(f.controller().dealRound(), { code: 'unavailable' });
  await f.controller().dealRound();
  assert.equal(f.count.award, 2); assert.equal(f.actors.get('a').data.resources.bennies, 4);
  assert.equal(f.actors.get('b').data.resources.bennies, 4); assert.equal(f.count.drawn, 2);
});

test('the configured native deck prepares once and a drawn Joker resets it next round; stopping clears stale Joker bonuses', async () => {
  const f = fixture(), controller = f.controller(); await controller.dealRound(); await controller.nextRound();
  assert.equal(f.count.reset, 2); assert.equal(f.count.drawn, 4);
  await controller.stop();
  assert.equal(f.actors.get('b').data.combat.joker, false); assert.equal((await controller.refresh()).tracker.round, 0);
});

test('player reading and another GM cannot take over a pending private operation or write native scores', async () => {
  const player = fixture({ isGM: false });
  await assert.rejects(player.controller().dealRound(), { code: 'permission_denied' }); assert.equal(player.count.create, 0);
  const f = fixture({ lostDraw: true }); await assert.rejects(f.controller().dealRound());
  const otherGM = createTrackerController({ api: f.api, storage: { table: f.storage.table, user: store() }, sceneId: 'scene' });
  await assert.rejects(otherGM.dealRound(), { code: 'operation-busy' }); assert.equal(f.count.drawn, 1);
});

test('starting a card round arms the NEW first actor and advances source start effects exactly once, even after a lost response', async () => {
  const f = fixture({ lostClock: true }), controller = f.controller();
  for (const actor of f.actors.values()) {
    actor.data.status.distracted = true;
    actor.data.statusClocks = { distracted: { remaining: 1, phase: 'end', owner: 'self', awaitingStart: true } };
    actor.data.effects = [{ data: { active: true, phase: 'start', owner: 'self', remaining: 2 } }];
  }
  f.actors.get('a').data.effects.push({ data: { active: true, phase: 'start', owner: 'source', sourceActorId: 'b', remaining: 2 } });
  await controller.dealRound();
  await assert.rejects(controller.beginRound(), { code: 'unavailable' });
  await f.controller().beginRound();
  assert.equal(f.actors.get('a').data.statusClocks.distracted.awaitingStart, true);
  assert.equal(f.actors.get('b').data.statusClocks.distracted.awaitingStart, false);
  assert.equal(f.actors.get('a').data.effects[0].data.remaining, 2);
  assert.equal(f.actors.get('a').data.effects[1].data.remaining, 1);
  assert.equal(f.actors.get('b').data.effects[0].data.remaining, 1);
  await f.controller().beginRound();
  assert.equal(f.actors.get('b').data.effects[0].data.remaining, 1);
});

test('a Benny card ignores draw penalties, may improve initiative and award a new Joker, and is forbidden after the round begins', async () => {
  const f = fixture({ names: ['A ♠', 'Q ♥', '★ 1'] }), controller = f.controller();
  f.actors.get('b').data.profile.initiative = { draw: 1, keep: 'lowest', redrawBelow: 0 };
  await controller.dealRound();
  const entry = (await controller.refresh()).state.combatants.find(value => value.id === 'b');
  await controller.bennyCard(entry);
  assert.equal(f.count.drawn, 3); assert.equal(f.actors.get('b').data.resources.bennies, 3);
  assert.equal(f.actors.get('a').data.resources.bennies, 4); assert.equal(f.actors.get('b').data.combat.joker, true);
  await controller.beginRound(); assert.equal(f.encounter.combatants[f.encounter.turn].id, 'b');
  await assert.rejects(controller.bennyCard(entry), { code: 'round-already-started' });
});

test('grouped allies share one draw and holding receives no fresh card', async () => {
  const grouped = fixture({ names: ['7 ♠'] });
  for (const actor of grouped.actors.values()) actor.data.profile.initiative.groupId = 'custom-group';
  await grouped.controller().dealRound(); assert.equal(grouped.count.drawn, 1);
  assert.equal(grouped.encounter.combatants[0].initiative, grouped.encounter.combatants[1].initiative);
  const held = fixture({ names: ['8 ♥'] }); held.actors.get('a').data.status.holding = true;
  await held.controller().dealRound(); assert.equal(held.count.drawn, 1);
  assert.equal(held.encounter.combatants.find(entry => entry.id === 'a').initiative, 0);
});

test('zero Bennies reject before a pending operation is created', async () => {
  const f = fixture({ names: ['A ♠', 'Q ♥'] }), controller = f.controller(); await controller.dealRound();
  const entry = (await controller.refresh()).state.combatants.find(value => value.id === 'b');
  f.actors.get('b').data.resources.bennies = 0;
  await assert.rejects(controller.bennyCard(entry), { code: 'insufficient-bennies' });
  assert.equal((await controller.refresh()).tracker.operation, null); assert.equal(f.count.drawn, 2);
});

test('retry after a lost native round-transition response advances the round once, then deals normally', async () => {
  const f = fixture({ names: ['A ♠', 'K ♥'], lostTransition: true }); await f.controller().dealRound();
  await assert.rejects(f.controller().nextRound(), { code: 'unavailable' });
  await f.controller().nextRound();
  assert.equal(f.encounter.round, 2); assert.equal(f.count.transition, 1); assert.equal(f.count.drawn, 4);
});

test('retry after a draw failure during nextRound resumes setup instead of advancing yet another round', async () => {
  const f = fixture({ names: ['A ♠', 'K ♥'] }); await f.controller().dealRound(); f.failNextDraw();
  await assert.rejects(f.controller().nextRound(), { code: 'unavailable' });
  await f.controller().nextRound();
  assert.equal(f.encounter.round, 2); assert.equal(f.count.transition, 1); assert.equal(f.count.drawn, 4);
});

test('an explicit enemy Joker awards the GM reserve and enemy Wild Cards instead of player characters', async () => {
  const f = fixture(); f.actors.get('b').data.profile.role = 'enemy'; await f.controller().dealRound();
  assert.equal(f.actors.get('a').data.resources.bennies, 3);
  assert.equal(f.actors.get('b').data.resources.bennies, 4);
  assert.equal((await f.controller().refresh()).tracker.gmBennies, 1);
});

function npcEntry(f, id = 'a') {
  const actor = f.actors.get(id); actor.actorType = 'npc'; actor.data.profile.kind = 'extra'; actor.data.profile.role = 'enemy'; actor.data.resources.bennies = 0;
  return copy(f.encounter.combatants.find(entry => entry.actor_id === id));
}
function loseTableReceipt(f, stage) {
  const write = f.storage.table.set; let lost = false;
  f.storage.table.set = async (key, value, options) => {
    const result = await write(key, value, options);
    if (!lost && value.gmBennyReceipts?.at(-1)?.stage === stage) { lost = true; throw fail('unavailable'); }
    return result;
  };
}

test('GM reserve adjusts manually, preserves Joker awards and rejects empty or fractional changes before creating an operation', async () => {
  const f = fixture(); f.actors.get('b').data.profile.role = 'enemy';
  const controller = f.controller(); await controller.adjustGMBennies(3); await controller.dealRound();
  assert.equal((await controller.refresh()).tracker.gmBennies, 4);
  await controller.adjustGMBennies(-1); assert.equal((await controller.refresh()).tracker.gmBennies, 3);
  await assert.rejects(controller.adjustGMBennies(-4), {code: 'insufficient-gm-bennies'});
  await assert.rejects(controller.adjustGMBennies(0.5), {code: 'invalid-benny-count'});
  assert.equal((await controller.refresh()).tracker.operation, null);
});

test('GM reserve grants one usable Benny to an NPC without touching other resources or granting to player characters', async () => {
  const f = fixture(), entry = npcEntry(f), controller = f.controller();
  f.actors.get('a').data.resources.wounds = 2;
  await controller.adjustGMBennies(2); await controller.spendGMBenny(entry);
  assert.equal((await controller.refresh()).tracker.gmBennies, 1);
  assert.equal(f.actors.get('a').data.resources.bennies, 1);
  assert.equal(f.actors.get('a').data.resources.wounds, 2);
  assert.equal(f.actors.get('a').data.combat.trackerOperations.length, 1);
  await assert.rejects(controller.spendGMBenny(entry), {code: 'benny-already-available'});
  f.actors.get('b').data.resources.bennies = 0;
  await assert.rejects(controller.spendGMBenny(f.encounter.combatants.find(value => value.id === 'b')), {code: 'not-npc'});
  assert.equal((await controller.refresh()).tracker.gmBennies, 1);
});

test('players and actor edit-denied targets never create a GM reserve operation or credit', async () => {
  const player = fixture({isGM: false}), entry = npcEntry(player);
  await assert.rejects(player.controller().adjustGMBennies(1), {code: 'permission_denied'});
  await assert.rejects(player.controller().spendGMBenny(entry), {code: 'permission_denied'});
  assert.equal(player.storage.table.values.size, 1); assert.equal(player.storage.user.values.size, 0);
  const f = fixture(), denied = npcEntry(f), controller = f.controller(); await controller.adjustGMBennies(1);
  f.actors.get('a').canEdit = false;
  await assert.rejects(controller.spendGMBenny(denied), {code: 'permission_denied'});
  assert.equal((await controller.refresh()).tracker.gmBennies, 1);
  assert.equal((await controller.refresh()).tracker.operation, null);
  assert.equal(f.actors.get('a').data.resources.bennies, 0);
});

test('lost NPC credit response reconciles its exact version marker after controller recreation without another debit or credit', async () => {
  const f = fixture({lostAward: true}), entry = npcEntry(f), controller = f.controller();
  await controller.adjustGMBennies(2);
  await assert.rejects(controller.spendGMBenny(entry), {code: 'unavailable'});
  assert.equal((await controller.refresh()).tracker.gmBennies, 1);
  assert.equal(f.actors.get('a').data.resources.bennies, 1);
  await assert.rejects(controller.stop(), {code: 'operation-busy'});
  await f.controller().spendGMBenny(entry);
  assert.equal(f.count.award, 1); assert.equal(f.actors.get('a').data.resources.bennies, 1);
  assert.equal((await f.controller().refresh()).tracker.gmBennies, 1);
  assert.equal((await f.controller().refresh()).tracker.operation, null);
});

test('lost funded and completed table responses preserve a single GM grant through a new controller', async () => {
  for (const stage of ['funded', 'done']) {
    const f = fixture(), entry = npcEntry(f), controller = f.controller(); await controller.adjustGMBennies(2);
    loseTableReceipt(f, stage);
    await assert.rejects(controller.spendGMBenny(entry), {code: 'unavailable'});
    await f.controller().spendGMBenny(entry);
    const view = await f.controller().refresh();
    assert.equal(view.tracker.gmBennies, 1); assert.equal(view.tracker.operation, null);
    assert.equal(f.actors.get('a').data.resources.bennies, 1); assert.equal(f.count.award, 1);
    assert.equal(view.tracker.gmBennyReceipts.filter(receipt => receipt.kind === 'gm-benny-grant').length, 1);
  }
});

test('lost manual reserve adjustment response retries once while a subsequent deliberate adjustment gets a new receipt', async () => {
  const f = fixture(); loseTableReceipt(f, 'done');
  await assert.rejects(f.controller().adjustGMBennies(3), {code: 'unavailable'});
  await f.controller().adjustGMBennies(3);
  assert.equal((await f.controller().refresh()).tracker.gmBennies, 3);
  await f.controller().adjustGMBennies(3);
  assert.equal((await f.controller().refresh()).tracker.gmBennies, 6);
});

test('a lost private GM journal response resumes the same grant and another target cannot consume its pending debit', async () => {
  const f = fixture(), entry = npcEntry(f), other = npcEntry(f, 'b');
  await f.controller().adjustGMBennies(2);
  const write = f.storage.user.set; let lost = false;
  f.storage.user.set = async (key, value, options) => {
    const result = await write(key, value, options);
    if (!lost && key.endsWith('.gm-benny.pending')) { lost = true; throw fail('unavailable'); }
    return result;
  };
  await assert.rejects(f.controller().spendGMBenny(entry), {code: 'unavailable'});
  assert.equal((await f.controller().refresh()).tracker.gmBennies, 2);
  await assert.rejects(f.controller().spendGMBenny(other), {code: 'operation-busy'});
  await f.controller().spendGMBenny(entry);
  assert.equal((await f.controller().refresh()).tracker.gmBennies, 1);
  assert.equal(f.actors.get('a').data.resources.bennies, 1);
  assert.equal(f.actors.get('b').data.resources.bennies, 0);
  assert.equal(f.count.award, 1);
});

test('pause and resume preserve the exact cards, turn, round, resources and ready/playing phase', async () => {
  for (const phase of ['ready', 'playing']) {
    const f = fixture(), controller = f.controller(); await controller.dealRound();
    if (phase === 'playing') await controller.beginRound();
    f.encounter.turn = 1;
    f.actors.get('a').data.effects = [{data: {active: true, remaining: 3, phase: 'end', owner: 'self'}}];
    const before = {encounter: copy(f.encounter), actors: copy([...f.actors]), count: copy(f.count), tracker: copy((await controller.refresh()).tracker)};
    const paused = await controller.pause(); assert.equal(paused.paused, true); assert.equal(paused.tracker.phase, phase);
    assert.equal(paused.tracker.pausedEncounterId, f.encounter.encounterId);
    const resumed = await f.controller().resume(); assert.equal(resumed.paused, false); assert.equal(resumed.tracker.phase, phase);
    assert.deepEqual(f.encounter, before.encounter); assert.deepEqual([...f.actors], before.actors); assert.deepEqual(f.count, before.count);
    const {paused: _paused, pausedEncounterId: _id, ...rest} = resumed.tracker;
    const {paused: _previousPaused, pausedEncounterId: _previousId, ...previous} = before.tracker;
    assert.deepEqual(rest, previous);
  }
});

test('an old encounter pause cannot pause a replacement or inactive native encounter', async () => {
  const f = fixture(), controller = f.controller(); await controller.dealRound(); await controller.pause();
  f.encounter.encounterId = 'replacement-encounter';
  let snapshot = await controller.refresh(); assert.equal(snapshot.paused, false); assert.equal(snapshot.tracker.paused, true);
  // A direct, authorized turn selection must not be rejected by the stale flag.
  let nativeCommands = 0;
  f.api.combat.setTurn = async payload => {nativeCommands++; f.encounter.turn = f.encounter.combatants.findIndex(entry => entry.id === payload.actorId);};
  await controller.command('setTurn', {actorId: 'a'}); assert.equal(nativeCommands, 1);
  f.encounter.encounterId = 'encounter'; f.encounter.active = false;
  snapshot = await controller.refresh(); assert.equal(snapshot.paused, false);
  await assert.rejects(controller.pause(), {code: 'combat-not-started'});
  await assert.rejects(controller.resume(), {code: 'combat-not-started'});
});

test('both GM and player controllers block paused turn, round, card and holding changes before writes', async () => {
  const f = fixture(), gm = f.controller(); await gm.dealRound(); await gm.pause();
  const playerApi = {...f.api, cards: {...f.api.cards, state: async () => ({...await f.api.cards.state(), isGM: false})}};
  const player = createTrackerController({api: playerApi, storage: {table: f.storage.table, user: store()}, sceneId: 'scene'});
  const before = {encounter: copy(f.encounter), actors: copy([...f.actors]), count: copy(f.count), public: copy([...f.storage.table.values])};
  const entry = f.encounter.combatants[0];
  for (const controller of [gm, player]) {
    for (const task of [controller.next, controller.previous, controller.nextRound, controller.previousRound, controller.dealRound,
      () => controller.bennyCard(entry), () => controller.hold(entry, true), () => controller.hold(entry, false), () => controller.command('setTurn', {actorId: entry.actor_id})]) {
      await assert.rejects(task(), {code: 'combat-paused'});
    }
    await assert.rejects(controller.beginRound(), {code: controller === player ? 'permission_denied' : 'combat-paused'});
  }
  await assert.rejects(player.pause(), {code: 'permission_denied'}); await assert.rejects(player.resume(), {code: 'permission_denied'});
  assert.deepEqual(f.encounter, before.encounter); assert.deepEqual([...f.actors], before.actors);
  assert.deepEqual(f.count, before.count); assert.deepEqual([...f.storage.table.values], before.public);
});

test('a partial durable operation rejects pause and resume without replacing its recovery state', async () => {
  const f = fixture({lostDraw: true}), controller = f.controller(); await assert.rejects(controller.dealRound(), {code: 'unavailable'});
  const before = copy([...f.storage.table.values]);
  await assert.rejects(controller.pause(), {code: 'operation-busy'}); await assert.rejects(f.controller().resume(), {code: 'operation-busy'});
  assert.deepEqual([...f.storage.table.values], before); assert.equal(f.count.drawn, 1);
  await f.controller().dealRound(); assert.equal(f.count.drawn, 2);
});

test('a lost table response retries the same explicit pause/resume intent after controller recreation', async () => {
  for (const method of ['pause', 'resume']) {
    const f = fixture(), controller = f.controller(); await controller.dealRound();
    if (method === 'resume') await controller.pause();
    const before = {encounter: copy(f.encounter), actors: copy([...f.actors]), count: copy(f.count)};
    const set = f.storage.table.set, attempts = []; let lost = false;
    f.storage.table.set = async (key, value, options) => {
      attempts.push({value: copy(value), expectedRevision: options.expectedRevision});
      const result = await set(key, value, options);
      if (!lost) {lost = true; throw fail('unavailable');} return result;
    };
    await assert.rejects(controller[method](), {code: 'unavailable'});
    const committed = await f.storage.table.get('initiative.scene.scene');
    assert.equal(committed.value.paused, method === 'pause');
    const retried = await f.controller()[method]();
    assert.equal(retried.paused, method === 'pause'); assert.deepEqual(attempts[0].value, attempts[1].value);
    assert.notEqual(attempts[0].expectedRevision, attempts[1].expectedRevision);
    assert.deepEqual(f.encounter, before.encounter); assert.deepEqual([...f.actors], before.actors); assert.deepEqual(f.count, before.count);
  }
});

test('pause CAS rebases only its flag and preserves another GM reserve update', async () => {
  const f = fixture(), controller = f.controller(); await controller.dealRound();
  const set = f.storage.table.set; let conflict = true;
  f.storage.table.set = async (key, value, options) => {
    if (conflict && value.paused === true) {
      conflict = false; const latest = await f.storage.table.get(key);
      await set(key, {...latest.value, gmBennies: 7}, {expectedRevision: latest.revision}); throw fail('conflict');
    }
    return set(key, value, options);
  };
  const snapshot = await controller.pause(); assert.equal(snapshot.paused, true); assert.equal(snapshot.tracker.gmBennies, 7);
});

test('a remote pause reaches a stale client through public synchronization without touching native combat', async () => {
  const f = fixture(), gm = f.controller(); await gm.dealRound();
  const remote = f.controller(); await remote.refresh(); assert.equal(remote.snapshot().paused, false);
  await gm.pause(); assert.equal(remote.snapshot().paused, false);
  const before = copy(f.encounter); let nativeReads = 0;
  const read = f.api.combat.state; f.api.combat.state = async () => {nativeReads++; return read();};
  assert.equal((await remote.syncPublic()).paused, true); assert.equal(nativeReads, 0); assert.deepEqual(f.encounter, before);
  await gm.resume(); assert.equal((await remote.syncPublic()).paused, false);
});

test('a pause during Hold/Release sheet loading prevents both the status save and turn movement', async () => {
  for (const holding of [true, false]) {
    const f = fixture(), controller = f.controller(); await controller.dealRound();
    const entry = {...f.encounter.combatants[0], current: true};
    f.actors.get(entry.actor_id).data.status.holding = !holding;
    const before = {encounter: copy(f.encounter), actors: copy([...f.actors])};
    let entered, release, first = true;
    const enteredRead = new Promise(resolve => {entered = resolve;}), continueRead = new Promise(resolve => {release = resolve;});
    const sheet = f.api.actors.sheet;
    f.api.actors.sheet = async (...args) => {if (first) {first = false; entered(); await continueRead;} return sheet(...args);};
    const hold = controller.hold(entry, holding); await enteredRead;
    await f.controller().pause(); release();
    await assert.rejects(hold, {code: 'combat-paused'});
    assert.deepEqual(f.encounter, before.encounter); assert.deepEqual([...f.actors], before.actors);
    const snapshot = await controller.refresh(); assert.equal(snapshot.paused, true); assert.equal(snapshot.tracker.operation, null);
  }
});

test('pause arriving after the initial guard is rechecked inside the operation CAS', async () => {
  const f = fixture(), controller = f.controller(); await controller.dealRound();
  const entry = {...f.encounter.combatants[0], current: true}, before = copy([...f.actors]);
  let entered, release, first = true;
  const enteredOwner = new Promise(resolve => {entered = resolve;}), continueOwner = new Promise(resolve => {release = resolve;});
  const get = f.storage.user.get;
  f.storage.user.get = async key => {if (first && key === 'initiative.owner') {first = false; entered(); await continueOwner;} return get(key);};
  // A fresh controller forces the owner lookup between its running guard and CAS.
  const hold = f.controller().hold(entry, true); await enteredOwner;
  await f.controller().pause(); release();
  await assert.rejects(hold, {code: 'combat-paused'}); assert.deepEqual([...f.actors], before);
  const snapshot = await controller.refresh(); assert.equal(snapshot.paused, true); assert.equal(snapshot.tracker.operation, null);
});

test('a reserved Hold/Release operation blocks another GM pause until its native writes finish', async () => {
  const f = fixture(), controller = f.controller(); await controller.dealRound();
  const entry = {...f.encounter.combatants[0], current: true}; f.actors.get(entry.actor_id).data.status.holding = true;
  let entered, release, first = true;
  const enteredSave = new Promise(resolve => {entered = resolve;}), continueSave = new Promise(resolve => {release = resolve;});
  const save = f.api.actors.saveSheet;
  f.api.actors.saveSheet = async payload => {if (first) {first = false; entered(); await continueSave;} return save(payload);};
  const hold = controller.hold(entry, false); await enteredSave;
  await assert.rejects(f.controller().pause(), {code: 'operation-busy'}); release(); await hold;
  assert.equal(f.actors.get(entry.actor_id).data.status.holding, false);
  assert.equal((await f.controller().pause()).paused, true);
});

test('an inactive GM selects an existing native deck and persists its identity without creating cards', async () => {
  const f = fixture({active: false, selectedDeck: false}), controller = f.controller();
  const before = copy(f.encounter); const selected = await controller.selectDeck('deck');
  assert.equal(selected.tracker.deckId, 'deck'); assert.equal(selected.tracker.deckName, 'User configured native deck');
  assert.equal(selected.tracker.deckConfigured, true);
  assert.equal(selected.tracker.needsShuffle, true); assert.deepEqual(f.encounter, before);
  assert.equal(f.count.create, 0); assert.equal(f.count.drawn, 0); assert.equal(f.storage.user.values.size, 0);
  assert.equal((await f.controller().refresh()).tracker.deckId, 'deck');
});

test('deck selection rejects missing, foreign and player choices and is locked throughout active combat', async () => {
  const gm = fixture({active: false, selectedDeck: false}), controller = gm.controller();
  await assert.rejects(controller.selectDeck(''), {code: 'deck-required'});
  await assert.rejects(controller.selectDeck('another-table-deck'), {code: 'deck-not-found'});
  assert.equal(gm.storage.table.values.size, 0); assert.equal(gm.count.create, 0);
  const player = fixture({active: false, selectedDeck: false, isGM: false});
  await assert.rejects(player.controller().selectDeck('deck'), {code: 'permission_denied'});
  assert.equal(player.storage.table.values.size, 0);
  const active = fixture(), before = copy([...active.storage.table.values]);
  await assert.rejects(active.controller().selectDeck('deck'), {code: 'deck-locked'});
  await active.controller().pause();
  const paused = copy([...active.storage.table.values]);
  await assert.rejects(active.controller().selectDeck('deck'), {code: 'deck-locked'});
  assert.deepEqual([...active.storage.table.values], paused); assert.equal(active.count.create, 0);
  assert.equal(before[0][1].value.deckId, 'deck');
});

test('a selected native deck is required before the first native combat start', async () => {
  const f = fixture({active: false, selectedDeck: false}), controller = f.controller(), before = copy(f.encounter);
  await assert.rejects(controller.start(), {code: 'deck-required'});
  assert.deepEqual(f.encounter, before); assert.equal(f.count.start, 0); assert.equal(f.count.create, 0); assert.equal(f.storage.table.values.size, 0);
  await controller.selectDeck('deck'); await controller.start();
  assert.equal(f.count.start, 1); assert.equal(f.encounter.active, true); assert.equal(f.count.create, 0);
  assert.equal(f.count.drawn, 2); assert.equal(f.count.reset, 1);
});

test('a legacy auto-generated deck ID does not count as explicit native deck configuration', async () => {
  const f = fixture({active: false}), controller = f.controller();
  delete f.storage.table.values.get('initiative.scene.scene').value.deckConfigured;
  const before = copy([...f.storage.table.values]);
  await assert.rejects(controller.start(), {code: 'deck-required'});
  assert.equal(f.count.start, 0); assert.equal(f.count.create, 0); assert.deepEqual([...f.storage.table.values], before);
  await controller.selectDeck('deck'); assert.equal((await controller.refresh()).tracker.deckConfigured, true);
  await controller.start(); assert.equal(f.count.start, 1); assert.equal(f.count.create, 0);
});

test('a deleted selected native deck is never recreated or replaced by another available deck', async () => {
  const f = fixture({active: false}), controller = f.controller(); f.removeDeck();
  f.api.cards.state = async () => ({isGM: true, decks: [{id: 'other-native-deck', name: 'Another user deck', version: 1, draw_count: 10, discard_count: 0}], hand: [], cards: []});
  const before = {encounter: copy(f.encounter), actors: copy([...f.actors]), selected: copy([...f.storage.table.values])};
  await assert.rejects(controller.start(), {code: 'deck-not-found'});
  assert.deepEqual(f.encounter, before.encounter); assert.deepEqual([...f.actors], before.actors); assert.deepEqual([...f.storage.table.values], before.selected);
  assert.equal(f.count.start, 0); assert.equal(f.count.create, 0); assert.equal(f.count.drawn, 0);
  f.encounter.active = true; f.encounter.round = 1;
  const active = copy(f.encounter); await assert.rejects(controller.dealRound(), {code: 'deck-not-found'});
  assert.deepEqual(f.encounter, active); assert.equal(f.count.create, 0);
  assert.equal((await controller.refresh()).tracker.deckId, 'deck');
});

test('selecting a native deck after a lost storage response repeats the explicit selection without generating cards', async () => {
  const f = fixture({active: false, selectedDeck: false}), set = f.storage.table.set; let lost = false; const attempts = [];
  f.storage.table.set = async (key, value, options) => {
    attempts.push(copy(value)); const result = await set(key, value, options);
    if (!lost) {lost = true; throw fail('unavailable');} return result;
  };
  await assert.rejects(f.controller().selectDeck('deck'), {code: 'unavailable'});
  const selected = await f.controller().selectDeck('deck');
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(selected.tracker.deckId, 'deck'); assert.equal(selected.tracker.needsShuffle, true);
  assert.equal(f.count.create, 0); assert.equal(f.count.reset, 0); assert.equal(f.count.drawn, 0);
});

test('empty, malformed or imageless native Action Cards report explicit errors without initiative or actor mutations', async () => {
  for (const [configuration, code] of [[{deckCount: 0}, 'deck-empty'], [{names: ['User authored non-action label']}, 'invalid-action-card'], [{cardImages: false}, 'invalid-action-card']]) {
    const f = fixture(configuration), before = {encounter: copy(f.encounter), actors: copy([...f.actors])};
    await assert.rejects(f.controller().dealRound(), {code});
    assert.deepEqual(f.encounter, before.encounter); assert.deepEqual([...f.actors], before.actors); assert.equal(f.count.create, 0);
    assert.equal(f.count.award, 0);
  }
});

test('authorized native face previews stay outside shared table storage', async () => {
  const f = fixture(), controller = f.controller(); await controller.dealRound();
  const view = await controller.refresh();
  assert.match(JSON.stringify(view.cardFaces), /\/game\/cards\/card/);
  assert.doesNotMatch(JSON.stringify([...f.storage.table.values]), /frontUrl|\/game\/cards\/card/);
  const playerApi = {...f.api, cards: {...f.api.cards, state: async () => ({isGM: false, decks: (await f.api.cards.state()).decks, hand: [], cards: []})}};
  const player = createTrackerController({api: playerApi, storage: {table: f.storage.table, user: store()}, sceneId: 'scene'});
  assert.doesNotMatch(JSON.stringify((await player.refresh()).cardFaces), /\/game\/cards\/card/);
});

test('a table default appears for GM and player without creating decks or writing scene preferences', async () => {
  for (const isGM of [true, false]) {
    const f = fixture({active: false, selectedDeck: false, isGM, settings: tableSettings()}), controller = f.controller();
    const view = await controller.refresh();
    assert.equal(view.deck.id, 'deck'); assert.equal(view.tracker.deckSource, 'table'); assert.equal(view.tracker.deckConfigured, true);
    assert.equal(view.tracker.deckName, 'User configured native deck');
    assert.equal(f.storage.table.values.size, 0); assert.equal(f.storage.user.values.size, 0);
    assert.equal(f.count.create, 0); assert.equal(f.count.drawn, 0);
  }
});

test('Start pins the table default before native combat starts and preserves it throughout the active encounter', async () => {
  const settings = tableSettings(), f = fixture({active: false, selectedDeck: false, settings}), controller = f.controller();
  const nativeStart = f.api.combat.start;
  f.api.combat.start = async (...args) => {
    const record = await f.storage.table.get('initiative.scene.scene');
    assert.equal(record.value.deckSource, 'table'); assert.equal(record.value.deckId, 'deck'); assert.equal(record.value.deckConfigured, true);
    return nativeStart(...args);
  };
  await controller.start(); assert.equal(f.count.start, 1); assert.equal(f.count.drawn, 2); assert.equal(f.count.create, 0);
  settings.current.deck.instanceId = 'another-table-choice';
  assert.equal((await f.controller().refresh()).deck.id, 'deck');
  await controller.nextRound(); assert.equal(f.count.drawn, 4); assert.equal((await controller.refresh()).tracker.deckId, 'deck');
  await controller.stop();
  const released = await f.storage.table.get('initiative.scene.scene');
  assert.equal(released.value.deckConfigured, false); assert.equal(released.value.deckId, '');
  assert.equal((await controller.refresh()).deck, null);
  await assert.rejects(controller.start(), {code: 'deck-not-found'});
  assert.equal(f.count.start, 1); assert.equal(f.count.create, 0);
});

test('an explicit scene choice overrides the table default and remains selected after Stop', async () => {
  const settings = tableSettings({instanceId: 'removed-table-default'}), f = fixture({active: false, selectedDeck: false, settings}), controller = f.controller();
  assert.equal((await controller.refresh()).deck, null);
  await controller.selectDeck('deck'); await controller.start();
  settings.current.deck.instanceId = '';
  assert.equal((await controller.refresh()).tracker.deckSource, 'scene');
  await controller.stop(); assert.equal((await controller.refresh()).deck.id, 'deck');
  assert.equal((await f.storage.table.get('initiative.scene.scene')).value.deckConfigured, true);
  assert.equal(f.count.create, 0);
});

test('an already started native encounter pins its inherited deck before the first deal', async () => {
  const settings = tableSettings(), f = fixture({active: true, selectedDeck: false, settings}), controller = f.controller();
  await controller.dealRound();
  const record = await f.storage.table.get('initiative.scene.scene');
  assert.equal(record.value.deckId, 'deck'); assert.equal(record.value.deckSource, 'table');
  settings.current.deck.instanceId = 'removed-default';
  assert.equal((await f.controller().refresh()).deck.id, 'deck');
  assert.equal(f.count.create, 0); assert.equal(f.count.start, 0); assert.equal(f.count.drawn, 2);
});

test('invalid or removed table defaults and player starts reject before writes or native mutations', async () => {
  for (const [configuration, code] of [
    [{settings: tableSettings({instanceId: 'foreign-deck'})}, 'deck-not-found'],
    [{existingDeck: false, settings: tableSettings()}, 'deck-not-found'],
    [{settings: tableSettings({instanceId: ''})}, 'deck-required'],
    [{isGM: false, settings: tableSettings()}, 'permission_denied'],
  ]) {
    const f = fixture({active: false, selectedDeck: false, ...configuration});
    await assert.rejects(f.controller().start(), {code});
    assert.equal(f.storage.table.values.size, 0); assert.equal(f.storage.user.values.size, 0);
    assert.equal(f.count.start, 0); assert.equal(f.count.create, 0); assert.equal(f.count.drawn, 0);
  }
});

test('a lost default-pin response is recovered before Start without generating or duplicating cards', async () => {
  const f = fixture({active: false, selectedDeck: false, settings: tableSettings()}), set = f.storage.table.set;
  let lost = false;
  f.storage.table.set = async (...args) => {
    const result = await set(...args);
    if (!lost) {lost = true; throw fail('unavailable');} return result;
  };
  await assert.rejects(f.controller().start(), {code: 'unavailable'}); assert.equal(f.count.start, 0);
  await f.controller().start(); assert.equal(f.count.start, 1); assert.equal(f.count.drawn, 2); assert.equal(f.count.create, 0);
});

test('a concurrent explicit scene choice is preserved when inheriting the table default loses its CAS', async () => {
  const f = fixture({active: false, selectedDeck: false, settings: tableSettings()}), set = f.storage.table.set;
  let changed = false;
  f.storage.table.set = async (key, value, options) => {
    if (!changed) {
      changed = true;
      await set(key, {...value, deckId: 'other-scene-deck', deckName: 'Other scene choice', deckSource: 'scene'}, options);
      throw fail('conflict');
    }
    return set(key, value, options);
  };
  await assert.rejects(f.controller().start(), {code: 'conflict'});
  assert.equal((await f.storage.table.get('initiative.scene.scene')).value.deckId, 'other-scene-deck');
  assert.equal(f.count.start, 0); assert.equal(f.count.drawn, 0); assert.equal(f.count.create, 0);
});

test('a concurrent explicit choice of the same default deck retains scene ownership after CAS recovery', async () => {
  const f = fixture({active: false, selectedDeck: false, settings: tableSettings()}), set = f.storage.table.set;
  let changed = false;
  f.storage.table.set = async (key, value, options) => {
    if (!changed) {changed = true; await set(key, {...value, deckSource: 'scene'}, options); throw fail('conflict');}
    return set(key, value, options);
  };
  const controller = f.controller(); await controller.start(); await controller.stop();
  const record = await f.storage.table.get('initiative.scene.scene');
  assert.equal(record.value.deckSource, 'scene'); assert.equal(record.value.deckConfigured, true); assert.equal(record.value.deckId, 'deck');
});

test('disabling Jokers Wild skips all automatic actor and GM awards but keeps Joker bonuses and reshuffling', async () => {
  for (const enemy of [false, true]) {
    const f = fixture({settings: tableSettings({jokersWild: false})}), controller = f.controller();
    if (enemy) f.actors.get('b').data.profile.role = 'enemy';
    await controller.dealRound();
    assert.equal(f.count.award, 0); assert.equal(f.actors.get('a').data.resources.bennies, 3); assert.equal(f.actors.get('b').data.resources.bennies, 3);
    assert.equal(f.actors.get('b').data.combat.joker, true);
    const view = await controller.refresh(); assert.equal(view.tracker.needsShuffle, true); assert.equal(view.tracker.gmBennies, 0);
    await controller.adjustGMBennies(2); assert.equal((await controller.refresh()).tracker.gmBennies, 2);
    await controller.nextRound(); assert.equal(f.count.reset, 2); assert.equal(f.count.award, 0);
  }
});

test('a fresh Benny Joker keeps the card bonus and shuffle flag while disabled awards stay disabled', async () => {
  const f = fixture({names: ['A ♠', 'K ♥', '★ 1'], settings: tableSettings({jokersWild: false})}), controller = f.controller();
  f.actors.get('b').data.profile.role = 'enemy';
  await controller.dealRound();
  const entry = (await controller.refresh()).state.combatants.find(value => value.id === 'b');
  await controller.bennyCard(entry);
  assert.equal(f.actors.get('b').data.resources.bennies, 2); assert.equal(f.actors.get('b').data.combat.joker, true); assert.equal(f.count.award, 0);
  const view = await controller.refresh(); assert.equal(view.tracker.needsShuffle, true); assert.equal(view.tracker.gmBennies, 0);
});

test('deal recovery freezes the award policy before a lost draw, while the next operation reads the updated policy', async () => {
  for (const enabled of [true, false]) {
    const settings = tableSettings({jokersWild: enabled}), f = fixture({lostDraw: true, settings});
    await assert.rejects(f.controller().dealRound(), {code: 'unavailable'});
    const operation = (await f.storage.table.get('initiative.scene.scene')).value.operation;
    assert.equal((await f.storage.user.get(`initiative.scene.scene.operation.${operation.id}`)).value.jokersWild, enabled);
    settings.current.rules.jokersWild = !enabled;
    await f.controller().dealRound();
    assert.equal(f.count.drawn, 2); assert.equal(f.count.award, enabled ? 2 : 0);
    assert.equal(f.actors.get('b').data.combat.joker, true);
    await f.controller().nextRound();
    assert.equal(f.count.drawn, 4); assert.equal(f.count.award, 2);
  }
});

test('a lost actor-award response is reconciled under its frozen policy after settings disable awards', async () => {
  const settings = tableSettings(), f = fixture({lostAward: true, settings});
  await assert.rejects(f.controller().dealRound(), {code: 'unavailable'});
  settings.current.rules.jokersWild = false;
  await f.controller().dealRound();
  assert.equal(f.count.drawn, 2); assert.equal(f.count.award, 2);
  assert.equal(f.actors.get('a').data.resources.bennies, 4); assert.equal(f.actors.get('b').data.resources.bennies, 4);
});

test('a committed private-policy write survives its lost response without changing the resumed award policy', async () => {
  const settings = tableSettings({jokersWild: false}), f = fixture({settings}), set = f.storage.user.set;
  let lost = false;
  f.storage.user.set = async (key, value, options) => {
    const result = await set(key, value, options);
    if (!lost && key.includes('.operation.') && value.jokersWild === false) {lost = true; throw fail('unavailable');}
    return result;
  };
  await assert.rejects(f.controller().dealRound(), {code: 'unavailable'}); assert.equal(f.count.drawn, 0);
  settings.current.rules.jokersWild = true;
  await f.controller().dealRound(); assert.equal(f.count.drawn, 2); assert.equal(f.count.award, 0);
});

test('Benny draw recovery freezes both enabled and disabled award policies across controller recreation', async () => {
  for (const enabled of [true, false]) {
    const settings = tableSettings({jokersWild: enabled}), f = fixture({names: ['A ♠', 'K ♥', '★ 1'], settings}), controller = f.controller();
    await controller.dealRound();
    const entry = (await controller.refresh()).state.combatants.find(value => value.id === 'b'); f.failNextDraw();
    await assert.rejects(controller.bennyCard(entry), {code: 'unavailable'});
    settings.current.rules.jokersWild = !enabled;
    await f.controller().bennyCard(entry);
    assert.equal(f.count.drawn, 3); assert.equal(f.count.award, enabled ? 2 : 0);
    assert.equal(f.actors.get('b').data.resources.bennies, enabled ? 3 : 2);
    assert.equal(f.actors.get('b').data.combat.joker, true);
  }
});

function loseFinalCheckpoint(f, accepts) {
  const set = f.storage.table.set; let lost = false;
  f.storage.table.set = async (key, value, options) => {
    const result = await set(key, value, options);
    if (!lost && value.operation === null && value.completedOperations?.some(accepts)) {lost = true; throw fail('unavailable');}
    return result;
  };
}

test('lost final next/previous checkpoint retries the completed intent without moving the turn or ticking clocks twice', async () => {
  for (const [method, kind, counter] of [['next', 'transition-nextTurn', 'nextTurn'], ['previous', 'transition-previousTurn', 'previousTurn']]) {
    const f = fixture({names: ['A ♠', 'K ♥']}), controller = f.controller(); await controller.dealRound(); await controller.beginRound();
    if (method === 'previous') f.encounter.turn = 1;
    for (const actor of f.actors.values()) actor.data.effects = [{data: {active: true, remaining: 3, phase: 'end', owner: 'self'}}];
    const originalCurrent = f.encounter.combatants[f.encounter.turn].actor_id;
    loseFinalCheckpoint(f, receipt => receipt.kind === kind);
    await assert.rejects(controller[method](), {code: 'unavailable'});
    const committed = {encounter: copy(f.encounter), actors: copy([...f.actors])}; assert.equal(f.count[counter], 1);
    await f.controller()[method]();
    assert.equal(f.count[counter], 1); assert.deepEqual(f.encounter, committed.encounter); assert.deepEqual([...f.actors], committed.actors);
    assert.equal(f.actors.get(originalCurrent).data.effects[0].data.remaining, method === 'next' ? 2 : 3);
    assert.equal(await f.storage.user.get('initiative.scene.scene.intent.pending'), null);
    await f.controller()[method](); assert.equal(f.count[counter], 2);
    const receipts = (await f.controller().refresh()).tracker.completedOperations.filter(receipt => receipt.kind === kind);
    assert.equal(receipts.length, 2); assert.notEqual(receipts[0].id, receipts[1].id);
  }
});

test('completed round transition survives lost finish and a later failed deal without advancing a third round', async () => {
  const f = fixture({names: ['A ♠', 'K ♥']}), controller = f.controller(); await controller.dealRound();
  loseFinalCheckpoint(f, receipt => receipt.kind === 'transition-nextRound');
  await assert.rejects(controller.nextRound(), {code: 'unavailable'}); assert.equal(f.encounter.round, 2); assert.equal(f.count.transition, 1);
  f.failNextDraw(); await assert.rejects(f.controller().nextRound(), {code: 'unavailable'});
  assert.equal((await f.controller().refresh()).tracker.operation.kind, 'deal');
  await f.controller().nextRound();
  assert.equal(f.encounter.round, 2); assert.equal(f.count.transition, 1); assert.equal(f.count.drawn, 4);
  assert.equal(await f.storage.user.get('initiative.scene.scene.intent.pending'), null);
  await f.controller().beginRound(); await f.controller().nextRound();
  assert.equal(f.encounter.round, 3); assert.equal(f.count.transition, 2);
});

test('lost final Benny checkpoint is recovered before zero-balance and round-phase guards, and cannot be claimed by another target', async () => {
  const f = fixture({names: ['A ♠', 'K ♥', '2 ♣']}), controller = f.controller(); await controller.dealRound();
  const entry = (await controller.refresh()).state.combatants.find(value => value.id === 'b'), other = f.encounter.combatants.find(value => value.id === 'a');
  f.actors.get('b').data.resources.bennies = 1;
  loseFinalCheckpoint(f, receipt => receipt.kind.startsWith('benny-'));
  await assert.rejects(controller.bennyCard(entry), {code: 'unavailable'});
  assert.equal(f.actors.get('b').data.resources.bennies, 0); assert.equal(f.count.drawn, 3);
  const committed = copy([...f.actors]);
  await assert.rejects(f.controller().bennyCard(other), {code: 'operation-busy'}); assert.deepEqual([...f.actors], committed);
  await f.controller().beginRound(); const afterRoundStart = copy([...f.actors]);
  await f.controller().bennyCard(entry);
  assert.equal(f.count.drawn, 3); assert.deepEqual([...f.actors], afterRoundStart); assert.equal(f.actors.get('b').data.resources.bennies, 0);
});

test('a deliberate Benny draw after confirmed recovery spends a new Benny exactly once', async () => {
  const f = fixture({names: ['A ♠', 'K ♥', '2 ♣', '3 ♣']}), controller = f.controller(); await controller.dealRound();
  const entry = (await controller.refresh()).state.combatants.find(value => value.id === 'b');
  loseFinalCheckpoint(f, receipt => receipt.kind.startsWith('benny-'));
  await assert.rejects(controller.bennyCard(entry), {code: 'unavailable'}); await f.controller().bennyCard(entry);
  assert.equal(f.count.drawn, 3); assert.equal(f.actors.get('b').data.resources.bennies, 2);
  await f.controller().bennyCard(entry);
  assert.equal(f.count.drawn, 4); assert.equal(f.actors.get('b').data.resources.bennies, 1);
});

test('lost Hold/Release final checkpoint never repeats a status save, turn change or effect tick after remount', async () => {
  for (const holding of [true, false]) {
    const f = fixture({names: ['A ♠', 'K ♥']}), controller = f.controller(); await controller.dealRound(); await controller.beginRound();
    const entry = (await controller.refresh()).state.combatants.find(value => value.current);
    const actor = f.actors.get(entry.actor_id); actor.data.status.holding = !holding;
    actor.data.effects = [{data: {active: true, remaining: 3, phase: 'end', owner: 'self'}}];
    loseFinalCheckpoint(f, receipt => receipt.kind === `hold-${entry.id}-${holding}`);
    await assert.rejects(controller.hold(entry, holding), {code: 'unavailable'});
    const committed = {encounter: copy(f.encounter), actors: copy([...f.actors]), count: copy(f.count)};
    await f.controller().hold(entry, holding);
    assert.deepEqual(f.encounter, committed.encounter); assert.deepEqual([...f.actors], committed.actors); assert.deepEqual(f.count, committed.count);
    assert.equal(actor.data.effects[0].data.remaining, holding ? 2 : 3);
  }
});

test('a lost prepared-intent response recovers its original ID before any native command is issued', async () => {
  const f = fixture({names: ['A ♠', 'K ♥']}), controller = f.controller(); await controller.dealRound();
  const set = f.storage.user.set; let lost = false;
  f.storage.user.set = async (key, value, options) => {
    const result = await set(key, value, options);
    if (!lost && key.endsWith('.intent.pending') && value.stage === 'prepared') {lost = true; throw fail('unavailable');} return result;
  };
  await assert.rejects(controller.next(), {code: 'unavailable'});
  const prepared = await f.storage.user.get('initiative.scene.scene.intent.pending'); assert.equal(f.count.nextTurn, 0);
  await f.controller().next(); assert.equal(f.count.nextTurn, 1);
  assert.equal((await f.controller().refresh()).tracker.completedOperations.at(-1).id, prepared.value.id);
});

test('failed pointer deletion retains durable confirmation and permits a fresh deliberate action after remount', async () => {
  const f = fixture({names: ['A ♠', 'K ♥']}), controller = f.controller(); await controller.dealRound();
  const remove = f.storage.user.delete;
  f.storage.user.delete = async (key, options) => {if (key.endsWith('.intent.pending')) throw fail('unavailable'); return remove(key, options);};
  await controller.next(); assert.equal((await f.storage.user.get('initiative.scene.scene.intent.pending')).value.confirmed, true);
  await f.controller().next(); assert.equal(f.count.nextTurn, 2);
  assert.equal((await f.controller().refresh()).tracker.completedOperations.filter(receipt => receipt.kind === 'transition-nextTurn').length, 2);
});

test('Stop after a committed Start and failed setup cancels its pointer so a corrected deck starts a new encounter', async () => {
  const f = fixture({active: false, cardImages: false}), controller = f.controller();
  await assert.rejects(controller.start(), {code: 'invalid-action-card'}); assert.equal(f.count.start, 1);
  const oldEncounter = f.encounter.encounterId;
  await controller.stop(); assert.equal(f.encounter.active, false); assert.equal(await f.storage.user.get('initiative.scene.scene.intent.pending'), null);
  f.enableCardImages(); await f.controller().selectDeck('deck'); await f.controller().start();
  assert.equal(f.count.start, 2); assert.notEqual(f.encounter.encounterId, oldEncounter);
  assert.equal((await f.controller().refresh()).tracker.phase, 'ready');
});

test('another GM Stop cancels a partial Benny operation publicly without writing the owner private pointer', async () => {
  const f = fixture({names: ['A ♠', 'K ♥', '2 ♣']}), controller = f.controller(); await controller.dealRound();
  const entry = (await controller.refresh()).state.combatants.find(value => value.id === 'b'); f.failNextDraw();
  await assert.rejects(controller.bennyCard(entry), {code: 'unavailable'});
  const ownerPointer = await f.storage.user.get('initiative.scene.scene.intent.pending');
  const otherGM = createTrackerController({api: f.api, storage: {table: f.storage.table, user: store()}, sceneId: 'scene'});
  await otherGM.stop(); assert.deepEqual(await f.storage.user.get('initiative.scene.scene.intent.pending'), ownerPointer);
  const stopped = {actors: copy([...f.actors]), count: copy(f.count), encounter: copy(f.encounter)};
  await f.controller().bennyCard(entry);
  assert.deepEqual([...f.actors], stopped.actors); assert.deepEqual(f.count, stopped.count); assert.deepEqual(f.encounter, stopped.encounter);
  assert.equal(await f.storage.user.get('initiative.scene.scene.intent.pending'), null);
  await f.controller().selectDeck('deck'); await f.controller().start(); assert.equal(f.count.start, 1);
});
