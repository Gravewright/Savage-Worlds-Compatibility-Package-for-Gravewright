import { cloneData } from './model.js';
import { selectCard, mustRedraw, groupCombatants, cardFromScore, cardDisplay } from './initiative.js';
import { validateDeckChoice, nativeCardFacts } from './deck-config.js';
import { el, openModal, bindTranslation, refreshTranslations } from './ui.js';
import { advanceClocks } from './clocks.js';

const uuid = () => globalThis.crypto?.randomUUID?.() ?? `tracker-${Date.now()}-${Math.random()}`;
const identity = entry => entry.token_id ? { tokenId: entry.token_id } : { actorId: entry.actor_id };
const sheetContext = entry => entry.token_id ? { tokenId: entry.token_id } : {};
const error = code => Object.assign(new Error(code), { code });
const safePart = value => encodeURIComponent(String(value)).slice(0, 130);
const bennyCount = value => Math.max(0, Math.trunc(Number(value) || 0));
const npcBennyTarget = view => view.actorType === 'npc' || view.data?.profile?.kind === 'extra'
  || ['ally', 'enemy'].includes(view.data?.profile?.role);

/** Native APIs retain authorization and transaction boundaries; table storage never contains hidden card faces. */
export function createTrackerController({ api, storage, sceneId, settings, t = key => key }) {
  const key = `initiative.scene.${safePart(sceneId)}`;
  const intentKey = `${key}.intent.pending`, acknowledgedIntents = new Set();
  let state, cards, publicRecord, owner, operation, privateRecord, intentRecord;
  const hasIntent = kind => /^(transition-|benny-|hold-|command-)/.test(kind);
  const completion = journal => publicRecord?.value.completedOperations?.find(receipt => receipt.id === journal.value.id
    && receipt.owner === journal.value.owner && receipt.kind === journal.value.kind);
  const paused = (record = publicRecord?.value) => state?.active === true && record?.paused === true
    && record.pausedEncounterId === state.encounterId;
  function deckSelection(record = publicRecord?.value ?? {}) {
    // Existing configured choices are explicit scene choices. An inherited
    // choice becomes fixed for the active encounter or its pending operation.
    if (record.deckConfigured === true && (record.deckSource !== 'table' || state?.active || record.operation))
      return { id: record.deckId, configured: true, source: record.deckSource ?? 'scene' };
    const inherited = settings?.current?.deck;
    if (inherited?.instanceId) return { id: inherited.instanceId, configured: true, source: 'table' };
    return { id: record.deckSource === 'table' ? '' : record.deckId, configured: false, source: '' };
  }
  function snapshot() {
    const stored = publicRecord?.value ?? {}, choice = deckSelection(stored), deck = choice.configured
      ? cards?.decks?.find(value => value.id === choice.id) ?? null : null;
    const tracker = { ...stored, deckId: choice.id ?? '', deckName: deck?.name ?? stored.deckName ?? '',
      deckConfigured: choice.configured, deckSource: choice.source };
    const cardFaces = {}, authorized = [];
    for (const native of [...(cards?.hand ?? []), ...(cards?.cards ?? [])]) {
      if (!deck || native.deck_instance_id !== deck.id || !native.frontUrl) continue;
      try { authorized.push(nativeCardFacts(native, { deckId: deck.id })); } catch { /* Native hidden faces have no values. */ }
    }
    if (state?.active && tracker.encounterId === state.encounterId) for (const entry of state.combatants) {
      const cardId = tracker.actionCards?.[entry.id];
      const face = authorized.find(value => value.id === cardId)
        ?? (cards?.isGM ? authorized.find(value => value.score === entry.initiative) : null);
      if (face) cardFaces[entry.id] = { id: face.id, name: face.name, frontUrl: face.frontUrl, backUrl: face.backUrl };
    }
    return { state: cloneData(state), isGM: cards?.isGM === true, paused: paused(), tracker: cloneData(tracker),
      deck: cloneData(deck), decks: cloneData(cards?.decks ?? []), cardFaces };
  }
  async function refresh() {
    [state, cards, publicRecord] = await Promise.all([api.combat.state({ sceneId }), api.cards.state({ sceneId }), storage.table.get(key)]);
    return snapshot();
  }
  async function syncPublic() {
    publicRecord = await storage.table.get(key);
    return snapshot();
  }
  function requireRunning() {
    if (paused()) throw error('combat-paused');
  }
  function requireDeck() {
    const selection = deckSelection();
    if (!selection.configured) throw error('deck-required');
    const choice = validateDeckChoice(cards, selection.id);
    const deck = cards.decks.find(value => value.id === choice.id);
    const available = Number(deck.draw_count || 0) + Number(deck.discard_count || 0)
      + [...(cards.hand ?? []), ...(cards.cards ?? [])].filter(value => value.deck_instance_id === choice.id).length;
    if (available < 1) throw error('deck-empty');
    return deck;
  }
  async function pinDeck() {
    const deck = requireDeck();
    if (publicRecord?.value.deckConfigured === true && publicRecord.value.deckId === deck.id) return deck;
    await writePublic(value => {
      const current = deckSelection(value);
      if (current.id !== deck.id || !current.configured) throw error('conflict');
      if (value.operation && value.deckId !== deck.id) throw error('operation-busy');
      const changed = value.deckId !== deck.id || value.deckConfigured !== true;
      value.deckId = deck.id; value.deckName = deck.name; value.deckConfigured = true; value.deckSource = current.source;
      if (changed) { value.needsShuffle = true; value.actionCards = {}; }
    });
    return deck;
  }
  async function selectDeck(deckId) {
    await refresh();
    const choice = validateDeckChoice(cards, deckId);
    if (state.active) throw error('deck-locked');
    await writePublic(value => {
      if (value.operation) throw error('operation-busy');
      value.deckConfigured = true; value.deckId = choice.id; value.deckName = choice.name; value.deckSource = 'scene';
      value.needsShuffle = true; value.actionCards = {};
    });
    return snapshot();
  }
  async function setPaused(value) {
    await refresh();
    if (!cards.isGM) throw error('permission_denied');
    if (!state.active) throw error('combat-not-started');
    await writePublic(record => {
      if (record.operation) throw error('operation-busy');
      record.paused = value;
      record.pausedEncounterId = value ? state.encounterId : '';
    });
    return snapshot();
  }
  async function writePublic(update) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await storage.table.get(key), value = cloneData(current?.value ?? { schemaVersion: 1, deckId: '', encounterId: '', round: 0, needsShuffle: false, phase: 'ready', gmBennies: 0 });
      if (operation && value.operation && value.operation.id !== operation.id) throw error('operation-busy');
      update(value);
      try { publicRecord = await storage.table.set(key, value, { expectedRevision: current?.revision ?? null }); return value; }
      catch (failure) { if (failure.code !== 'conflict' || attempt === 3) throw failure; }
    }
  }
  async function ownerId() {
    if (owner) return owner;
    let value = await storage.user.get('initiative.owner');
    if (!value) {
      try { value = await storage.user.set('initiative.owner', uuid(), { expectedRevision: null }); }
      catch (failure) { if (failure.code !== 'conflict') throw failure; value = await storage.user.get('initiative.owner'); }
    }
    return owner = value.value;
  }
  async function acknowledgeIntent(journal) {
    const confirmed = await refresh();
    if (!completion(journal)) throw error('operation-busy');
    acknowledgedIntents.add(journal.value.id);
    // Confirmation is durable before optional deletion. A cleanup failure must
    // not turn a successfully confirmed action into a retryable mutation.
    try {
      let current = await storage.user.get(intentKey);
      if (current?.value.id === journal.value.id) {
        if (!current.value.confirmed) current = await storage.user.set(intentKey, {...current.value, confirmed: true}, {expectedRevision: current.revision});
        try { await storage.user.delete(intentKey, {expectedRevision: current.revision}); } catch { /* A confirmed pointer can be replaced by the next intent. */ }
      }
    } catch { /* The completed public receipt still prevents a duplicate after remount. */ }
    return confirmed;
  }
  async function recoverIntent(kind) {
    if (!cards?.isGM) return null;
    const journal = await storage.user.get(intentKey);
    if (!journal || journal.value.confirmed || acknowledgedIntents.has(journal.value.id)) return null;
    if (completion(journal)?.cancelled) {
      if (journal.value.kind === kind) return journal;
      await acknowledgeIntent(journal); return null;
    }
    if (journal.value.kind !== kind) throw error('operation-busy');
    if (completion(journal)) return journal;
    if (journal.value.stage === 'running' && publicRecord?.value.operation?.id !== journal.value.id) throw error('operation-busy');
    return null;
  }
  async function reserveIntent(kind, round, owner, pending, details) {
    const current = await storage.user.get(intentKey);
    if (current && !current.value.confirmed && !acknowledgedIntents.has(current.value.id)) {
      if (current.value.kind !== kind || current.value.owner !== owner) throw error('operation-busy');
      if (current.value.stage === 'running' && pending?.id !== current.value.id) throw error('operation-busy');
      if (!pending && current.value.encounterId !== state.encounterId) throw error('operation-busy');
      return current;
    }
    const value = {id: pending?.id || uuid(), owner, kind, round, encounterId: state.encounterId,
      details: cloneData(details), stage: pending ? 'running' : 'prepared', confirmed: false};
    return storage.user.set(intentKey, value, {expectedRevision: current?.revision ?? null});
  }
  function recordCompletion(value, completed, cancelled = false) {
    const previous = Array.isArray(value.completedOperations) ? value.completedOperations : [];
    value.completedOperations = [...previous.filter(receipt => receipt.id !== completed.id),
      {id: completed.id, owner: completed.owner, kind: completed.kind, round: completed.round, ...(cancelled ? {cancelled: true} : {})}].slice(-32);
  }
  async function begin(kind, round, requestedId, details = {}) {
    await refresh(); if (!cards.isGM) throw error('permission_denied');
    const progressesCombat = !kind.startsWith('gm-benny-');
    if (progressesCombat) requireRunning();
    const owner = await ownerId();
    const pending = publicRecord?.value?.operation;
    if (pending && (pending.owner !== owner || pending.kind !== kind || requestedId && pending.id !== requestedId)) throw error('operation-busy');
    if (hasIntent(kind)) {
      const recovered = await recoverIntent(kind);
      if (recovered) return {completed: true, journal: recovered};
      intentRecord = await reserveIntent(kind, round, owner, pending, details); requestedId = intentRecord.value.id;
    }
    if (pending) {
      if (pending.owner !== owner || pending.kind !== kind || requestedId && pending.id !== requestedId) throw error('operation-busy');
      operation = pending;
    } else {
      operation = { id: requestedId || uuid(), owner, kind, round, requests: {} };
      await writePublic(value => {
        if (value.operation) throw error('operation-busy');
        if (progressesCombat && paused(value)) throw error('combat-paused');
        value.operation = operation;
      });
    }
    if (hasIntent(kind) && intentRecord.value.stage !== 'running') intentRecord = await storage.user.set(intentKey,
      {...intentRecord.value, stage: 'running'}, {expectedRevision: intentRecord.revision});
    privateRecord = await storage.user.get(`${key}.operation.${operation.id}`);
    if (!privateRecord) privateRecord = await storage.user.set(`${key}.operation.${operation.id}`, {
      groups: null, selected: {}, stepKeys: [], jokersWild: settings?.current?.rules?.jokersWild !== false,
    }, { expectedRevision: null });
    return {completed: false, journal: hasIntent(kind) ? intentRecord : null};
  }
  async function savePrivate(value) {
    privateRecord = await storage.user.set(`${key}.operation.${operation.id}`, value, { expectedRevision: privateRecord.revision });
  }
  async function nativeStep(name, domain, method, build, reconcile) {
    const stepKey = `${key}.step.${operation.id}.${safePart(name)}`;
    let saved = await storage.user.get(stepKey);
    if (saved?.value.done) return cloneData(saved.value.result);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (reconcile && saved) {
        const confirmed = await reconcile(saved.value.requestId);
        if (confirmed) {
          saved = await storage.user.set(stepKey, { ...saved.value, done: true, result: confirmed }, { expectedRevision: saved.revision });
          return confirmed;
        }
      }
      if (!saved) {
        const requestId = uuid(), payload = await build(requestId);
        await writePublic(value => { value.operation.requests[name] = requestId; });
        const value = { requestId, payload, done: false };
        saved = await storage.user.set(stepKey, value, { expectedRevision: null });
        const metadata = cloneData(privateRecord.value); metadata.stepKeys.push(stepKey); await savePrivate(metadata);
      }
      try {
        const result = await api[domain][method](saved.value.payload, { requestId: saved.value.requestId });
        saved = await storage.user.set(stepKey, { ...saved.value, done: true, result }, { expectedRevision: saved.revision });
        return result;
      } catch (failure) {
        if (failure.code !== 'conflict' || attempt === 3) throw failure;
        if (reconcile) {
          const confirmed = await reconcile(saved.value.requestId);
          if (confirmed) {
            saved = await storage.user.set(stepKey, { ...saved.value, done: true, result: confirmed }, { expectedRevision: saved.revision });
            return confirmed;
          }
        }
        // A rejected version did not mutate. Rebase with a NEW command identity.
        await storage.user.delete(stepKey, { expectedRevision: saved.revision }); saved = null;
      }
    }
  }
  async function actorStep(name, entry, change) {
    const read = () => api.actors.sheet(entry.actor_id, sheetContext(entry));
    return nativeStep(name, 'actors', 'saveSheet', async requestId => {
      const current = await read(); if (!current.canEdit) throw error('permission_denied');
      let data = cloneData(current.data); const changed = change(data); if (changed && typeof changed === 'object') data = changed; data.combat ??= {};
      data.combat.trackerOperations = [...(Array.isArray(data.combat.trackerOperations) ? data.combat.trackerOperations : []), requestId].slice(-16);
      return { actorId: entry.actor_id, tokenId: entry.token_id ?? null, name: current.name, version: current.version, sheetVersion: current.sheetVersion, data };
    }, async requestId => {
      const current = await read(); return current.data?.combat?.trackerOperations?.includes(requestId) ? current : null;
    });
  }
  async function combatStep(name, method, payload = {}) {
    return nativeStep(name, 'combat', method, async () => ({ ...payload, sceneId, version: (await api.combat.state({ sceneId })).version }));
  }
  async function deckStep(name, method, deckId) {
    return nativeStep(name, 'cards', method, async () => {
      const deck = (await api.cards.state({ sceneId })).decks.find(value => value.id === deckId);
      if (!deck) throw error('deck-not-found'); return { deck_instance_id: deckId, version: deck.version };
    });
  }
  async function finish(update) {
    const old = operation, metadata = privateRecord;
    await writePublic(value => { update(value); if (hasIntent(old.kind)) recordCompletion(value, old); value.operation = null; });
    const confirmed = await refresh();
    operation = null; privateRecord = null;
    // Once the public checkpoint commits, private receipts can be removed safely.
    for (const stepKey of new Set(metadata.value.stepKeys)) {
      try { const record = await storage.user.get(stepKey); if (record) await storage.user.delete(stepKey, { expectedRevision: record.revision }); } catch { /* Cleanup can be retried without changing the result. */ }
    }
    try { await storage.user.delete(`${key}.operation.${old.id}`, { expectedRevision: metadata.revision }); } catch { /* Nonessential cleanup. */ }
    return confirmed;
  }
  const gmJournalKey = `${key}.gm-benny.pending`;
  const grantTarget = entry => `${entry.actor_id}:${entry.token_id ?? ''}`;
  async function clearGMJournal(journal) {
    try {
      const current = await storage.user.get(gmJournalKey);
      if (current?.value.id === journal.value.id) await storage.user.delete(gmJournalKey, { expectedRevision: current.revision });
    } catch { /* A completed public receipt makes journal cleanup safe to retry. */ }
  }
  async function beginGMBenny(kind, payload, validate) {
    await refresh(); if (!cards.isGM) throw error('permission_denied');
    let journal = await storage.user.get(gmJournalKey);
    if (journal) {
      if (journal.value.kind !== kind || JSON.stringify(journal.value.payload) !== JSON.stringify(payload)) throw error('operation-busy');
      if (publicRecord?.value.gmBennyReceipts?.some(receipt => receipt.id === journal.value.id && receipt.stage === 'done')) {
        await clearGMJournal(journal); operation = null; privateRecord = null;
        return { journal, completed: true };
      }
    } else {
      if (publicRecord?.value.operation) throw error('operation-busy');
      await validate();
      const value = { id: uuid(), kind, payload: cloneData(payload), owner: await ownerId() };
      journal = await storage.user.set(gmJournalKey, value, { expectedRevision: null });
    }
    await begin(kind, state.round, journal.value.id);
    return { journal, completed: false };
  }
  function gmReceipt(value, journal, stage) {
    const prior = Array.isArray(value.gmBennyReceipts) ? value.gmBennyReceipts : [];
    value.gmBennyReceipts = [...prior.filter(receipt => receipt.id !== journal.value.id),
      { id: journal.value.id, kind: journal.value.kind, ...journal.value.payload, stage }].slice(-32);
  }
  async function adjustGMBennies(delta) {
    if (!Number.isSafeInteger(delta) || !delta) throw error('invalid-benny-count');
    const { journal, completed } = await beginGMBenny('gm-benny-adjust', { delta }, () => {
      const amount = bennyCount(publicRecord?.value.gmBennies) + delta;
      if (amount < 0) throw error('insufficient-gm-bennies');
      if (!Number.isSafeInteger(amount)) throw error('invalid-benny-count');
    });
    if (completed) return refresh();
    const result = await finish(value => {
      if (!value.gmBennyReceipts?.some(receipt => receipt.id === journal.value.id && receipt.stage === 'done')) {
        const amount = bennyCount(value.gmBennies) + delta;
        if (amount < 0) throw error('insufficient-gm-bennies');
        if (!Number.isSafeInteger(amount)) throw error('invalid-benny-count');
        value.gmBennies = amount; gmReceipt(value, journal, 'done');
      }
    });
    await clearGMJournal(journal); return result;
  }
  async function spendGMBenny(entry) {
    const payload = { target: grantTarget(entry), actorId: entry.actor_id, tokenId: entry.token_id ?? null };
    const { journal, completed } = await beginGMBenny('gm-benny-grant', payload, async () => {
      if (bennyCount(publicRecord?.value.gmBennies) < 1) throw error('insufficient-gm-bennies');
      const current = await api.actors.sheet(entry.actor_id, sheetContext(entry));
      if (!current.canEdit) throw error('permission_denied');
      if (!npcBennyTarget(current)) throw error('not-npc');
      if (bennyCount(current.data?.resources?.bennies) > 0) throw error('benny-already-available');
    });
    if (completed) return refresh();
    // The debit and its durable marker commit together before the native credit.
    await writePublic(value => {
      if (value.gmBennyReceipts?.some(receipt => receipt.id === journal.value.id)) return;
      if (bennyCount(value.gmBennies) < 1) throw error('insufficient-gm-bennies');
      value.gmBennies = bennyCount(value.gmBennies) - 1; gmReceipt(value, journal, 'funded');
    });
    await actorStep('gm-benny-credit', entry, data => {
      data.resources ??= {}; data.resources.bennies = bennyCount(data.resources.bennies) + 1;
    });
    const result = await finish(value => { gmReceipt(value, journal, 'done'); });
    await clearGMJournal(journal); return result;
  }
  async function ensureDeck() {
    const deckId = requireDeck().id;
    if (publicRecord.value.needsShuffle) await deckStep('deck-reset', 'reset', deckId);
    return deckId;
  }
  async function draw(name, deckId) {
    const result = await nativeStep(name, 'cards', 'draw', () => ({ deck_instance_id: deckId, count: 1, destination: 'hand', face_state: 'face_up' }));
    if (!result.cards?.[0]) throw error('invalid-card-response');
    try { return nativeCardFacts(result.cards[0], { deckId, requireFace: true }); }
    catch { throw error('invalid-action-card'); }
  }
  async function dealRound() {
    await refresh();
    requireRunning();
    if (!state.active || !state.combatants.length) return snapshot();
    await pinDeck();
    if (!publicRecord?.value.operation && publicRecord?.value.encounterId === state.encounterId && publicRecord?.value.round === state.round) return snapshot();
    await begin('deal', state.round);
    const deckId = await ensureDeck();
    if (!privateRecord.value.groups) {
      const sheets = new Map();
      for (const entry of state.combatants) sheets.set(entry.id, (await api.actors.sheet(entry.actor_id, sheetContext(entry))).data);
      const groups = groupCombatants(state.combatants, sheets), metadata = cloneData(privateRecord.value);
      metadata.groups = groups; metadata.encounterId = state.encounterId; metadata.role = Object.fromEntries(state.combatants.map(entry => [entry.id, sheets.get(entry.id)?.profile?.role ?? '']));
      const readyDeck = (await api.cards.state({ sceneId })).decks.find(value => value.id === deckId);
      metadata.redrawLimit = Math.max(1, Math.trunc(Number(readyDeck?.draw_count) || 0));
      await savePrivate(metadata);
    }
    const groups = privateRecord.value.groups;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]; let selected = privateRecord.value.selected[index];
      if (!selected) {
        const candidates = [];
        if (!group.config.holding) {
          for (let slot = 0; slot < group.config.draw; slot++) {
            let card;
            for (let retry = 0; retry < privateRecord.value.redrawLimit; retry++) { card = await draw(`draw-${index}-${slot}-${retry}`, deckId); if (!mustRedraw(card, group.config)) break; }
            if (mustRedraw(card, group.config)) throw error('invalid-action-card');
            candidates.push(card);
          }
        }
        selected = group.config.holding ? { holding: true, score: 0 } : selectCard(candidates, group.config.keep);
        const metadata = cloneData(privateRecord.value); metadata.selected[index] = selected; await savePrivate(metadata);
      }
      for (let member = 0; member < group.combatants.length; member++) {
        const entry = group.combatants[member];
        await combatStep(`initiative-${index}-${member}`, 'setInitiative', { ...identity(entry), value: selected.score });
      }
    }
    const selected = Object.values(privateRecord.value.selected);
    const jokerCount = roleTest => selected.filter(card => card.joker).reduce((sum, card) => {
      const index = Object.keys(privateRecord.value.selected).find(key => privateRecord.value.selected[key].id === card.id);
      const role = privateRecord.value.role[groups[index]?.combatants[0]?.id]; return sum + (roleTest(role) ? 1 : 0);
    }, 0);
    const playerJokers = privateRecord.value.jokersWild !== false ? jokerCount(role => role === 'player' || role === 'ally') : 0;
    const enemyJokers = privateRecord.value.jokersWild !== false ? jokerCount(role => role === 'enemy') : 0;
    const jokerByActor = new Map();
    for (let index = 0; index < groups.length; index++) for (const entry of groups[index].combatants) {
      const sheet = await api.actors.sheet(entry.actor_id, sheetContext(entry));
      const independent = !!sheet.tokenId;
      const actorKey = independent ? entry.id : entry.actor_id;
      const previous = jokerByActor.get(actorKey);
      jokerByActor.set(actorKey, { entry: independent ? entry : { ...entry, token_id: null }, joker: !!privateRecord.value.selected[index].joker || previous?.joker === true });
    }
    let number = 0;
    for (const value of jokerByActor.values()) await actorStep(`joker-${number++}`, value.entry, data => { data.combat ??= {}; data.combat.joker = value.joker; data.combat.cardInitiative = true; });
    // Beneficiaries are explicit user role settings; actor type alone is never authorization.
    if (playerJokers || enemyJokers) {
      const actors = await api.actors.list();
      for (let index = 0; index < actors.length; index++) {
        const entry = { actor_id: actors[index].id, token_id: null }, sheet = await api.actors.sheet(entry.actor_id);
        const role = sheet.data?.profile?.role, wild = sheet.data?.profile?.kind === 'wild-card';
        const amount = role === 'player' ? playerJokers : role === 'enemy' && wild ? enemyJokers : 0;
        if (amount) await actorStep(`award-${index}`, entry, data => { data.resources ??= {}; data.resources.bennies = Math.max(0, Number(data.resources.bennies) || 0) + amount; });
      }
    }
    const current = await api.combat.state({ sceneId }), first = current.combatants.find(entry => entry.initiative > 0 && !entry.defeated);
    if (first) await combatStep('first-turn', 'setTurn', identity(first));
    return finish(value => {
      value.encounterId = privateRecord.value.encounterId; value.round = operation.round;
      value.actionCards = {};
      for (let index = 0; index < groups.length; index++) for (const entry of groups[index].combatants)
        if (!entry.hidden && privateRecord.value.selected[index].id) value.actionCards[entry.id] = privateRecord.value.selected[index].id;
      value.needsShuffle = selected.some(card => card.joker); value.phase = 'ready'; value.paused = false; value.pausedEncounterId = '';
      value.gmBennies = Math.max(0, Number(value.gmBennies) || 0) + enemyJokers;
    });
  }
  async function transition(method) {
    await refresh();
    const kind = `transition-${method}`, recovered = await recoverIntent(kind);
    if (recovered) {
      if (!completion(recovered)?.cancelled && state.active && (publicRecord?.value.round !== state.round || publicRecord?.value.encounterId !== state.encounterId)) await dealRound();
      return acknowledgeIntent(recovered);
    }
    requireRunning();
    if (method === 'start') await pinDeck();
    if (!cards.isGM && publicRecord?.value.operation) throw error('operation-busy');
    if (cards.isGM && publicRecord?.value.operation?.kind === 'deal') return dealRound();
    if (cards.isGM && publicRecord?.value.operation?.kind === 'round-start') return beginRound();
    if (cards.isGM && !publicRecord?.value.operation && state.active && publicRecord?.value.round !== state.round && method !== 'start') return dealRound();
    let result;
    if (cards.isGM) {
      const begun = await begin(kind, state.round);
      if (begun.completed) {
        if (state.active && (publicRecord?.value.round !== state.round || publicRecord?.value.encounterId !== state.encounterId)) await dealRound();
        return acknowledgeIntent(begun.journal);
      }
      result = await combatStep('transition', method);
      await finish(() => {});
      if (state.active && (publicRecord?.value.round !== state.round || publicRecord?.value.encounterId !== state.encounterId)) await dealRound();
      return acknowledgeIntent(begun.journal);
    } else result = await api.combat[method]({ sceneId });
    await refresh();
    if (cards.isGM && state.active && (publicRecord?.value.round !== state.round || publicRecord?.value.encounterId !== state.encounterId)) await dealRound();
    return result;
  }
  async function start() {
    await refresh();
    let journal = await storage.user.get(intentKey);
    if (journal && completion(journal)?.cancelled) {await acknowledgeIntent(journal); journal = null;}
    if (journal && !journal.value.confirmed && !acknowledgedIntents.has(journal.value.id)) return transition('start');
    if (paused()) return setPaused(false);
    await pinDeck();
    if (state.active && publicRecord?.value.operation?.kind !== 'transition-start') return dealRound();
    return transition('start');
  }
  async function beginRound() {
    await refresh(); if (!cards.isGM) throw error('permission_denied');
    requireRunning();
    if (publicRecord?.value.phase === 'playing' && !publicRecord.value.operation) return snapshot();
    await begin('round-start', state.round);
    const first = state.combatants.find(entry => entry.initiative > 0 && !entry.defeated);
    if (first) {
      await combatStep('round-first', 'setTurn', identity(first));
      const firstView = await api.actors.sheet(first.actor_id, sheetContext(first)), firstIndependent = !!firstView.tokenId;
      const documents = new Map(), actors = await api.actors.list();
      for (const actor of actors) documents.set(`actor:${actor.id}`, { actor_id: actor.id, token_id: null });
      for (const entry of state.combatants) {
        const view = await api.actors.sheet(entry.actor_id, sheetContext(entry));
        if (view.tokenId) documents.set(`token:${view.tokenId}`, entry);
      }
      const clockKeys = new Set(); let index = 0;
      for (const entry of documents.values()) {
        const view = await api.actors.sheet(entry.actor_id, sheetContext(entry)), independent = !!view.tokenId;
        const event = { actorId: first.actor_id, tokenId: first.token_id ?? null,
          isCurrent: independent ? entry.token_id === first.token_id : !firstIndependent && entry.actor_id === first.actor_id,
          roundBoundary: false, phase: 'start', documentKey: independent ? ['token', entry.token_id] : ['actor', entry.actor_id], clockKeys };
        const probe = advanceClocks(view.data, { ...event, clockKeys: new Set(clockKeys) });
        if (probe.changed) {
          let acceptedKeys;
          await actorStep(`round-start-${index}`, entry, data => {
            acceptedKeys = new Set(clockKeys);
            return advanceClocks(data, { ...event, clockKeys: acceptedKeys }).sheet;
          });
          for (const claimed of acceptedKeys ?? []) clockKeys.add(claimed);
        }
        index++;
      }
    }
    return finish(value => { value.phase = 'playing'; });
  }
  async function bennyCard(entry) {
    await refresh();
    const kind = `benny-${entry.actor_id}-${entry.token_id ?? ''}-${entry.id}`, recovered = await recoverIntent(kind);
    if (recovered) return acknowledgeIntent(recovered);
    if (!state.active) throw error('combat-not-started');
    requireRunning(); if (publicRecord?.value.phase !== 'ready') throw error('round-already-started');
    const before = await api.actors.sheet(entry.actor_id, sheetContext(entry));
    if (!publicRecord?.value.operation && (Number(before.data?.resources?.bennies) || 0) < 1) throw error('insufficient-bennies');
    const begun = await begin(kind, state.round, undefined, {initiative: entry.initiative});
    if (begun.completed) return acknowledgeIntent(begun.journal);
    const deckId = publicRecord.value.deckId, sheet = await api.actors.sheet(entry.actor_id, sheetContext(entry));
    await actorStep('benny-pay', entry, data => { if ((Number(data.resources?.bennies) || 0) < 1) throw error('insufficient-bennies'); data.resources.bennies = Number(data.resources.bennies) - 1; });
    let metadata = cloneData(privateRecord.value); metadata.paid = true; await savePrivate(metadata);
    const drawn = await draw('benny-draw', deckId), existing = cardFromScore(begun.journal.value.details.initiative);
    const chosen = privateRecord.value.bennyChoice ?? selectCard(existing ? [existing, drawn] : [drawn]);
    const groupId = sheet.data?.profile?.initiative?.groupId;
    const members = [entry];
    if (groupId) for (const candidate of state.combatants) {
      if (candidate.id === entry.id) continue;
      const view = await api.actors.sheet(candidate.actor_id, sheetContext(candidate));
      if (view.data?.profile?.initiative?.groupId === groupId) members.push(candidate);
    }
    if (!privateRecord.value.bennyChoice) {
      metadata = cloneData(privateRecord.value); metadata.bennyChoice = chosen; metadata.bennyMembers = members; await savePrivate(metadata);
    }
    const targets = privateRecord.value.bennyMembers;
    for (let index = 0; index < targets.length; index++) {
      await combatStep(`benny-initiative-${index}`, 'setInitiative', { ...identity(targets[index]), value: chosen.score });
      if (chosen.joker) await actorStep(`benny-joker-${index}`, targets[index], data => { data.combat ??= {}; data.combat.joker = true; });
    }
    // The fresh Joker must still award Bennies; call the same native actor reconciliation pattern.
    if (drawn.joker && privateRecord.value.jokersWild !== false) {
      const role = sheet.data?.profile?.role, actors = await api.actors.list();
      for (let index = 0; index < actors.length; index++) {
        const view = await api.actors.sheet(actors[index].id), targetRole = view.data?.profile?.role;
        if ((role !== 'enemy' && targetRole === 'player') || (role === 'enemy' && targetRole === 'enemy' && view.data?.profile?.kind === 'wild-card'))
          await actorStep(`benny-award-${index}`, { actor_id: actors[index].id }, data => { data.resources.bennies = Math.max(0, Number(data.resources.bennies) || 0) + 1; });
      }
    }
    await finish(value => {
      value.actionCards ??= {};
      if (chosen.id) for (const member of targets) if (!member.hidden) value.actionCards[member.id] = chosen.id;
      if (drawn.joker) value.needsShuffle = true;
      if (drawn.joker && privateRecord.value.jokersWild !== false && sheet.data?.profile?.role === 'enemy') value.gmBennies = Math.max(0, Number(value.gmBennies) || 0) + 1;
    });
    return acknowledgeIntent(begun.journal);
  }
  async function hold(entry, holding) {
    await refresh();
    const kind = `hold-${entry.id}-${holding}`, recovered = await recoverIntent(kind);
    if (recovered) {
      if (!completion(recovered)?.cancelled && state.active && (publicRecord?.value.round !== state.round || publicRecord?.value.encounterId !== state.encounterId)) await dealRound();
      return acknowledgeIntent(recovered);
    }
    if (!state.active) throw error('combat-not-started');
    requireRunning();
    const view = await api.actors.sheet(entry.actor_id, sheetContext(entry));
    if (holding && (view.data.status?.shaken || view.data.status?.stunned || view.data.status?.incapacitated)) throw error('cannot-hold');
    // Reserve the operation before changing the sheet or turn; another GM's
    // pause cannot interleave with a partially completed Hold/Release action.
    const begun = await begin(kind, state.round, undefined, {current: entry.current === true});
    if (begun.completed) {
      if (!completion(begun.journal)?.cancelled && state.active && (publicRecord?.value.round !== state.round || publicRecord?.value.encounterId !== state.encounterId)) await dealRound();
      return acknowledgeIntent(begun.journal);
    }
    requireRunning();
    await actorStep('holding-state', entry, data => { data.status ??= {}; data.status.holding = holding; });
    if (holding && begun.journal.value.details.current) await combatStep('holding-next', 'nextTurn');
    else if (!holding) await combatStep('holding-turn', 'setTurn', identity(entry));
    await finish(() => {});
    if (state.active && (publicRecord?.value.round !== state.round || publicRecord?.value.encounterId !== state.encounterId)) await dealRound();
    return acknowledgeIntent(begun.journal);
  }
  async function command(method, payload) {
    await refresh();
    const kind = `command-${method}-${JSON.stringify(payload)}`, recovered = await recoverIntent(kind);
    if (recovered) return acknowledgeIntent(recovered);
    requireRunning();
    const begun = await begin(kind, state.round); if (begun.completed) return acknowledgeIntent(begun.journal); requireRunning();
    await combatStep('command', method, payload);
    await finish(() => {}); return acknowledgeIntent(begun.journal);
  }
  async function stop() {
    await refresh(); if (!cards.isGM) throw error('permission_denied');
    if (publicRecord?.value.operation?.kind?.startsWith('gm-benny-')) throw error('operation-busy');
    const cancelled = publicRecord?.value.operation, journal = await storage.user.get(intentKey);
    const entries = state.combatants;
    await api.combat.stop({ sceneId });
    // A cancelled setup needs a fresh complete deck; its partial scores remain editable native state.
    operation = null;
    await writePublic(value => {
      if (cancelled && hasIntent(cancelled.kind)) recordCompletion(value, cancelled, true);
      if (journal && !journal.value.confirmed) recordCompletion(value, journal.value, true);
      value.operation = null; value.round = 0; value.encounterId = ''; value.actionCards = {}; value.needsShuffle = true; value.phase = 'ready'; value.paused = false; value.pausedEncounterId = '';
      if (value.deckSource === 'table') { value.deckConfigured = false; value.deckId = ''; value.deckName = ''; }
    });
    for (const entry of entries) {
      const view = await api.actors.sheet(entry.actor_id, sheetContext(entry));
      if (!view.data?.combat?.joker) continue;
      const data = cloneData(view.data); data.combat.joker = false;
      await api.actors.saveSheet({ actorId: entry.actor_id, tokenId: entry.token_id ?? null, name: view.name, version: view.version, sheetVersion: view.sheetVersion, data });
    }
    return journal && !journal.value.confirmed ? acknowledgeIntent(journal) : refresh();
  }
  return { refresh, syncPublic, snapshot, selectDeck, dealRound, beginRound, bennyCard, adjustGMBennies, spendGMBenny, hold, command, transition,
    start, stop, pause: () => setPaused(true), resume: () => setPaused(false), next: () => transition('nextTurn'), previous: () => transition('previousTurn'),
    nextRound: () => transition('nextRound'), previousRound: () => transition('previousRound') };
}

