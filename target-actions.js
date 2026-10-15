/** Permission-scoped support, Tests and healing; all documents use native APIs. */
import {ATTRIBUTES, cloneData, createItemSheet, normalizeSheet} from './model.js';
import {healingResult, testResult} from './combat.js';
import {DOCUMENT_NAME_MAX, el, bindTranslation, bindNameOrder} from './ui.js';
import {searchText, alphabeticalRows} from './workflow.js';

const error = (code, message) => Object.assign(new Error(message || code), {code});
const options = signal => signal ? {signal} : {};

/** Keep the exact transformed target and receipt across a lost save response. */
export function createTargetWriteWorkflow({api, actorId, tokenId = null, transform, signal}) {
  const requestId = globalThis.crypto.randomUUID();
  let snapshot, result, pending, completed = false, frozenOutcome;
  function run(outcome) {
    if (completed) return Promise.resolve(result);
    if (pending) return pending;
    frozenOutcome ??= cloneData(outcome);
    pending = (async () => {
      if (signal?.aborted) throw error('cancelled');
      if (!snapshot) {
        const current = await api.actors.sheet(actorId, tokenId ? {tokenId} : {}, options(signal));
        if (signal?.aborted) throw error('cancelled');
        if (current.canEdit !== true) throw error('forbidden');
        const data = transform(cloneData(current.data), cloneData(frozenOutcome));
        if (data === null) {completed = true; result = {unchanged: true, actorId, tokenId}; return result;}
        snapshot = {actorId, tokenId, name: current.name, version: current.version, sheetVersion: current.sheetVersion, data};
      }
      const saved = await api.actors.saveSheet(cloneData(snapshot), {...options(signal), requestId});
      result = {...cloneData(snapshot), ...saved}; completed = true; return result;
    })().finally(() => {pending = undefined;});
    return pending;
  }
  return {run, get pending() {return !!pending;}, get completed() {return completed;}};
}

/** Numeric support entries are generated from outcomes, never a named catalog. */
export function applySupport(value, outcome, target, {name = '', sourceActorId = '', sourceTokenId = ''} = {}) {
  if (!outcome.success && !outcome.critical) return null;
  const sheet = normalizeSheet(value);
  const current = sheet.effects.filter(row => row.active !== false && row.data?.active === true && row.data?.category === 'support')
    .flatMap(row => row.data.modifiers || []).filter(modifier => modifier.target === target && modifier.enabled !== false)
    .reduce((total, modifier) => total + (Number(modifier.value) || 0), 0);
  const wanted = outcome.critical ? -2 : outcome.raises > 0 ? 2 : 1;
  const bonus = wanted < 0 || target === 'attribute.strength' ? wanted : Math.max(0, Math.min(wanted, 4 - current));
  if (bonus === 0) return null;
  const data = {...createItemSheet('effect'), category: 'support', active: true, remaining: 1, phase: 'end', owner: 'self',
    modifiers: [{target, value: bonus, mode: 'add', enabled: true}], sourceActorId, sourceTokenId};
  sheet.effects.push({id: globalThis.crypto.randomUUID(), sourceId: '', type: 'effect', name: name.slice(0, DOCUMENT_NAME_MAX), img: '', data, quantity: 1, equipped: false, prepared: false});
  return sheet;
}

