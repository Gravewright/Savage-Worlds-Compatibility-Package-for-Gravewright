import {ATTRIBUTES, ITEM_TYPES, RESOURCE_LIMITS, createSheet, createItemSheet, normalizeSheet, normalizeItemSheet, itemToRow, collectionForType, canonicalItemType} from './model.js';
import {itemEditor, itemImageUrl} from './item-editor.js';
import {createSaveQueue} from './persistence.js';
import {DOCUMENT_NAME_MAX, el, icon, get, set, openModal, bindTranslation, refreshTranslations} from './ui.js';
import {createItemWorkflow, createCopyWorkflow, searchText} from './workflow.js';
import {derive, validateProgressLedger,traitValue,stepTrait} from './mechanics.js';
import {actorActions} from './actor-actions.js';
import {applyState, spendBenny, applyFatigue, woundCapacity} from './combat.js';
import {effectiveRules, currencyLabel} from './settings.js';

const DICE = [4, 6, 8, 10, 12];
const PHYSICAL = ['weapon', 'armor', 'equipment', 'consumable', 'vehicle', 'arcane-device'];
let sequence = 0;

export async function mountActorSheet(block, system = {}) {
  const {root, context, api, signal} = block, doc = root.ownerDocument;
  const t = (key, params) => api.i18n.t(key, params);
  let view = await api.actors.sheet(context.actorId, context.tokenId ? {tokenId: context.tokenId} : {});
  if (signal.aborted) return;
  const initial = view.data && Object.keys(view.data).length ? view.data : createSheet({actorType:view.actorType});
  if ((!view.data || !Object.keys(view.data).length) && view.actorType === 'npc') initial.profile.kind = 'extra';
  let draft = normalizeSheet(initial), name = view.name, tab = 'overview', uploading = false, refreshing = false;
  const browsers = new Map();
  const work = new Set(), modals = new Set(), editors = new Set(), prefix = `gws-${++sequence}`;
  const shell = el(doc, 'form', 'gws-sheet'), notice = el(doc, 'p', 'gws-notice');
  shell.setAttribute('translate', 'no'); shell.noValidate = true; shell.onsubmit = event => event.preventDefault();
  notice.setAttribute('role', 'alert'); notice.hidden = true; root.replaceChildren(shell);
  let saveState = 'saved', queue, actionSource, settingsPending=false, refreshingSettings=false;
  const canEdit = () => view.canEdit === true && !uploading;
  const getRules = () => effectiveRules(draft,system.settings?.current);
  function status(state) {
    saveState = state;
    for (const node of shell.querySelectorAll('.gws-save-status')) {
      node.dataset.state = view.canEdit ? state : 'readonly';
      bindTranslation(node, 'textContent', () => t(view.canEdit ? `common.${state === 'error' ? 'saveError' : state}` : 'common.readOnly'));
    }
    const retry = shell.querySelector('[data-gws-retry]'); if (retry) retry.hidden = state !== 'error' || queue?.conflicted;
  }
  function report(error) {
    if (signal.aborted) return;
    bindTranslation(notice, 'textContent', () => t(error.code === 'conflict' ? 'common.conflict' : 'common.saveError')); notice.hidden = false;
    const activeModal=[...modals].at(-1),active=failureHandled(error) || activeModal?.dataset.gwsActionPending==='true'?null:activeModal?.querySelector('.gws-modal-notice');
    if (active) {bindTranslation(active,'textContent',()=>t(error.code === 'conflict' ? 'common.conflict' : 'common.saveError')); active.hidden = false;}
    if (error.code === 'conflict') render();
  }
  queue = createSaveQueue({signal, read: () => ({name, data: draft}), onState: status, onError: report,
    write: async (snapshot,options) => {
      const result = await api.actors.saveSheet({actorId: context.actorId, tokenId: context.tokenId || null,
        name: snapshot.name, data: snapshot.data, version: view.version, sheetVersion: view.sheetVersion},{...options,signal});
      view = {...view, ...result}; notice.hidden = true;
    }});
  function failureHandled(error){return error.gwsHandled===true;}
  function changed(path, value) {if (!canEdit()) return; if (path === 'core.name') name = String(value); else set(draft, path, value); queue.mark();}
  async function replaceSheet(value) {if (!canEdit()) return;draft=normalizeSheet(value);queue.mark();render();await queue.flush();}
  const actions = actorActions({doc,api,context,signal,t,modal,button,canEdit,getSheet:()=>draft,getRules,getName:()=>name,replaceSheet,flush:()=>queue.flush(),onTargetSaved:async saved=>{
    if(saved.actorId!==context.actorId || signal.aborted)return;
    view=await api.actors.sheet(context.actorId,context.tokenId?{tokenId:context.tokenId}:{});draft=normalizeSheet(view.data);name=view.name;render();
  }});
  const ruleActions=actions;
  async function tracked(run, source) {
    const task = Promise.resolve().then(() => {
      const previous = actionSource; actionSource = source;
      try {return run();} finally {actionSource = previous;}
    }); work.add(task);
    try {return await task;} catch (error) {report(error); throw error;} finally {work.delete(task);if(settingsPending)void refreshSettings();}
  }
  function button(label, run, disabled = false, className = '') {
    const node = el(doc, 'button', `gws-button ${className}`, label); node.type = 'button'; node.disabled = disabled;
    node.onclick = () => {node.disabled = true; node.setAttribute('aria-busy', 'true'); void tracked(run, node).catch(() => {}).finally(() => {if (node.isConnected) {node.disabled = disabled || uploading || node.dataset.gwsActionLocked==='true' || node.dataset.gwsTemporarilyDisabled==='true'; node.removeAttribute('aria-busy');}});};
    return node;
  }
  function iconButton(label, glyph, run, disabled = false) {
    const node = button('', run, disabled, 'gws-icon-button'); node.append(icon(doc, glyph)); bindTranslation(node, 'aria-label', label); bindTranslation(node, 'title', label); return node;
  }
  function field(path, label, options = {}) {
    const wrap = el(doc, 'label', `gws-field ${options.className || ''}`), caption = el(doc, 'span', '', label);
    const input = el(doc, options.area ? 'textarea' : 'input');
    if (!options.area) input.type = options.number ? 'number' : 'text';
    input.value = String((path === 'core.name' ? name : get(draft, path)) ?? '');
    input.dataset.gwsPath = path; bindTranslation(input, 'aria-label', label); input.readOnly = !canEdit();
    if (options.placeholder) bindTranslation(input, 'placeholder', options.placeholder);
    if (options.number) {input.step = 'any'; if (options.min !== undefined) input.min = String(options.min);}
    if (options.maxLength) input.maxLength = options.maxLength;
    input.oninput = () => changed(path, options.number && input.value !== '' ? Number(input.value) : input.value);
    wrap.append(caption, input); return wrap;
  }
  function choice(path,label,values) {
    const wrap=el(doc,'label','gws-field'),control=el(doc,'select');wrap.append(el(doc,'span','',label),control);
    for (const [id,text] of values) {const option=el(doc,'option','',text);option.value=id;control.append(option);}
    control.value=String(get(draft,path) ?? '');control.disabled=!canEdit();bindTranslation(control,'aria-label',label);control.dataset.gwsPath=path;
    control.onchange=()=>{changed(path,control.value);};return wrap;
  }
  function toggle(path,label) {
    const wrap=el(doc,'label','gws-field gws-item-checkbox'),control=el(doc,'input');control.type='checkbox';control.checked=get(draft,path)===true;
    control.disabled=!canEdit();bindTranslation(control,'aria-label',label);control.dataset.gwsPath=path;wrap.append(el(doc,'span','',label),control);
    control.onchange=()=>{changed(path,control.checked);};return wrap;
  }
  function ruleChoice(key,label) {
    const path=`rules.${key}`,override=draft.rules?.[key],wrap=choice(path,label,[['inherit', () => t('settings.inherit')],['true', () => t('settings.on')],['false', () => t('settings.off')]]);
    const control=wrap.querySelector('select');control.value=typeof override==='boolean'?String(override):'inherit';
    control.onchange=()=>{
      if(!canEdit())return;
      if(!draft.rules || typeof draft.rules!=='object' || Array.isArray(draft.rules))draft.rules={};
      if(control.value==='inherit')delete draft.rules[key];else draft.rules[key]=control.value==='true';queue.mark();
    };return wrap;
  }
  const section = (label, className = '') => {const node = el(doc, 'section', `gws-section ${className}`); node.append(el(doc, 'h3', '', label)); return node;};
  function modal(title) {
    const opener = actionSource || doc.activeElement, entryId = opener?.closest('[data-entry-id]')?.dataset.entryId;
    const label = opener?.getAttribute('aria-label') || opener?.textContent, path = opener?.dataset.gwsPath;
    const node = openModal(api, doc, title, signal, () => t('common.close')); modals.add(node);
    const message = el(doc, 'p', 'gws-notice gws-modal-notice'); message.setAttribute('role', 'alert'); message.hidden = true; node.append(message);
    // A conflict blocks closing the actor, but its editor may close so the
    // user can reach Reload without discarding the actor's unsaved draft.
    node.addEventListener('gravewright:sheet-flush', event => event.detail.waitUntil(queue.conflicted ? Promise.resolve() : queue.flush()));
    node.addEventListener('close', () => {
      modals.delete(node); render();
      queueMicrotask(() => {
        if (signal.aborted) return;
        const scope = entryId ? [...shell.querySelectorAll('[data-entry-id]')].find(row => row.dataset.entryId === entryId) : shell;
        const replacement = [...scope?.querySelectorAll('button,input,select,textarea') || []].find(control => path ? control.dataset.gwsPath === path : (control.getAttribute('aria-label') || control.textContent) === label)
          || shell.querySelector('[role=tab][aria-selected=true]');
        if (replacement && !replacement.closest('[inert]') && !replacement.disabled) replacement.focus();
      });
    }, {once: true}); return node;
  }
  async function upload(kind, file) {
    if (!file || !canEdit()) return;
    await queue.flush(); uploading = true; render();
    try {
      await block.host.call('actor.image.upload', {id: context.actorId, kind, file});
      view = await api.actors.sheet(context.actorId, context.tokenId ? {tokenId: context.tokenId} : {});
      draft = normalizeSheet(view.data); name = view.name;
    } finally {uploading = false; render();}
  }
  function imageUpload(kind, label) {
    const input = el(doc, 'input', 'gws-file-input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.disabled = !canEdit();
    bindTranslation(input, 'aria-label', label); input.onchange = () => {const file = input.files?.[0]; void tracked(() => upload(kind, file)).catch(() => {});}; return input;
  }
  function header() {
    const node = el(doc, 'header', 'gws-header'), portrait = el(doc, 'label', 'gws-portrait');
    const source = itemImageUrl(view.portraitUrl || view.tokenUrl, doc.baseURI);
    if (source) {const image = el(doc, 'img'); image.src = source; bindTranslation(image, 'alt', () => t('sheet.portrait')); portrait.append(image);}
    else portrait.append(icon(doc, 'image'), el(doc, 'span', '', () => t('sheet.uploadPortrait')));
    portrait.append(imageUpload('portrait', () => t('sheet.uploadPortrait'))); node.append(portrait);
    const identity = el(doc, 'div', 'gws-identity'), brand = el(doc, 'div', 'gws-brand', 'SWADE');
    const nameField = field('core.name', () => t('common.name'), {className: 'gws-name', maxLength: DOCUMENT_NAME_MAX, placeholder: () => t('sheet.namePlaceholder')});
    const fields = el(doc, 'div', 'gws-identity-fields');
    for (const key of ['concept', 'rank', 'advances']) {
      const current=field(`identity.${key}`, () => t(`identity.${key}`),key==='advances'?{number:true,min:0}:{});
      if(key==='rank' && draft.calculation.automatic){const input=current.querySelector('input'),rank=derive(draft,{rules:getRules()}).rank;bindTranslation(input,'value',()=>['novice','seasoned','veteran','heroic','legendary'].includes(rank)?t(`rules.rank.${rank}`):rank);input.readOnly=true;}
      fields.append(current);
    }
    identity.append(brand, nameField, fields); node.append(identity);
    const stats = el(doc, 'div', 'gws-header-stats');
    for (const [key, glyph] of [['pace', 'boot'], ['parry', 'shield'], ['toughness', 'heart']]) {
      const stat = el(doc, 'label', 'gws-stat'); stat.append(el(doc, 'span', '', () => t(`stat.${key}`)), icon(doc, glyph));
      const input = el(doc, 'input'); input.type = 'number'; input.step = 'any'; input.placeholder = '—'; input.value = draft.stats[key];
      input.dataset.gwsPath = `stats.${key}`; bindTranslation(input, 'aria-label', () => t(`stat.${key}`)); input.readOnly = !canEdit();
      if(draft.calculation.automatic)input.value=derive(draft,{rules:getRules()})[key];
      input.oninput = () => changed(draft.calculation.automatic?`overrides.${key}`:`stats.${key}`, input.value === '' ? draft.calculation.automatic?null:'':Number(input.value));
      stat.append(input);
      if(key==='toughness')stat.append(el(doc,'small','gws-stat-armor', () => `${t('stat.armor')}: ${derive(draft,{rules:getRules()}).armor}`));
      stats.append(stat);
    }
    node.append(stats); return node;
  }
  function adjustAttribute(id, direction) {
    const next=stepTrait(draft.attributes[id],direction);changed(`attributes.${id}.die`,next.die);changed(`attributes.${id}.modifier`,next.modifier);
    render();
  }
  function editAttribute(id) {
    const node = modal(() => t('sheet.editAttribute', {name: t(`attribute.${id}`)})), body = el(doc, 'div', 'gws-modal-body');
    const wrap = el(doc, 'label', 'gws-field', () => t('common.die')), select = el(doc, 'select');
    const values = new Set([...DICE, draft.attributes[id].die]);
    for (const die of [...values].sort((a, b) => a - b)) {const option = el(doc, 'option', '', `d${die}`); option.value = String(die); select.append(option);}
    select.value = String(draft.attributes[id].die); select.disabled = !canEdit(); select.dataset.gwsPath = `attributes.${id}.die`;
    select.onchange = () => changed(`attributes.${id}.die`, Number(select.value)); wrap.append(select);
    body.append(wrap, field(`attributes.${id}.modifier`, () => t('common.modifier'), {number: true}));
    if(id==='strength')body.append(field('attributes.strength.fixedValue', () => t('rules.fixedStrength'),{number:true,min:1}));
    body.append(button( () => t('common.close'), () => node.close()));node.append(body);
  }
  function attributes() {
    const node = section( () => t('sheet.attributes'), 'gws-attributes'), grid = el(doc, 'div', 'gws-attribute-grid');
    for (const {id, labelKey} of ATTRIBUTES) {
      const card = el(doc, 'article', 'gws-attribute'); card.dataset.attribute = id;
      card.append(el(doc, 'h4', '', () => t(labelKey)));
      const dice = button('', () => actions.attribute(id), !canEdit(), 'gws-die'); bindTranslation(dice, 'aria-label', () => t('rules.rollAttribute', {name: t(labelKey)}));
      const value = traitValue(draft.attributes[id],{sheet:draft,attribute:id}), modifier = value.modifier ? (value.modifier > 0 ? `+${value.modifier}` : String(value.modifier)) : '';
      dice.dataset.die = String(value.die);
      if (modifier && value.fixedValue == null) dice.classList.add('gws-die-modified');
      dice.append(icon(doc, `d${value.die}`), el(doc, 'span', '', value.fixedValue!=null?String(value.fixedValue):`d${value.die}${modifier}`)); card.append(dice);
      const controls = el(doc, 'div', 'gws-attribute-controls');
      controls.append(button('−', () => adjustAttribute(id, -1), !canEdit(), 'gws-step'),iconButton( () => t('sheet.editAttribute',{name:t(labelKey)}),'edit',()=>editAttribute(id)), button('+', () => adjustAttribute(id, 1), !canEdit(), 'gws-step')); card.append(controls); grid.append(card);
    }
    node.append(grid); return node;
  }
  function resources() {
    const node = section( () => t('sheet.resources'), 'gws-resources');
    for (const [key, glyph] of [['bennies', 'coins'], ['wounds', 'wound'], ['fatigue', 'battery']]) {
      const row = el(doc, 'div', `gws-resource gws-resource-${key}`); row.dataset.resource = key;
      const label = el(doc, 'span', 'gws-resource-label', () => t(`resource.${key}`)); label.prepend(icon(doc, glyph)); row.append(label);
      const controls = el(doc, 'div', 'gws-resource-controls');
      if (key === 'bennies') {
        const input = field('resources.bennies', () => t('resource.bennies'), {number: true, min: 0}); input.classList.add('gws-compact-field');
        controls.append(button('−', () => {changed('resources.bennies', Math.max(0, draft.resources.bennies - 1)); render();}, !canEdit(), 'gws-step'), input,
          button('+', () => {changed('resources.bennies', Number(draft.resources.bennies) + 1); render();}, !canEdit(), 'gws-step'));
      } else {
        controls.setAttribute('role', 'group'); bindTranslation(controls, 'aria-label', () => t(`resource.${key}`));
        const capacity=key==='wounds'?woundCapacity(draft):RESOURCE_LIMITS[key];
        if(capacity===0)controls.append(el(doc,'small','gws-field-hint', () => t('rules.extraWounds')));
        for (let i = 1; i <= capacity; i++) {
          const active = draft.resources[key] >= i, pip = button('', () => {changed(`resources.${key}`, active ? i - 1 : i); render();}, !canEdit(), 'gws-pip');
          bindTranslation(pip, 'aria-label', () => `${t(`resource.${key}`)} ${i}`); pip.setAttribute('aria-pressed', String(active)); controls.append(pip);
        }
      }
      row.append(controls); node.append(row);
    }
    const conditions = el(doc, 'div', 'gws-conditions'); conditions.append(el(doc, 'span', '', () => t('sheet.conditions')));
    const chips = el(doc, 'div', 'gws-condition-chips');
    for (const key of ['shaken', 'vulnerable', 'distracted', 'stunned', 'prone', 'entangled', 'bound', 'incapacitated', 'bleedingOut', 'dead']) {
      const chip = button( () => t(`status.${key}`), () => replaceSheet(applyState(draft,key,!draft.status[key])), !canEdit(), `gws-condition gws-condition-${key}`);
      chip.setAttribute('aria-pressed', String(draft.status[key])); chips.append(chip);
    }
    conditions.append(chips);node.append(conditions);
    const recovery=el(doc,'div','gws-recovery-actions');
    for(const key of ['shaken','stunned','incapacitated','bleedingOut'])if(draft.status[key])recovery.append(button( () => t(`rules.recover.${key==='incapacitated'?'incapacitation':key==='bleedingOut'?'bleeding':key}`),()=>actions.recovery(key==='incapacitated'?'incapacitation':key==='bleedingOut'?'bleeding':key),!canEdit()));
    if(draft.status.shaken)recovery.append(button( () => t('rules.unshakeBenny'),()=>replaceSheet(spendBenny(draft,'unshake')),!canEdit() || draft.resources.bennies<1));
    if(draft.status.bound || draft.status.entangled)recovery.append(button( () => t('rules.escape'),actions.escape,!canEdit()));
    node.append(recovery);return node;
  }
  function appendItem(item) {
    if (!canEdit() || !canonicalItemType(item.type)) return;
    const collection = collectionForType(item.type), row = itemToRow(item);
    changed(collection, [...draft[collection], row]); render(); return row;
  }
  function updateItem(collection, id, callback) {
    if (!canEdit()) return;
    const rows = structuredClone(draft[collection]), row = rows.find(entry => entry.id === id); if (!row) return;
    callback(row); changed(collection, rows);
  }
  function editItem(collection, entry) {
    const node = modal( () => entry.name || t('item.untitled')), body = el(doc, 'div', 'gws-modal-body');
    body.append(el(doc, 'p', 'gws-field-hint', () => t('sheet.ownedCopyHint')));
    const row = () => draft[collection].find(candidate => candidate.id === entry.id);
    const editor = itemEditor({doc, t, type: entry.type, data: () => row()?.data || {}, name: () => row()?.name || '', canEdit: canEdit(), signal,skills:draft.skills,pools:draft.arcanePools,powers:draft.powers,
      onNameChange: value => updateItem(collection, entry.id, item => {item.name = value;}),
      changed: (path, value) => updateItem(collection, entry.id, item => {
        item.data[path] = value;
        if (path === 'quantity') item.quantity = value;
        if (path === 'equipped') item.equipped = value;
        if (path === 'img') item.img = value;
      })});
    node.addEventListener('gravewright:sheet-flush', event => {
      if (!editor.validate?.({focus: true})) event.detail.waitUntil(Promise.reject(new Error(t('common.saveError'))));
      else event.detail.waitUntil(queue.flush());
    });
    editors.add(editor); body.append(editor, button( () => t('common.done'), () => node.close())); node.append(body);
  }
  async function chooseItem(types) {
    const node = modal( () => t('sheet.itemLibrary')), body = el(doc, 'div', 'gws-modal-body'); node.dataset.gwsPicker = 'library'; node.append(body);
    const additions = new Set();
    node.addEventListener('gravewright:sheet-flush', event => event.detail.waitUntil((async () => {
      while (additions.size) await Promise.all([...additions]);
    })()));
    const toolbar = el(doc, 'div', 'gws-toolbar'), search = el(doc, 'input'); search.type = 'search'; bindTranslation(search, 'placeholder', () => t('common.search')); bindTranslation(search, 'aria-label', () => t('common.search'));
    const filter = el(doc, 'select'); bindTranslation(filter, 'aria-label', () => t('common.type')); filter.dataset.gwsFilter = 'library';
    const all = el(doc, 'option', '', () => t('sheet.allTypes')); all.value = ''; filter.append(all);
    for (const type of types) {const option = el(doc, 'option', '', () => t(`item.type.${type}`)); option.value = type; filter.append(option);}
    filter.hidden = types.length < 2;
    toolbar.append(search, filter);
    const createLabel = context.role === 'gm' ? 'sheet.createItem' : 'sheet.createOwned';
    if (canEdit()) toolbar.append(button( () => t(createLabel), async () => {await node.close(); if (!node.isConnected) createNativeItem(types);}, false));
    body.append(el(doc, 'p', 'gws-field-hint', () => t(context.role === 'gm' ? 'sheet.libraryHint' : 'sheet.createOwnedHint')), toolbar);
    const message = el(doc, 'p', 'gws-picker-status'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const list = el(doc, 'div', 'gws-picker'); body.append(message, list, button( () => t('common.done'), () => node.close()));
    let items = []; const operations=new Map();
    function draw() {
      list.replaceChildren(); const query = searchText(search.value);
      const selected = items.filter(item => searchText(item.name).includes(query) && (!filter.value || canonicalItemType(item.type) === filter.value));
      if (!selected.length) {
        const empty = el(doc, 'div', 'gws-empty-state'); empty.append(icon(doc, 'bag'), el(doc, 'strong', '', () => t(query || filter.value ? 'sheet.noSearchResults' : 'sheet.noNativeItems')),
          el(doc, 'p', '', () => t(query || filter.value ? 'sheet.searchHint' : 'sheet.dropHint')));
        if (query || filter.value) empty.append(button( () => t('common.clear'), () => {search.value = filter.value = ''; draw(); search.focus();})); list.append(empty);
      }
      for (const item of selected) {
        const operation=operations.get(item.id);
        const owned = draft[collectionForType(item.type)].some(entry => entry.sourceId === item.id);
        const row = el(doc, 'div', 'gws-picker-row'); row.dataset.sourceId = item.id;
        const identity = el(doc, 'div', 'gws-picker-identity'); identity.append(el(doc, 'strong', '', item.name), el(doc, 'span', '', () => t(`item.type.${canonicalItemType(item.type)}`)));
        if (owned) identity.append(el(doc, 'small', 'gws-picker-owned', () => t('sheet.inSheet')));
        row.append(identity, button( () => t(operation?.failed?'common.retry':owned ? 'sheet.addCopy' : 'sheet.addToSheet'), async () => {
          let task=operations.get(item.id);
          if(!task){task=createCopyWorkflow({signal,read:async()=>{
            const current=await api.items.get(item.id);
            if(!current.canOpen || !types.includes(canonicalItemType(current.type)))throw new Error('permission_denied');return current;
          },append:appendItem,flush:()=>queue.flush()});operations.set(item.id,task);}
          const addition=task.run();additions.add(addition);draw();
          try{const current=await addition;operations.delete(item.id);bindTranslation(message, 'textContent', () => `${t('sheet.added')}: ${current.name}`);}
          finally{additions.delete(addition);if(node.isConnected)draw();}
        }, !canEdit() || operation?.pending)); list.append(row);
      }
    }
    async function load() {
      bindTranslation(message, 'textContent', () => t('sheet.libraryLoading')); list.replaceChildren(); list.setAttribute('aria-busy', 'true');
      try {
        const documents = await api.items.list(); if (signal.aborted || !node.isConnected) return;
        items = documents.filter(item => item.canOpen && types.includes(canonicalItemType(item.type)) && (!item.systemId || item.systemId === context.systemId));
        message.textContent = ''; draw();
      } catch {
        if (signal.aborted || !node.isConnected) return;
        bindTranslation(message, 'textContent', () => t('sheet.libraryError')); list.append(button( () => t('common.retry'), load));
      } finally {list.removeAttribute('aria-busy');}
    }
    search.oninput = draw; filter.onchange = draw; await load();
  }
  function createNativeItem(types, {library = context.role === 'gm'} = {}) {
    if (!canEdit() || library && context.role !== 'gm') return;
    const node = modal( () => t(library ? 'sheet.createItem' : 'sheet.createOwnedTitle')), body = el(doc, 'form', 'gws-modal-body'), choice = el(doc, 'label', 'gws-field', () => t('common.type')), select = el(doc, 'select');
    node.dataset.gwsCreate = library ? 'library' : 'owned'; body.noValidate = true;
    for (const type of types) {const option = el(doc, 'option', '', () => t(`item.type.${type}`)); option.value = type; select.append(option);} choice.append(select); body.append(choice);
    const hint = el(doc, 'p', 'gws-field-hint', () => t(library ? 'sheet.createHint' : 'sheet.createOwnedHint')), holder = el(doc, 'div'); body.append(hint, holder);
    let type = types[0], data, itemName = '', creating = false, creation, currentEditor;
    const drafts = new Map();
    const workflow = createItemWorkflow({
      create: async (input, options) => {
        if (!library) return {name: input.name, type: input.type, data: input.data};
        const result = await api.items.create(input, options); return result.item || await api.items.get(result.id);
      }, append: appendItem, flush: () => queue.flush(),
    });
    node.addEventListener('gravewright:sheet-flush', event => {if (creation) event.detail.waitUntil(creation);});
    function editor() {
      data = drafts.get(type) || createItemSheet(type); drafts.set(type, data);
      currentEditor = itemEditor({doc, t, type, data: () => data, name: () => itemName, canEdit: () => !workflow.started, signal,
        onNameChange: value => {itemName = value;}, changed: (path, value) => {if (path === 'core.name') itemName = value; else data[path] = value;}});
      editors.add(currentEditor); holder.replaceChildren(currentEditor);
      const input = holder.querySelector('[data-gws-item-field="core.name"]'); if (input) input.dataset.gwsAutofocus = '';
    }
    select.onchange = () => {
      const shared = Object.fromEntries(['description', 'notes', 'img', 'source'].map(key => [key, data[key]]));
      type = select.value; data = drafts.get(type) || createItemSheet(type); Object.assign(data, shared); drafts.set(type, data); editor();
    }; editor();
    const submit = button( () => t(library ? 'sheet.createAndAdd' : 'sheet.createOwned'), async () => {
      if (creating) return;
      if (!workflow.started && currentEditor.validate && !currentEditor.validate({focus: true})) return;
      if (!itemName.trim()) {currentEditor.showError?.({message: t('sheet.nameRequired')}); holder.querySelector('[data-gws-item-field="core.name"]')?.focus(); return;}
      creating = true; select.disabled = true;
      node.querySelector('.gws-modal-notice').hidden = true;
      const controls = [...holder.querySelectorAll('input,select,textarea,button')].map(control => [control, control.disabled]);
      for (const [control] of controls) control.disabled = true;
      try {
        creation = workflow.run({name: itemName.trim(), type, data: normalizeItemSheet(type, data)});
        await creation; node.close();
      } catch (error) {
        currentEditor.showError?.(error); bindTranslation(submit, 'textContent', () => t('common.retry'));
        const message = node.querySelector('.gws-modal-notice'); bindTranslation(message, 'textContent', () => t('sheet.createError')); message.hidden = false;
      } finally {
        creation = undefined; creating = false;
        select.disabled = workflow.started;
        if (!workflow.started) for (const [control, disabled] of controls) if (control.isConnected) control.disabled = disabled;
      }
    });
    const footer = el(doc, 'footer', 'gws-modal-footer'); footer.append(button( () => t('common.cancel'), () => node.close()), submit); body.append(footer);
    body.onsubmit = event => {event.preventDefault(); if (!submit.disabled) submit.click();};
    body.addEventListener('keydown', event => {if (event.key === 'Enter' && event.target.localName === 'input') {event.preventDefault(); if (!submit.disabled) submit.click();}});
    node.append(body); holder.querySelector('[data-gws-item-field="core.name"]')?.focus();
  }
  function equipItems() {
    const node = modal( () => t('sheet.equip')); node.dataset.gwsPicker = 'equipped';
    const body = el(doc, 'div', 'gws-modal-body'); body.append(el(doc, 'p', 'gws-field-hint', () => t('sheet.equipHint')));
    const list = el(doc, 'div', 'gws-picker'); body.append(list);
    function draw() {
      list.replaceChildren(); const available = draft.inventory.filter(item => !item.equipped);
      if (!available.length) list.append(el(doc, 'p', 'gws-empty', () => t(draft.inventory.length ? 'sheet.equipEmpty' : 'sheet.noItems')));
      for (const entry of available) {
        const row = el(doc, 'div', 'gws-picker-row'); row.dataset.entryId = entry.id;
        const identity = el(doc, 'div', 'gws-picker-identity'); identity.append(el(doc, 'strong', '', entry.name), el(doc, 'span', '', () => t(`item.type.${entry.type}`)));
        row.append(identity, button( () => t('sheet.equip'), async () => {updateItem('inventory', entry.id, item => {item.equipped = item.data.equipped = true;}); render(); await queue.flush(); draw();}, !canEdit())); list.append(row);
      }
    }
    const footer = el(doc, 'footer', 'gws-modal-footer'); footer.append(button( () => t('sheet.addFromLibrary'), () => chooseItem(PHYSICAL), !canEdit()), button( () => t('common.done'), () => node.close())); body.append(footer); node.append(body); draw();
  }
  function itemTable(collection, rows, kind = 'generic') {
    const wrap = el(doc, 'div', 'gws-table-wrap'), table = el(doc, 'table', `gws-table gws-table-${kind}`), head = el(doc, 'thead'), heading = el(doc, 'tr');
    const columns = kind === 'skills' ? ['common.name', 'common.die', 'common.modifier'] : kind === 'equipment' ? ['common.name', 'common.type', 'common.quantity', 'common.equipped'] : ['common.name', 'common.type'];
    for (const label of [...columns, 'common.actions']) heading.append(el(doc, 'th', '', () => t(label))); head.append(heading); table.append(head);
    const body = el(doc, 'tbody');
    for (const entry of rows) {
      const row = el(doc, 'tr'); row.dataset.entryId = entry.id;
      const identity = el(doc, 'td'), title = button( () => entry.name || t('item.untitled'), () => editItem(collection, entry), false, 'gws-link');
      title.prepend(icon(doc, entry.type === 'weapon' ? 'sword' : PHYSICAL.includes(entry.type) ? 'bag' : entry.type === 'power' ? 'book' : 'star')); identity.append(title); row.append(identity);
      if (kind === 'skills') {
        const dieCell = el(doc, 'td'), die = el(doc, 'select'); bindTranslation(die, 'aria-label', () => `${t('common.die')} · ${entry.name}`); die.disabled = !canEdit();
        const empty = el(doc, 'option', '', '—'); empty.value = ''; die.append(empty);
        const values = new Set([...DICE.map(String), ...(entry.data.die ? [String(entry.data.die).replace(/^d/, '')] : [])]);
        for (const value of values) {const option = el(doc, 'option', '', `d${value}`); option.value = value; die.append(option);} die.value = String(entry.data.die || '').replace(/^d/, '');
        die.onchange = () => updateItem(collection, entry.id, item => {item.data.die = die.value ? Number(die.value) : '';}); dieCell.append(die); row.append(dieCell);
        const modifierCell = el(doc, 'td'), modifier = el(doc, 'input'); modifier.type = 'number'; modifier.value = entry.data.modifier; modifier.readOnly = !canEdit(); bindTranslation(modifier, 'aria-label', () => `${t('common.modifier')} · ${entry.name}`);
        modifier.oninput = () => updateItem(collection, entry.id, item => {item.data.modifier = modifier.value === '' ? '' : Number(modifier.value);}); modifierCell.append(modifier); row.append(modifierCell);
      } else {
        row.append(el(doc, 'td', 'gws-type', () => t(`item.type.${entry.type}`)));
        if (kind === 'equipment') {
          const quantityCell = el(doc, 'td'), quantity = el(doc, 'input'); quantity.type = 'number'; quantity.min = '0'; quantity.step = '1'; quantity.value = entry.quantity; quantity.readOnly = !canEdit(); bindTranslation(quantity, 'aria-label', () => `${t('common.quantity')} · ${entry.name}`);
          quantity.oninput = () => updateItem(collection, entry.id, item => {item.quantity = Math.max(0, Number(quantity.value)); item.data.quantity = item.quantity;}); quantityCell.append(quantity); row.append(quantityCell);
          const equippedCell = el(doc, 'td'), equipped = el(doc, 'input'); equipped.type = 'checkbox'; equipped.checked = entry.equipped; equipped.disabled = !canEdit(); bindTranslation(equipped, 'aria-label', () => `${t('common.equipped')} · ${entry.name}`);
          equipped.onchange = () => {updateItem(collection, entry.id, item => {item.equipped = equipped.checked; item.data.equipped = equipped.checked;}); if (tab === 'overview') render();}; equippedCell.append(equipped); row.append(equippedCell);
        }
      }
      const actions = el(doc, 'td', 'gws-entry-actions'); actions.append(iconButton( () => t('common.edit'), 'edit', () => editItem(collection, entry)));
      if(canEdit() && (entry.type==='skill' || entry.type==='weapon' || entry.type==='power'))actions.append(iconButton( () => t('rules.roll'),'dice',()=>entry.type==='skill'?ruleActions.skill(entry):entry.type==='weapon'?ruleActions.attack(entry):ruleActions.cast(entry)));
      if (canEdit()) actions.append(iconButton( () => t('sheet.removeItem', {name: entry.name}), 'trash', () => {
        const confirm = modal( () => t('sheet.confirmRemove')), body = el(doc, 'div', 'gws-modal-body'); body.append(el(doc, 'strong', '', entry.name), el(doc, 'p', 'gws-field-hint', () => t('sheet.confirmRemoveHint')),
          button( () => t('common.remove'), () => {changed(collection, draft[collection].filter(item => item.id !== entry.id)); confirm.close(); render();}, false, 'gws-danger-button'), button( () => t('common.cancel'), () => confirm.close())); confirm.append(body);
      })); row.append(actions); body.append(row);
    }
    if (!rows.length) {
      const row = el(doc, 'tr'), cell = el(doc, 'td', 'gws-empty');
      const state = el(doc, 'div', 'gws-empty-state'); state.append(icon(doc, kind === 'equipment' ? 'bag' : 'star'),
        el(doc, 'strong', '', () => t(kind === 'equipment' && tab === 'overview' ? 'sheet.noEquipped' : 'common.empty')), el(doc, 'p', '', () => t(kind === 'equipment' && tab === 'overview' ? 'sheet.equipHint' : 'sheet.dropHint')));
      cell.append(state); cell.colSpan = columns.length + 1; row.append(cell); body.append(row);
    }
    table.append(body); wrap.append(table); return wrap;
  }
  function overview() {
    const body = el(doc, 'div', 'gws-overview'), upper = el(doc, 'div', 'gws-overview-top'); upper.append(attributes(), resources());body.append(ruleActions.bar(),upper);
    const lower = el(doc, 'div', 'gws-overview-bottom'), skills = section( () => t('collection.skills'), 'gws-skills'), equipment = section( () => t('sheet.equippedItems'), 'gws-equipped');
    addCount(skills, draft.skills.length); skills.append(itemTable('skills', draft.skills, 'skills'), button( () => `+ ${t('sheet.addSkill')}`, () => chooseItem(['skill']), !canEdit()));
    addCount(equipment, draft.inventory.filter(item => item.equipped).length);
    equipment.append(itemTable('inventory', draft.inventory.filter(item => item.equipped), 'equipment'));
    const actions = el(doc, 'div', 'gws-section-actions'); actions.append(button( () => `+ ${t('sheet.equip')}`, equipItems, !canEdit()), button( () => t('sheet.manageEquipment'), () => {tab = 'equipment'; render();}, false, 'gws-link')); equipment.append(actions);
    lower.append(skills, equipment); body.append(lower); return body;
  }
  function collectionSection(collection, types) {
    const node = section( () => t(`collection.${collection}`));
    addCount(node, draft[collection].length);
    const table = el(doc, 'div');
    if (collection === 'inventory') {
      const state = browsers.get(collection) || {query: '', type: ''}; browsers.set(collection, state);
      const toolbar = el(doc, 'div', 'gws-toolbar'), search = el(doc, 'input'), filter = el(doc, 'select'); search.type = 'search'; search.value = state.query;
      bindTranslation(search, 'placeholder', () => t('sheet.equipmentSearch')); bindTranslation(search, 'aria-label', () => t('sheet.equipmentSearch')); bindTranslation(filter, 'aria-label', () => t('common.type'));
      const all = el(doc, 'option', '', () => t('sheet.allTypes')); all.value = ''; filter.append(all);
      for (const type of types) {const option = el(doc, 'option', '', () => t(`item.type.${type}`)); option.value = type; filter.append(option);} filter.value = state.type;
      function draw() {table.replaceChildren(itemTable(collection, draft[collection].filter(item => searchText(item.name).includes(searchText(state.query)) && (!state.type || item.type === state.type)), 'equipment'));}
      search.oninput = () => {state.query = search.value; draw();}; filter.onchange = () => {state.type = filter.value; draw();}; toolbar.append(search, filter);
      if(system.settings?.current?.currency?.enabled!==false)node.append(field('resources.currency',()=>currencyLabel(system.settings?.current,t)));
      node.append(toolbar);draw();
    } else table.append(itemTable(collection, draft[collection], 'generic'));
    node.append(table, button( () => `+ ${t('common.add')}`, () => chooseItem(types), !canEdit())); return node;
  }
  function addCount(node, count) {
    const badge = el(doc, 'span', 'gws-count', String(count)); bindTranslation(badge, 'aria-label', () => t('sheet.itemCount', {count})); node.querySelector('h3').append(badge);
  }
  function characterSettings() {
    const node=modal( () => t('rules.characterSettings')),body=el(doc,'div','gws-modal-body'),grid=el(doc,'div','gws-rule-grid');
    body.append(el(doc,'p','gws-field-hint', () => t('rules.settingsHint')),grid);node.append(body);
    grid.append(toggle('calculation.automatic', () => t('rules.automatic')),choice('profile.kind', () => t('rules.profileKind'),[['wild-card', () => t('rules.wildCard')],['extra', () => t('rules.extra')]]),
      choice('profile.role', () => t('rules.profileRole'),[['player', () => t('rules.rolePlayer')],['ally', () => t('rules.roleAlly')],['enemy', () => t('rules.roleEnemy')]]),
      choice('profile.wildDie', () => t('rules.wildDie'),DICE.map(die=>[String(die),`d${die}`])),field('profile.woundCapacity', () => t('rules.woundCapacity'),{number:true,min:0}),
      field('stats.size', () => t('rules.size'),{number:true}),field('stats.basePace', () => t('rules.basePace'),{number:true,min:1}),choice('stats.runningDie', () => t('rules.runningDie'),DICE.map(die=>[String(die),`d${die}`])),toggle('profile.animalSmarts', () => t('rules.animalSmarts')));
    const skills=[['', () => t('item.emptyValue')],...draft.skills.map(row=>[row.id,row.name])];grid.append(choice('links.combatSkillId', () => t('rules.combatSkill'),skills));
    const derived=section( () => t('rules.statOverrides'));derived.append(el(doc,'p','gws-field-hint', () => t('rules.overrideHint')));
    const values=el(doc,'div','gws-rule-grid');for(const key of ['parry','toughness','armor','pace','runningDie','loadLimit'])values.append(field(`overrides.${key}`, () => t(key==='runningDie'?'rules.runningDie':key==='loadLimit'?'rules.loadLimit':`stat.${key}`),{number:true}));
    derived.append(values,button( () => t('rules.clearOverrides'),()=>{for(const key of Object.keys(draft.overrides))changed(`overrides.${key}`,null);node.close();},!canEdit()));body.append(derived);
    const bonus=section( () => t('rules.bonuses')),bonusGrid=el(doc,'div','gws-rule-grid');
    for(const key of ['parry','toughness','armor','pace','running','load','woundCapacity'])bonusGrid.append(field(`bonuses.${key}`, () => t(['parry','toughness','armor','pace'].includes(key)?`stat.${key}`:`rules.${key==='load'?'loadLimit':key==='running'?'runningModifier':key}`),{number:true}));bonus.append(bonusGrid);body.append(bonus);
    const load=section( () => t('rules.load')),loadGrid=el(doc,'div','gws-rule-grid');
    loadGrid.append(choice('load.unit', () => t('rules.weightUnit'),[['kg','kg'],['lb','lb']]),field('load.carried', () => t('rules.manualCarried'),{number:true,min:0}),
      field('movements.fly', () => t('rules.fly'),{number:true,min:0}),field('movements.swim', () => t('rules.swim'),{number:true,min:0}),field('movements.burrow', () => t('rules.burrow'),{number:true,min:0}));load.append(loadGrid);body.append(load);
    const initiative=section( () => t('rules.initiativeSettings')),initiativeGrid=el(doc,'div','gws-rule-grid');initiativeGrid.append(
      field('profile.initiative.draw', () => t('rules.drawCount'),{number:true,min:1}),choice('profile.initiative.keep', () => t('rules.keepCard'),[['highest', () => t('rules.highest')],['lowest', () => t('rules.lowest')]]),
      field('profile.initiative.redrawBelow', () => t('rules.redrawBelow'),{number:true,min:0}),field('profile.initiative.groupId', () => t('rules.initiativeGroup')));initiative.append(initiativeGrid);body.append(initiative);
    const options=section( () => t('rules.settingRules'));options.append(ruleChoice('woundCap',t('rules.woundCap')),ruleChoice('noPowerPoints',t('rules.noPowerPoints')),
      ruleChoice('enableWoundPace',t('settings.rule.enableWoundPace')),ruleChoice('applyEncumbrance',t('settings.rule.applyEncumbrance')));body.append(options);
    const progress=section( () => t('rules.progressLedger')),ledger=el(doc,'div','gws-progress-list');
    function drawLedger(){ledger.replaceChildren();for(const entry of draft.advancement.ledger){
      const row=el(doc,'div','gws-pool-row'),advance=el(doc,'input'),kind=el(doc,'select'),target=el(doc,'input');advance.type='number';advance.min='1';advance.value=entry.advance;advance.readOnly=!canEdit();bindTranslation(advance, 'aria-label', () => t('rules.progressNumber'));
      advance.oninput=()=>{entry.advance=Number(advance.value);queue.mark();};
      for(const id of ['attribute','skill','edge','hindrance']){const option=el(doc,'option','', () => t(`rules.progressKind.${id}`));option.value=id;kind.append(option);}kind.value=entry.kind || 'edge';kind.disabled=!canEdit();bindTranslation(kind, 'aria-label', () => t('rules.progressKind'));kind.onchange=()=>{entry.kind=kind.value;queue.mark();};
      target.type='text';target.value=entry.target || '';target.readOnly=!canEdit();bindTranslation(target, 'aria-label', () => t('rules.progressTarget'));target.oninput=()=>{entry.target=target.value;queue.mark();};
      row.append(advance,kind,target,iconButton( () => t('common.remove'),'trash',()=>{changed('advancement.ledger',draft.advancement.ledger.filter(value=>value.id!==entry.id));drawLedger();},!canEdit()));ledger.append(row);
    }}drawLedger();progress.append(ledger,button( () => `+ ${t('rules.addProgress')}`,()=>{changed('advancement.ledger',[...draft.advancement.ledger,{id:globalThis.crypto.randomUUID(),advance:Math.max(1,Number(draft.identity.advances)||1),kind:'edge',target:''}]);drawLedger();},!canEdit()));
    const warnings=el(doc,'p','gws-field-hint');bindTranslation(warnings, 'textContent', () => t('rules.progressHint'));progress.append(warnings,button( () => t('rules.reviewLedger'),()=>{
      const result=validateProgressLedger(draft);bindTranslation(warnings, 'textContent', () => result.valid?t('common.saved'):t('rules.ledgerIssues',{count:result.errors.length}));
    }));body.append(progress);
    const footer=el(doc,'footer','gws-modal-footer');footer.append(button( () => t('common.done'),()=>node.close()));body.append(footer);
  }
  function renderBody() {
    if (tab === 'overview') return overview();
    if (tab === 'equipment') return collectionSection('inventory', PHYSICAL);
    if (tab === 'features') {
      const grid = el(doc, 'div', 'gws-feature-grid');
      for (const collection of ['edges', 'hindrances', 'ancestries', 'racialFeatures', 'effects']) grid.append(collectionSection(collection, ITEM_TYPES.filter(type => type.collection === collection).map(type => type.id)));
      return grid;
    }
    if (tab === 'powers') {
      const node = el(doc, 'div', 'gws-powers'), points = section( () => t('resource.powerPoints')), fields = el(doc, 'div', 'gws-inline-fields');
      const noPowerPoints=getRules().noPowerPoints===true;points.hidden=noPowerPoints;
      fields.append(field('resources.powerPoints', () => t('common.current'), {number: true, min: 0}), field('resources.powerPointsMax', () => t('common.maximum'), {number: true, min: 0})); points.append(fields);
      const pools=section( () => t('rules.arcanePools')),poolRows=el(doc,'div','gws-pool-list');
      pools.hidden=noPowerPoints;
      for(const pool of draft.arcanePools){
        const row=el(doc,'div','gws-pool-row');row.dataset.poolId=pool.id;
        const title=el(doc,'input');title.type='text';title.value=pool.name;bindTranslation(title, 'aria-label', () => t('common.name'));title.readOnly=!canEdit();
        title.oninput=()=>{pool.name=title.value;queue.mark();};row.append(title);
        for(const key of ['current','max']){const control=el(doc,'input');control.type='number';control.min='0';control.value=pool[key];control.readOnly=!canEdit();bindTranslation(control, 'aria-label', () => t(`common.${key==='max'?'maximum':key}`));control.oninput=()=>{pool[key]=control.value===''?'':Number(control.value);queue.mark();};row.append(control);}
        const skill=el(doc,'select');bindTranslation(skill, 'aria-label', () => t('rules.arcaneSkill'));skill.disabled=!canEdit();
        for(const candidate of [{id:'',name:()=>t('item.emptyValue')},...draft.skills]){const option=el(doc,'option','',candidate.name);option.value=candidate.id;skill.append(option);}skill.value=pool.skillId;skill.onchange=()=>{pool.skillId=skill.value;queue.mark();};row.append(skill);
        row.append(iconButton( () => t('common.remove'),'trash',()=>{
          const confirm=modal( () => t('common.remove')),body=el(doc,'div','gws-modal-body');body.append(el(doc,'p','', () => t('rules.confirmPoolRemove')),
            button( () => t('common.remove'),async()=>{changed('arcanePools',draft.arcanePools.filter(value=>value.id!==pool.id));await queue.flush();await confirm.close();},!canEdit()),button( () => t('common.cancel'),()=>confirm.close()));confirm.append(body);
        },!canEdit()));poolRows.append(row);
      }
      pools.append(poolRows,button( () => `+ ${t('rules.addPool')}`,()=>{changed('arcanePools',[...draft.arcanePools,{id:globalThis.crypto.randomUUID(),name:'',skillId:'',current:0,max:0}]);render();},!canEdit()));
      const active=section( () => t('rules.activePowers'));
      for(const power of draft.activePowers.filter(entry=>entry.active)){const row=el(doc,'div','gws-picker-row');row.append(el(doc,'strong','',power.name),el(doc,'span','', () => power.remainingRounds===null?t('rules.manualDuration'):t('rules.roundsLeft',{count:power.remainingRounds})),button( () => t('rules.maintain'),()=>actions.maintain(power.id),!canEdit()),button( () => t('rules.endPower'),()=>actions.end(power.id),!canEdit()));active.append(row);}
      const rest=button( () => t('rules.rest'),actions.rest,!canEdit());rest.hidden=noPowerPoints;
      node.append(points,pools,collectionSection('powers', ['power']),active,rest);return node;
    }
    const node = el(doc, 'div', 'gws-notes-grid'); node.append(field('biography', () => t('sheet.biography'), {area: true}), field('notes', () => t('sheet.notes'), {area: true}));
    const extra = section( () => t('sheet.identity')); extra.append(field('identity.player', () => t('identity.player')), field('identity.ancestry', () => t('identity.ancestry')), imageUpload('token', () => t('sheet.uploadToken')),button( () => t('rules.characterSettings'),characterSettings));node.append(extra);return node;
  }
  function render() {
    if (signal.aborted) return;
    settingsPending=false;
    shell.replaceChildren(notice, header());
    const nav = el(doc, 'nav', 'gws-tabs'); nav.setAttribute('role', 'tablist'); bindTranslation(nav, 'aria-label', () => t('sheet.tabs'));
    for (const [id, key] of [['overview', 'sheet.overview'], ['equipment', 'sheet.equipment'], ['features', 'sheet.features'], ['powers', 'sheet.powers'], ['notes', 'sheet.notes']]) {
      const control = button( () => t(key), async () => {const focused = !!doc.activeElement?.closest('.gws-tabs'); await queue.flush(); tab = id; render(); if (focused) shell.querySelector(`#${prefix}-tab-${id}`)?.focus();}, false);
      control.dataset.gwsTab = id; control.id = `${prefix}-tab-${id}`; control.setAttribute('role', 'tab'); control.setAttribute('aria-selected', String(tab === id)); control.setAttribute('aria-controls', `${prefix}-panel`); control.tabIndex = tab === id ? 0 : -1;
      control.onkeydown = event => {if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const controls = [...nav.children], current = controls.indexOf(control); const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length; controls[next].click(); queueMicrotask(() => shell.querySelector(`#${controls[next].id}`)?.focus());}; nav.append(control);
    }
    shell.append(nav); const panel = el(doc, 'div', 'gws-body'); panel.id = `${prefix}-panel`; panel.dataset.gwsPanel = tab; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `${prefix}-tab-${tab}`); panel.append(renderBody()); shell.append(panel);
    const footer = el(doc, 'footer', 'gws-footer'), indicator = el(doc, 'span', 'gws-save-status'); indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite');
    const retry = button( () => t('common.retry'), () => queue.flush(), !view.canEdit); retry.dataset.gwsRetry = ''; retry.hidden = true;
    footer.append(el(doc, 'span', '', system.version ? `SWADE · ${system.version}` : 'SWADE'),indicator,button( () => t('rules.characterSettings'),characterSettings),retry);
    if (queue.conflicted) footer.append(button( () => t('sheet.reload'), () => {
      const confirm = modal( () => t('sheet.reload')), body = el(doc, 'div', 'gws-modal-body'); body.append(el(doc, 'p', '', () => t('common.conflict')),
        button( () => t('sheet.reload'), async () => {const current = await api.actors.sheet(context.actorId, context.tokenId ? {tokenId: context.tokenId} : {}); view = current; draft = normalizeSheet(current.data); name = current.name; queue.reset(); notice.hidden = true; confirm.close(); render();}), button( () => t('common.cancel'), () => confirm.close())); confirm.append(body);
    })); shell.append(footer); status(saveState);
  }
  // Copy only documents read through the current table's authorized native API.
  let drops = Promise.resolve();
  const dropTarget = root.closest('.gw-window,.item-sheet') || shell;
  dropTarget.addEventListener('dragover', event => {if (canEdit() && [...event.dataTransfer.types].includes('application/x-gravewright-item')) {event.preventDefault(); event.dataTransfer.dropEffect = 'copy';}}, {signal});
  dropTarget.addEventListener('drop', event => {
    if (!canEdit() || ![...event.dataTransfer.types].includes('application/x-gravewright-item')) return;
    event.preventDefault(); const raw = event.dataTransfer.getData('application/x-gravewright-item');
    drops = drops.catch(() => {}).then(async () => {
      const reference = JSON.parse(raw);
      if (reference.tableId !== context.tableId || typeof reference.id !== 'string') throw new Error('unsupported_item');
      const item = await api.items.get(reference.id);
      if (signal.aborted) return;
      if (!item.canOpen || item.systemId && item.systemId !== context.systemId || !canonicalItemType(item.type)) throw new Error('unsupported_item');
      appendItem(item); await queue.flush();
    }); drops.catch(() => {if (!signal.aborted) {bindTranslation(notice, 'textContent', () => t('sheet.dropRejected')); notice.hidden = false;}});
  }, {signal});
  async function flushAll() {let current; do {current = drops; await current.catch(() => {}); await Promise.all([...work]); await queue.flush();} while (current !== drops || work.size);}
  root.closest('.gw-window,.item-sheet')?.addEventListener('gravewright:sheet-flush', event => event.detail.waitUntil(flushAll()), {signal});
  const unsubscribe = api.events.on('actors.changed', async () => {
    if (signal.aborted || queue.dirty || queue.pending || uploading || work.size || modals.size || refreshing) return;
    refreshing = true;
    try {
      const current = await api.actors.sheet(context.actorId, context.tokenId ? {tokenId: context.tokenId} : {});
      if (!signal.aborted && !queue.dirty && !queue.pending && !work.size && !modals.size && (current.version !== view.version || current.sheetVersion !== view.sheetVersion)) {view = current; draft = normalizeSheet(current.data); name = current.name; render();}
    } catch (error) {report(error);} finally {refreshing = false;}
  });
  async function refreshSettings() {
    if(!settingsPending || refreshingSettings || signal.aborted || modals.size || work.size || uploading)return;
    refreshingSettings=true;
    try {
      await queue.flush();
      if(signal.aborted || modals.size || work.size || uploading)return;
      const focused=doc.activeElement,path=shell.contains(focused)?focused.dataset?.gwsPath:undefined;
      const selection=path && typeof focused.selectionStart==='number'?{start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection}:null;
      render();
      const next=path?[...shell.querySelectorAll('[data-gws-path]')].find(node=>node.dataset.gwsPath===path):undefined;
      next?.focus();if(selection && next?.setSelectionRange)next.setSelectionRange(selection.start,selection.end,selection.direction);
    } catch(error) {report(error);} finally {refreshingSettings=false;}
  }
  const unsubscribeSettings=system.settings?.subscribe(()=>{settingsPending=true;void refreshSettings();});
  const unsubscribeLanguage = system.subscribeLanguage?.(() => {
    if (signal.aborted) return;
    refreshTranslations(shell);
    for (const node of modals) refreshTranslations(node);
    for (const editor of editors) if (editor.isConnected) editor.refreshLanguage?.(); else editors.delete(editor);
  });
  let disposed=false;
  function dispose() {
    if(disposed)return;disposed=true;
    if (typeof unsubscribe === 'function') unsubscribe();
    if(typeof unsubscribeSettings==='function')unsubscribeSettings();
    unsubscribeLanguage?.();for (const node of modals) node.close(true);editors.clear();queue.dispose();
  }
  signal.addEventListener('abort',dispose,{once:true});block.onDispose?.(dispose);
  render(); return {flush: flushAll, dispose};
}