export async function mountCombatTracker(block, system) {
  const { root, api, storage, context, signal } = block, doc = root.ownerDocument, t = system.t;
  const controller = createTrackerController({ api, storage, sceneId: context.sceneId, settings: system.settings, t });
  const shell = el(doc, 'section', 'gws-tracker gw-combat-panel'); shell.setAttribute('translate', 'no'); root.append(shell);
  const pending = new Set();
  let view, busy = false, failure = '', disposed = false, retryTask, currentModal, synchronization;
  const failureText = () => {const key=`tracker.error.${failure}`, value=t(key);return value===key?t('tracker.error.unavailable'):value;};
  const focusedControl = () => shell.contains(doc.activeElement) ? { action: doc.activeElement.dataset.gwsTrackerAction,
    id: doc.activeElement.closest('[data-gws-combatant]')?.dataset.gwsCombatant } : null;
  function updateModalControls() {
    if (!currentModal?.isConnected) return;
    for (const node of currentModal.querySelectorAll('[data-gws-tracker-modal-button]'))
      node.disabled = busy || view?.paused === true && node.dataset.gwsPauseAllowed !== 'true' || node.dataset.gwsCommitted === 'true' || node.dataset.gwsTrackerUnavailable === 'true';
    let notice = currentModal.querySelector('.gws-modal-pause');
    if (view?.paused && currentModal.dataset.gwsPauseAllowed !== 'true') {
      if (!notice) { notice = el(doc, 'p', 'gws-modal-pause gws-tracker-paused', () => t('tracker.pausedHint')); notice.setAttribute('role', 'status'); currentModal.append(notice); }
    } else notice?.remove();
  }
  async function run(task) {
    if (busy || disposed) return; const focus = focusedControl(); busy = true; failure = ''; retryTask = task; shell.setAttribute('aria-busy', 'true');
    for (const node of [...shell.querySelectorAll('button'), ...(currentModal?.querySelectorAll('[data-gws-tracker-modal-button]') ?? [])]) node.disabled = true;
    let complete;
    const completion = new Promise(resolve => { complete = resolve; }); pending.add(completion);
    const work = Promise.resolve().then(async () => { await synchronization; return task(); });
    try { await work; view = await controller.refresh(); } catch (error) {
      failure = error.code || 'unavailable';
      if (currentModal?.isConnected) {
        let notice = currentModal.querySelector('.gws-modal-notice');
        if (!notice) { notice = el(doc, 'p', 'gws-modal-notice'); notice.setAttribute('role', 'alert'); currentModal.append(notice); }
        bindTranslation(notice,'textContent',failureText);
      }
    }
    finally {
      busy = false; shell.removeAttribute('aria-busy');
      updateModalControls();
      if (!disposed) render(focus);
      pending.delete(completion); complete();
    }
  }
  function button(key, action, disabled = false, labelled = true) {
    const node = el(doc, 'button', 'gws-button', labelled ? () => t(key) : undefined); node.type = 'button'; node.disabled = busy || disabled; node.dataset.gwsTrackerAction = key;
    node.addEventListener('click', () => void run(action), { signal }); return node;
  }
  const glyphs = {
    play: ['M7 4l13 8-13 8z'], pause: ['M7 4v16M17 4v16'], stop: ['M5 5h14v14H5z'],
    previous: ['m15 5-7 7 7 7'], next: ['m9 5 7 7-7 7'], round: ['M20 7V2l-5 5', 'M20 7a9 9 0 1 0 1 8'],
    add: ['M12 4v16M4 12h16'], cards: ['M4 5h13v16H4z', 'M8 2h13v16'],
    settings: ['M4 6h16M4 12h16M4 18h16', 'M8 3v6M16 9v6M10 15v6'],
    more: ['M12 5h.01M12 12h.01M12 19h.01'], benny: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M8 9h5a2 2 0 0 1 0 4H8m0-4v7h5a2 2 0 0 0 0-4'],
  };
  function glyph(name) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    for (const d of glyphs[name] || glyphs.more) { const path = doc.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
    return svg;
  }
  function iconButton(key, icon, action, disabled = false, primary = false) {
    const node = button(key, action, disabled, false); node.className = `gw-combat-icon${primary ? ' gw-combat-icon--primary' : ''}`;
    bindTranslation(node,'aria-label',() => t(key));bindTranslation(node,'title',() => t(key));node.replaceChildren(glyph(icon));return node;
  }
  function imageAddress(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try { const url = new URL(value, doc.baseURI); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }
  function portrait(entry) {
    const wrap = el(doc, 'span', 'gw-combat-combatant__portrait'), initial = el(doc, 'span', 'gw-combat-combatant__initial', String(entry.name || '?').trim().charAt(0).toUpperCase());
    wrap.setAttribute('aria-hidden', 'true'); wrap.append(initial);
    const source = imageAddress(entry.portrait_url || entry.portraitUrl || entry.token_url);
    if (source) {
      const image = el(doc, 'img'); image.src = source; image.alt = ''; initial.hidden = true;
      image.addEventListener('error', () => { image.remove(); initial.hidden = false; }, { once: true }); wrap.append(image);
    }
    return wrap;
  }
  function cardThumbnail(entry, tracker) {
    const face = tracker?.[entry.id], card = cardFromScore(entry.initiative);
    const name = entry.initiative === 0 ? t('status.holding') : face?.name || cardDisplay(card);
    const slot = el(doc, 'span', 'gw-combat-combatant__score gws-tracker-card'); slot.title = name;
    slot.setAttribute('role', 'img'); slot.setAttribute('aria-label', name);
    if(entry.initiative===0){bindTranslation(slot,'title',()=>t('status.holding'));bindTranslation(slot,'aria-label',()=>t('status.holding'));}
    const fallback = el(doc, 'span', 'gws-card-fallback', entry.initiative===0 ? ()=>t('status.holding') : name); slot.append(fallback);
    if (card?.suit === 'hearts' || card?.suit === 'diamonds' || /[♥♦]/.test(name)) slot.classList.add('is-red');
    if (entry.initiative === 0) slot.classList.add('is-holding');
    const source = imageAddress(face?.frontUrl);
    if (source) {
      const image = el(doc, 'img', 'gws-tracker-card-face'); image.src = source; image.alt = name; fallback.hidden = true;
      const index = el(doc, 'span', 'gws-card-index', cardDisplay(card)); index.setAttribute('aria-hidden', 'true');
      image.addEventListener('error', () => { image.remove(); index.remove(); fallback.hidden = false; }, { once: true }); slot.append(image, index);
    }
    return slot;
  }
  function resourceBar(value, entry) {
    const max = Number(value.max), current = Number(value.value);
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(current)) return null;
    const bar = el(doc, 'div', 'gw-combat-bar'), track = el(doc, 'span', 'gw-combat-bar__track'), fill = el(doc, 'span', 'gw-combat-bar__fill');
    bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', `${value.label || entry.name}: ${current}/${max}`);
    fill.style.width = `${Math.max(0, Math.min(100, current / max * 100))}%`; track.append(fill);
    bar.append(track, el(doc, 'span', 'gw-combat-bar__value', `${current}/${max}`)); return bar;
  }
  function modalButton(key, action, pauseAllowed = false) {
    const node = el(doc, 'button', 'gws-button', () => t(key)); node.type = 'button'; node.disabled = busy; node.dataset.gwsTrackerModalButton = '';
    node.dataset.gwsPauseAllowed = String(pauseAllowed);
    node.addEventListener('click', () => { if (!busy) void run(action); }, { signal }); return node;
  }
  function render(restoreFocus) {
    if (disposed) return;
    const focused = restoreFocus ?? focusedControl();
    updateModalControls();
    shell.replaceChildren();
    const state = view?.state, tracker = view?.tracker ?? {}, isGM = view?.isGM, paused = view?.paused === true;
    const locked = paused || !!tracker.operation, panel = el(doc, 'div', 'gw-combat-panel__state'); shell.append(panel);
    if (failure) { const notice = el(doc, 'p', 'gws-tracker-error', failureText); notice.setAttribute('role', 'alert'); shell.append(notice, button('common.retry', retryTask || controller.dealRound)); }
    if (!state) { panel.append(el(doc, 'p', '', () => t('common.loading'))); return; }
    const shown = state.combatants.filter(entry => isGM || !entry.hidden), current = shown.find(entry => entry.current || entry.is_current);
    const next = shown.find(entry => entry.is_next) || (current ? shown[shown.indexOf(current) + 1] : null);
    const header = el(doc, 'header', 'gw-combat-header');
    header.append(el(doc, 'strong', 'gw-combat-header__title', () => t(state.active ? 'tracker.round' : 'tracker.inactive', { round: state.round })));
    if (state.active && current) { const currentName = el(doc, 'span', 'gw-combat-header__current', current.name); bindTranslation(currentName,'title',()=>t('tracker.current'));header.append(currentName); }
    if (state.active && next) header.append(el(doc, 'span', 'gw-combat-header__next', () => `${t('tracker.nextUp')}: ${next.name}`));
    const status = el(doc, 'span', `gws-tracker-status${paused ? ' is-paused' : ''}`, () => t(!state.active ? 'tracker.inactive' : paused ? 'tracker.paused' : 'tracker.active'));
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); header.append(status);
    if (isGM) {
      const pool = button('tracker.gmBennies', gmBennies, !!tracker.operation, false); pool.className = 'gws-gm-benny-count';
      bindTranslation(pool,'aria-label',()=>`${t('tracker.gmBennies')}: ${bennyCount(tracker.gmBennies)}`);bindTranslation(pool,'title',()=>t('tracker.gmBennies'));
      pool.replaceChildren(glyph('benny'), el(doc, 'output', '', String(bennyCount(tracker.gmBennies)))); header.append(pool);
    }
    panel.append(header);
    const controls = el(doc, 'div', 'gw-combat-toolbar gws-tracker-toolbar');
    if (isGM) {
      const key = !state.active ? 'tracker.start' : paused ? 'tracker.resume' : 'tracker.pause';
      controls.append(iconButton(key, !state.active || paused ? 'play' : 'pause', !state.active ? controller.start : paused ? controller.resume : controller.pause,
        !state.active && (!state.combatants.length || !view.deck) || state.active && !!tracker.operation, true),
        iconButton('tracker.stop', 'stop', controller.stop, !state.active),
        iconButton('tracker.previous', 'previous', controller.previous, !state.active || locked),
        iconButton('tracker.next', 'next', controller.next, !state.active || locked || tracker.phase !== 'playing', true),
        iconButton('tracker.nextRound', 'round', controller.nextRound, !state.active || locked || tracker.phase !== 'playing'),
        iconButton('tracker.add', 'add', add, locked),
        iconButton('tracker.configureDeck', 'settings', deckSettings, state.active || !!tracker.operation));
    } else if (state.active && shown.some(entry => (entry.current || entry.is_current) && entry.canControl)) {
      controls.append(iconButton('tracker.next', 'next', controller.next, locked || tracker.phase !== 'playing', true));
    }
    panel.append(controls);
    if (!state.active && isGM && !view.deck) panel.append(el(doc, 'p', 'gws-tracker-deck-needed', () => t('tracker.deckNeeded')));
    if (isGM) {
      const deal = el(doc, 'div', 'gw-combat-rollbar');
      deal.append(iconButton('tracker.deal', 'cards', controller.dealRound, !state.active || locked, true),
        iconButton('tracker.beginRound', 'play', controller.beginRound, !state.active || locked || tracker.phase !== 'ready'));
      panel.append(deal);
    }
    if (paused) panel.append(el(doc, 'p', 'gws-tracker-paused', () => t('tracker.pausedHint')));
    if (tracker.phase === 'ready' && state.active && !locked && !busy) panel.append(el(doc, 'p', 'gws-tracker-phase', () => t('tracker.ready')));
    if (!isGM && state.active && tracker.round !== state.round) panel.append(el(doc, 'p', '', () => t('tracker.awaitGM')));
    const list = el(doc, 'div', 'gw-combat-list'); panel.append(list);
    if (!shown.length) list.append(el(doc, 'p', 'tool-empty gw-combat-empty', () => t('tracker.empty')));
    for (const [index, entry] of shown.entries()) {
      const isCurrent = entry.current || entry.is_current;
      const row = el(doc, 'article', `gw-combat-combatant gws-tracker-row${isCurrent ? ' is-current' : ''}${entry === next ? ' is-next' : ''}${entry.defeated ? ' is-defeated' : ''}${entry.hidden ? ' is-hidden-combatant' : ''}${entry.has_acted ? ' has-acted' : ''}`);
      row.dataset.gwsCombatant = entry.id;
      row.append(el(doc, 'span', `gw-combat-combatant__position${isCurrent ? ' gw-combat-combatant__turn-star' : ''}`, isCurrent ? '★' : entry.position || index + 1), portrait(entry));
      const main = el(doc, 'div', 'gw-combat-combatant__main'); main.append(el(doc, 'span', 'gw-combat-combatant__name gws-tracker-name', entry.name));
      const meta = [];
      if (entry.conditions_count) meta.push(`${entry.conditions_count} ⊘`);
      if (entry.effects_count) meta.push(`${entry.effects_count} ✦`);
      if (entry.defeated) meta.push(()=>t('tracker.defeat'));
      if (meta.length) main.append(el(doc, 'span', 'gw-combat-combatant__meta', () => meta.map(value=>typeof value==='function'?value():value).join(' · ')));
      for (const value of entry.bars || (entry.bar ? [entry.bar] : [])) { const bar = resourceBar(value, entry); if (bar) main.append(bar); }
      row.append(main, cardThumbnail(entry, view.cardFaces));
      if (isGM) {
        const actionsSlot = el(doc, 'div', 'gw-combat-combatant__actions');
        const menu = iconButton('tracker.actions', 'more', () => actions(entry), locked); menu.className = 'gw-combat-menu__trigger'; actionsSlot.append(menu); row.append(actionsSlot);
      }
      list.append(row);
    }
    if (focused?.action) {
      const scope = focused.id ? [...shell.querySelectorAll('[data-gws-combatant]')].find(row => row.dataset.gwsCombatant === focused.id) : shell;
      const lifecycleAction = { 'tracker.start': 'tracker.pause', 'tracker.pause': 'tracker.resume', 'tracker.resume': 'tracker.pause', 'tracker.stop': 'tracker.start' }[focused.action];
      const nodes = [...(scope?.querySelectorAll('[data-gws-tracker-action]') ?? [])];
      (nodes.find(node => node.dataset.gwsTrackerAction === focused.action && !node.disabled)
        ?? nodes.find(node => node.dataset.gwsTrackerAction === lifecycleAction && !node.disabled))?.focus();
    }
  }
  async function deckSettings() {
    const modal = openModal(api, doc, () => t('tracker.configureDeck'), signal, () => t('common.close'));
    attachModal(modal, 'tracker.configureDeck');
    const body = el(doc, 'div', 'gws-modal-body'), footer = el(doc, 'footer', 'gws-modal-footer'); modal.append(body, footer);
    body.append(el(doc, 'p', 'gws-field-hint', () => t('tracker.deckHint')));
    const fresh = await controller.refresh(); view = fresh;
    if (fresh.state.active) body.append(el(doc, 'p', 'gws-tracker-phase', () => t('tracker.activeDeckLocked')));
    const decks = fresh.decks || [];
    for (const deck of decks) {
      const row = el(doc, 'div', 'gws-tracker-choice');
      const choose = modalButton('tracker.selectDeck', async () => { await controller.selectDeck(deck.id); modal.close(); });
      choose.dataset.gwsTrackerUnavailable = String(fresh.state.active); choose.disabled = busy || fresh.state.active;
      row.append(el(doc, 'strong', '', deck.name), choose); body.append(row);
    }
    if (!decks.length) body.append(el(doc, 'p', '', () => t('tracker.noDecks')));
    const close = el(doc, 'button', 'gws-button', () => t('common.close')); close.type = 'button'; close.onclick = () => modal.close(); footer.append(close);
  }
  async function gmBennies() {
    const modal = openModal(api, doc, () => t('tracker.gmBennies'), signal, () => t('common.close'));
    attachModal(modal, 'tracker.gmBennies'); modal.dataset.gwsPauseAllowed = 'true';
    const body = el(doc, 'div', 'gws-modal-body'), count = el(doc, 'output', 'gws-gm-benny-value', String(bennyCount(view.tracker.gmBennies)));
    count.setAttribute('aria-live', 'polite'); body.append(el(doc, 'p', 'gws-field-hint', () => t('tracker.gmBennyHint')), count); modal.append(body);
    let remove;
    const adjust = delta => async () => {
      const fresh = await controller.adjustGMBennies(delta); count.textContent = String(bennyCount(fresh.tracker.gmBennies));
      remove.dataset.gwsTrackerUnavailable = String(!bennyCount(fresh.tracker.gmBennies));
    };
    const cannotRemove = !bennyCount(view.tracker.gmBennies);
    remove = modalButton('tracker.gmBennyRemove', adjust(-1), true); remove.disabled = busy || cannotRemove;
    remove.dataset.gwsTrackerUnavailable = String(cannotRemove);
    body.append(remove, modalButton('tracker.gmBennyAdd', adjust(1), true));
    const footer = el(doc, 'footer', 'gws-modal-footer'), close = el(doc, 'button', 'gws-button', () => t('common.close')); close.type = 'button'; close.onclick = () => modal.close(); footer.append(close); body.append(footer);
  }
  async function add() {
    const modal = openModal(api, doc, () => t('tracker.add'), signal, () => t('common.close'));
    attachModal(modal, 'tracker.add');
    const body = el(doc, 'div', 'gws-modal-body'), footer = el(doc, 'footer', 'gws-modal-footer'); modal.append(body, footer);
    body.append(el(doc, 'p', '', () => t('common.loading')));
    const tokens = await api.tokens.list({ sceneId: context.sceneId }); body.replaceChildren();
    for (const token of tokens) {
      const control = modalButton('common.add', async () => { await controller.command('add', { tokenId: token.id }); control.dataset.gwsCommitted = 'true'; control.disabled = true; bindTranslation(control,'textContent',()=>t('sheet.added')); });
      if (view.state.combatants.some(entry => entry.token_id === token.id)) { control.dataset.gwsCommitted = 'true'; control.disabled = true; bindTranslation(control,'textContent',()=>t('sheet.added')); }
      const row = el(doc, 'div', 'gws-tracker-choice'); row.append(el(doc, 'span', '', token.name || token.token?.name || (() => t('actorType.npc'))), control); body.append(row);
    }
    if (!tokens.length) body.append(el(doc, 'p', '', () => t('tracker.noTokens')));
    const close = el(doc, 'button', 'gws-button', () => t('common.close')); close.type = 'button'; close.onclick = () => modal.close(); footer.append(close);
  }
  async function actions(entry) {
    const modal = openModal(api, doc, entry.name, signal, () => t('common.close')), body = el(doc, 'div', 'gws-modal-body'); modal.append(body);
    attachModal(modal, 'tracker.actions', entry.id);
    const view = await api.actors.sheet(entry.actor_id, sheetContext(entry));
    const tracker = controller.snapshot(), draw = modalButton('tracker.bennyCard', async () => { await controller.bennyCard(entry); modal.close(); });
    draw.dataset.gwsTrackerUnavailable = String(!tracker.state.active || tracker.tracker.phase !== 'ready' || !!tracker.tracker.operation);
    draw.disabled = busy || draw.dataset.gwsTrackerUnavailable === 'true'; body.append(draw);
    if (npcBennyTarget(view)) {
      const retrying = controller.snapshot().tracker.operation?.kind === 'gm-benny-grant';
      const available = bennyCount(view.data.resources?.bennies) === 0 && bennyCount(controller.snapshot().tracker.gmBennies) > 0;
      const grant = modalButton('tracker.grantGMBenny', async () => {
        await controller.spendGMBenny(entry); grant.dataset.gwsCommitted = 'true'; grant.disabled = true; bindTranslation(grant,'textContent',()=>t('tracker.gmBennyGranted'));
      });
      grant.disabled = busy || !retrying && !available;
      grant.dataset.gwsTrackerUnavailable = String(!retrying && !available);
      body.append(el(doc, 'p', 'gws-field-hint', () => t('tracker.gmBennyHint')), grant);
    }
    for (const [key, task] of [['tracker.setTurn', () => controller.command('setTurn', identity(entry))],
      [view.data.status?.holding ? 'tracker.release' : 'tracker.hold', () => controller.hold(entry, !view.data.status?.holding)],
      [entry.hidden ? 'tracker.reveal' : 'tracker.hide', () => controller.command('toggle', { ...identity(entry), hidden: !entry.hidden })],
      [entry.defeated ? 'tracker.restore' : 'tracker.defeat', () => controller.command('toggle', { ...identity(entry), defeated: !entry.defeated })],
      ['tracker.remove', () => controller.command('remove', identity(entry))]]) {
      body.append(modalButton(key, async () => { await task(); modal.close(); }));
    }
  }
  function attachModal(modal, action, id) {
    currentModal = modal; modal.classList.add('gws-tracker-modal');
    modal.addEventListener('gravewright:sheet-flush', event => event.detail?.waitUntil?.(Promise.all([...pending])), { signal });
    modal.addEventListener('close', () => {
      if (currentModal === modal) currentModal = null;
      queueMicrotask(() => {
        const scope = id ? [...shell.querySelectorAll('[data-gws-combatant]')].find(row => row.dataset.gwsCombatant === id) : shell;
        [...(scope?.querySelectorAll('[data-gws-tracker-action]') ?? [])].find(node => node.dataset.gwsTrackerAction === action)?.focus();
      });
    }, { once: true });
  }
  view = await controller.refresh(); render();
  let synchronizing = false, nativeChanged = false;
  const needsDeal = () => !view.paused && view.isGM && view.state.active
    && (view.tracker?.round !== view.state.round || view.tracker?.encounterId !== view.state.encounterId);
  async function synchronize() {
    if (disposed || busy || synchronizing) return;
    synchronizing = true;
    synchronization = (async () => {
      try {
        const readNative = nativeChanged; nativeChanged = false;
        const current = await (readNative ? controller.refresh() : controller.syncPublic());
        if (disposed || busy) { nativeChanged ||= readNative; return; }
        if (JSON.stringify(view) !== JSON.stringify(current)) { view = current; render(); }
        if (!failure && needsDeal()) void run(controller.dealRound);
      } catch { nativeChanged = true; /* Retry synchronization after a transient transport failure. */ }
      finally { synchronizing = false; }
    })();
    await synchronization;
  }
  const unsubscribe = api.events.on('combat.changed', () => { nativeChanged = true; void synchronize(); });
  const unsubscribeCards = api.events.on('cards.changed', () => { nativeChanged = true; void synchronize(); });
  const unsubscribeSettings = system.settings?.subscribe(() => { nativeChanged = true; void synchronize(); });
  const unsubscribeLanguage = system.subscribeLanguage?.(() => {refreshTranslations(shell);if(currentModal?.isConnected)refreshTranslations(currentModal);});
  // Persistent table storage has no change event. Poll only while this surface
  // is mounted so existing players and other GM clients also receive the pause.
  const poll = setInterval(() => { if (!doc.hidden) void synchronize(); }, 2000);
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) { nativeChanged = true; void synchronize(); } }, { signal });
  doc.defaultView?.addEventListener('focus', () => { nativeChanged = true; void synchronize(); }, { signal });
  block.onDispose(() => { disposed = true; clearInterval(poll); unsubscribe(); unsubscribeCards(); unsubscribeSettings?.(); unsubscribeLanguage?.(); shell.remove(); });
  if (needsDeal()) void run(controller.dealRound);
  return controller;
}