export function targetActions(env) {
  const {doc, api, context, signal, t, modal, button, canEdit, getSheet, getName, flush, trait} = env;
  const label = key => t(`target.${key}`);
  const skillChoices = (sheet, healing = false) => alphabeticalRows(sheet.skills.filter(row => !healing || row.data.role === 'healing'),api.i18n?.locale)
    .map(row => [`skill.${row.id}`, row.name || t('item.untitled')]);
  const attributeChoices = () => ATTRIBUTES.map(({id, labelKey}) => [`attribute.${id}`, () => t(labelKey)]);
  function ownedChoices(sheet, {healing = false, testing = false} = {}) {
    const skills = skillChoices(sheet, healing);
    if (healing) return [...skills, ['untrained', () => t('rules.untrained')]];
    if (testing) return [...skills, ['untrained', () => t('rules.untrained')]];
    return [...attributeChoices(), ...skills];
  }
  function resolve(value) {
    const sheet = getSheet();
    if (value.startsWith('attribute.')) {
      const attribute = value.slice('attribute.'.length); return {trait: sheet.attributes[attribute], attribute};
    }
    const row = sheet.skills.find(entry => `skill.${entry.id}` === value);
    return row ? {trait: row.data, attribute: row.data.attribute, role: row.data.role, skillId: row.id, untrained: row.data.untrained}
      : {trait: {die: 4, modifier: 0, untrained: true}, untrained: true, attribute: 'smarts', role: ''};
  }
  function checkbox(body, key) {
    const field = el(doc, 'label', 'gws-field gws-item-checkbox'), input = el(doc, 'input'); input.type = 'checkbox';
    bindTranslation(input, 'aria-label', () => label(key)); input.dataset.gwsTargetOption = key; field.append(el(doc, 'span', '', () => label(key)), input); body.append(field); return input;
  }
  function targetPicker(kind) {
    if (!canEdit() || signal?.aborted) return;
    const node = modal( () => label(kind)), body = el(doc, 'div', 'gws-modal-body'); node.dataset.gwsTargetAction = kind;
    const search = el(doc, 'input'); search.type = 'search'; bindTranslation(search, 'placeholder', () => label('search')); bindTranslation(search, 'aria-label', () => label('search'));
    const message = el(doc, 'p', 'gws-picker-status'), notice = el(doc, 'p', 'gws-notice'); message.setAttribute('role', 'status'); notice.setAttribute('role', 'alert'); notice.hidden = true;
    const list = el(doc, 'div', 'gws-picker'), detail = el(doc, 'div', 'gws-rule-grid');
    const supportTarget = el(doc, 'select'); bindTranslation(supportTarget, 'aria-label', () => label('targetTrait')); supportTarget.dataset.gwsTargetOption = 'targetTrait';
    const supportField = el(doc, 'label', 'gws-field'); supportField.hidden = true;
    const supportName = el(doc, 'span'); supportField.append(supportName, supportTarget, el(doc, 'span', 'gws-field-hint', () => label('supportTraitHint')));
    const start = button( () => label('startRoll'), () => choose(selectedEntry, true)); start.hidden = true; start.dataset.gwsTargetStart = 'true';
    if (kind === 'support') detail.append(supportField, start);
    const state = el(doc, 'select'); bindTranslation(state, 'aria-label', () => label('testState')); state.dataset.gwsTargetOption = 'testState';
    for (const value of ['distracted', 'vulnerable']) {const choice = el(doc, 'option', '', () => t(`status.${value}`)); choice.value = value; state.append(choice);}
    const defender = el(doc, 'input'); defender.type = 'number'; defender.step = 'any'; defender.value = '4'; bindTranslation(defender, 'aria-label', () => label('defenderTotal')); defender.dataset.gwsTargetOption = 'defenderTotal';
    if (kind === 'test') {
      const stateField = el(doc, 'label', 'gws-field'), defenderField = el(doc, 'label', 'gws-field');
      stateField.append(el(doc, 'span', '', () => label('testState')), state); defenderField.append(el(doc, 'span', '', () => label('defenderTotal')), defender);
      detail.append(stateField, defenderField, el(doc, 'p', 'gws-field-hint', () => label('opposedHint')));
    }
    let hour, attempt, kit;
    if (kind === 'heal') {hour = checkbox(detail, 'goldenHourConfirm'); attempt = checkbox(detail, 'healingAttemptConfirm'); kit = checkbox(detail, 'kitAvailable');}
    if (kind === 'stabilize') kit = checkbox(detail, 'kitAvailable');
    const gmSupport = kind === 'support' && context.role !== 'gm';
    if (gmSupport) detail.append(el(doc, 'p', 'gws-field-hint', () => label('gmSupportHint')));
    body.append(el(doc, 'p', 'gws-field-hint', () => t('target.sourceHint', {name: getName()})), search, detail, notice, message, list,
      button( () => t('common.cancel'), () => node.close())); node.append(body);
    let entries = [], selectedEntry, reading, closingDuringRead = false, loading = false;
    node.addEventListener('gravewright:sheet-flush', event => {
      if (reading) {closingDuringRead = true; event.detail.waitUntil(reading);}
    });
    function showError(failure) {
      if (signal?.aborted || !node.isConnected) return;
      bindTranslation(notice, 'textContent', () => t(failure.code === 'conflict' ? 'target.targetChanged' : failure.code === 'forbidden' ? 'target.readOnlyTarget' : 'target.loadError')); notice.hidden = false;
    }
    async function choose(entry, ready = false) {
      if (reading || !entry) return;
      closingDuringRead = false;
      notice.hidden = true;
      if (kind === 'heal' && (!hour.checked || !attempt.checked)) {
        bindTranslation(notice, 'textContent', () => label(!hour.checked ? 'goldenHourRequired' : 'healingAttemptRequired')); notice.hidden = false;
        (!hour.checked ? hour : attempt).focus(); return;
      }
      if (kind === 'test' && (!defender.validity.valid || !Number.isFinite(Number(defender.value)) || defender.value === '')) {
        bindTranslation(notice, 'textContent', () => t('item.numberInvalid')); notice.hidden = false; defender.focus(); return;
      }
      let selected;
      try {
        reading = (async () => {
          await flush();
          return api.actors.sheet(entry.actorId, entry.tokenId ? {tokenId: entry.tokenId} : {}, options(signal));
        })();
        selected = await reading;
        if (signal?.aborted || !node.isConnected || closingDuringRead) return;
        if (!gmSupport && selected.canEdit !== true) throw error('forbidden');
      } catch (failure) {showError(failure); return;}
      finally {reading = undefined;}
      if (kind === 'support') {
        const targetChoices = [...attributeChoices(), ...skillChoices(normalizeSheet(selected.data))];
        if (!ready) {
          selectedEntry = entry; supportTarget.replaceChildren();
          for (const [value, text] of targetChoices) {const option = el(doc, 'option', '', text); option.value = value;if(value.startsWith('skill.'))option.dataset.gwsSortName=option.textContent;supportTarget.append(option);}
          bindNameOrder(supportTarget,()=>api.i18n?.locale);
          bindTranslation(supportName, 'textContent', () => `${label('targetTrait')} · ${selected.name}`);
          supportField.hidden = false; start.hidden = false; supportTarget.focus(); return;
        }
        if (!targetChoices.some(([value]) => value === supportTarget.value)) {
          bindTranslation(notice, 'textContent', () => label('targetChanged')); notice.hidden = false; return;
        }
      }
      const target = {actorId: entry.actorId, tokenId: selected.tokenId || null};
      const own = getSheet(), healing = kind === 'heal' || kind === 'stabilize', choices = ownedChoices(own, {healing, testing: kind === 'test' || kind === 'support'});
      const healingSkill = own.skills.find(row => row.data.role === 'healing');
      const initial = healing ? healingSkill ? `skill.${healingSkill.id}` : 'untrained' : choices[0][0];
      const bonusTarget = kind === 'support' ? supportTarget.value : '', stateChoice = state.value;
      const transform = (data, outcome) => {
        if (kind === 'support') return applySupport(data, outcome, bonusTarget, {name: t('target.supportEffectName', {name: getName()}), sourceActorId: context.actorId, sourceTokenId: context.tokenId || ''});
        let next;
        if (kind === 'test') next = outcome.success && !outcome.critical ? testResult(data, outcome, stateChoice) : null;
        else if (kind === 'stabilize') next = outcome.success && !outcome.critical ? healingResult(data, outcome, {stabilization: true}) : null;
        else next = outcome.critical || outcome.success && Number(data.resources?.wounds) > 0 ? healingResult(data, outcome) : null;
        // Native active effects are GM controlled. Healing and Tests never
        // rewrite their shape through sheet normalization, even for legacy data.
        if (next && Object.hasOwn(data, 'effects')) next.effects = cloneData(data.effects);
        return next;
      };
      const workflow = createTargetWriteWorkflow({api, ...target, transform, signal});
      const applyResult = gmSupport ? undefined : async outcome => {
        await flush(); const saved = await workflow.run(outcome);
        if (!saved.unchanged) await env.onTargetSaved?.(saved);
      };
      await node.close();
      if (signal?.aborted || node.isConnected) return;
      const initialValue = resolve(initial), resolver = value => ({...resolve(value), ...(healing ? {role: 'healing'} : {})});
      const action = trait(initialValue.trait, {label: `${label(kind)} · ${selected.name}`, labelText: () => `${label(kind)} · ${selected.name}`, ...initialValue, ...(healing ? {role: 'healing'} : {}), options: choices, selected: initial, resolve: resolver,
        opposed: kind === 'test', target: kind === 'test' ? Number(defender.value) : 4, modifier: healing && !kit.checked ? -1 : 0, applyResult});
      if (gmSupport) action?.querySelector('.gws-modal-body')?.prepend(el(doc, 'p', 'gws-field-hint', () => label('gmSupportHint')));
    }
    function draw() {
      list.replaceChildren(); const query = searchText(search.value), filtered = entries.filter(entry => searchText(entry.name).includes(query));
      if (!filtered.length) list.append(el(doc, 'p', 'gws-empty', () => label('noTargets')));
      for (const entry of filtered) {
        const row = el(doc, 'div', 'gws-picker-row'); row.dataset.gwsTargetKey = entry.key;
        const identity = el(doc, 'div', 'gws-picker-identity'); identity.append(el(doc, 'strong', '', entry.name), el(doc, 'span', '', () => label(entry.tokenId ? 'tokenTarget' : 'actorTarget')));
        row.append(identity, button( () => label('select'), () => choose(entry))); list.append(row);
      }
    }
    async function load() {
      if (loading) return;
      loading = true; notice.hidden = true; bindTranslation(message, 'textContent', () => label('loading')); list.setAttribute('aria-busy', 'true');
      try {
        const [actors, tokens] = await Promise.allSettled([api.actors.list({}, options(signal)),
          context.sceneId && api.tokens?.list ? api.tokens.list({sceneId: context.sceneId}, options(signal)) : Promise.resolve([])]);
        if (actors.status === 'rejected') throw actors.reason;
        if (signal?.aborted || !node.isConnected) return;
        entries = actors.value.filter(actor => actor.canOpen === true && (gmSupport || actor.canEdit === true)).map(actor => ({key: `actor:${actor.id}`, actorId: actor.id, tokenId: null, name: actor.name}));
        if (tokens.status === 'fulfilled') for (const token of tokens.value) {
          if (token.linkMode !== 'snapshot' || !(gmSupport ? token.canControl || token.canOpenSheet : token.canControl)) continue;
          entries.push({key: `token:${token.id}`, actorId: token.actorId, tokenId: token.id, name: token.name || t('item.untitled')});
        }
        message.textContent = ''; draw();
      } catch (failure) {
        showError(failure); message.textContent = ''; list.replaceChildren(button( () => t('common.retry'), load));
      } finally {loading = false; list.removeAttribute('aria-busy');}
    }
    search.addEventListener('input', () => {if (!loading) draw();}, options(signal));
    void load(); return node;
  }
  return Object.fromEntries(['support', 'test', 'heal', 'stabilize'].map(kind => [kind, () => targetPicker(kind)]));
}
