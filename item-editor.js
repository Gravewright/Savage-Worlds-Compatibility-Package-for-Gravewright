import {ITEM_TYPES, canonicalItemType, normalizeItemSheet} from './model.js';
import {DOCUMENT_NAME_MAX, openModal, bindTranslation, refreshTranslations} from './ui.js';
import {itemRulesEditor} from './item-rules-editor.js';

const canonicalType = canonicalItemType;
const element = (doc, tag, className = '', text) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) bindTranslation(node, 'textContent', text);
  return node;
};
const clone = value => structuredClone(value);
const editable = item => item.canEdit === true;
const optionsFor = signal => signal ? {signal} : undefined;

/** Debounced, versioned writes shared by item autosave and the native close hook. */
export function createItemSaveController({item, write, signal, delay = 450, onStatus = () => {}, onError = () => {}}) {
  let current = {...item, data: normalizeItemSheet(canonicalType(item.type), item.data)};
  let revision = 0, saved = 0, pending, timer, disposed = !!signal?.aborted, conflict, attempt;
  const status = state => { if (!disposed) onStatus(editable(current) ? state : 'readonly'); };
  const report = error => {
    if (!disposed) {
      if (error.code === 'conflict') conflict = error;
      status('error');
      onError(error);
    }
  };
  async function drain() {
    if (revision !== saved) status('saving');
    try {
      while (!disposed && revision !== saved) {
        const writing = attempt?.revision ?? revision, data = attempt?.payload.data ?? clone(current.data), name = attempt?.payload.name ?? current.name;
        if (!String(name || '').trim()) throw Object.assign(new Error('An item name is required.'), {code: 'validation', field: 'core.name'});
        if (String(name).length > DOCUMENT_NAME_MAX) throw Object.assign(new Error('The item name exceeds the document limit.'), {code: 'validation', field: 'core.name', reason: 'too_long', max: DOCUMENT_NAME_MAX});
        attempt ??= {revision:writing,requestId:globalThis.crypto.randomUUID(),payload:{id:current.id,version:current.version,name,data}};
        const result = await write(clone(attempt.payload),{...optionsFor(signal),requestId:attempt.requestId});
        if (disposed) return;
        current = {...current, version: result?.item?.version ?? result?.version ?? current.version + 1};
        saved = writing;attempt=undefined;
      }
      status('saved');
    } catch (error) {
      report(error);
      throw error;
    }
  }
  function flush() {
    clearTimeout(timer);
    if (disposed || !editable(current)) return Promise.resolve();
    if (conflict) return Promise.reject(conflict);
    if (!pending) pending = drain().finally(() => { pending = undefined; });
    return pending;
  }
  function change(path, value) {
    if (disposed || !editable(current) || !path || ['__proto__', 'prototype', 'constructor'].includes(path)) return false;
    if (path === 'core.name') {
      if (current.name === String(value)) return false;
      current = {...current, name: String(value)};
    } else {
      if (Object.is(current.data[path], value)) return false;
      current.data[path] = value;
    }
    revision++;
    clearTimeout(timer);
    if (!conflict) {
      status('waiting');
      timer = setTimeout(() => { void flush().catch(() => {}); }, delay);
    }
    return true;
  }
  function replace(next) {
    if (disposed || pending || revision !== saved) return false;
    current = {...next, data: normalizeItemSheet(canonicalType(next.type), next.data)};
    conflict = undefined;
    status('saved');
    return true;
  }
  // Called only after the user explicitly confirms replacing the local draft.
  function reload(next) {
    if (disposed || pending) return false;
    clearTimeout(timer);
    current = {...next, data: normalizeItemSheet(canonicalType(next.type), next.data)};
    revision = saved = 0; conflict = attempt = undefined; status('saved'); return true;
  }
  function dispose() { disposed = true; clearTimeout(timer); }
  signal?.addEventListener('abort', dispose, {once: true});
  status('saved');
  return {change, flush, replace, reload, dispose, get item() { return current; }, get dirty() { return revision !== saved; }, get saving() { return !!pending; }, get conflicted() { return !!conflict; }};
}

// Templates describe fields only. There are no rulebook entries or calculated effects.
const physical = ['quantity', 'weight', 'weightUnit', 'carried', 'cost', 'equipped','minStrength','minStrengthModifier'];
const groups = {
  weapon: [['combat', ['category', 'damage', 'range', 'armorPiercing', 'rateOfFire', 'shots', 'capacity', 'reach', 'reload', 'parryBonus', 'heavy', 'properties']], ['physical', physical]],
  armor: [['defense', ['protection', 'coverage', 'parryBonus', 'cover', 'ballisticProtection', 'heavy', 'properties']], ['physical', physical]],
  equipment: [['physical', ['category', ...physical, 'properties']]],
  consumable: [['consumable', ['category', 'uses', 'maxUses']], ['physical', physical]],
  skill: [['skill', ['attribute', 'die', 'modifier']]],
  edge: [['requirements', ['rank', 'requirements']]],
  hindrance: [['requirements', ['severity']]],
  ancestry: [['ancestry', ['size', 'pace']]],
  'racial-feature': [['ancestry', ['ancestry', 'requirements']]],
  power: [['power', ['rank', 'powerPoints', 'additionalCost', 'limitations', 'range', 'duration', 'durationRounds', 'targetCount', 'maintainable', 'activation', 'skill', 'trapping']]],
  effect: [['effect', ['category', 'duration', 'active']]],
  vehicle: [['vehicle', ['handling','topSpeed','size','toughness','protection','heavy','crew','passengers','cargo','fuel','fuelMax','wounds','woundsMax','properties']], ['physical',physical]],
  'arcane-device': [['power',['powerPoints','powerPointsMax','skill']],['physical',physical]],
};
const numericFields = new Set(['quantity', 'weight', 'cost', 'armorPiercing', 'rateOfFire', 'shots', 'protection', 'uses', 'maxUses', 'modifier', 'size', 'pace', 'powerPoints','powerPointsMax','parryBonus','reach','reload','capacity','cover','ballisticProtection','additionalCost','limitations','durationRounds','targetCount','handling','topSpeed','toughness','crew','passengers','cargo','fuel','fuelMax','wounds','woundsMax','minStrengthModifier']);
const booleanFields = new Set(['equipped', 'active','heavy','maintainable','carried']);
const longFields = new Set(['description', 'notes', 'properties', 'requirements', 'trapping']);
const factFields = {
  weapon: ['damage', 'range', 'armorPiercing', 'weight'], armor: ['protection', 'coverage', 'weight', 'cost'],
  equipment: ['quantity', 'weight', 'cost'], consumable: ['quantity', 'uses', 'maxUses'],
  skill: ['attribute', 'die', 'modifier'], edge: ['rank'], hindrance: ['severity'], ancestry: ['size', 'pace'],
  'racial-feature': ['ancestry'], power: ['powerPoints', 'range', 'duration'], effect: ['category', 'duration'],
  vehicle:['handling','topSpeed','toughness','crew'], 'arcane-device':['powerPoints','powerPointsMax','weight'],
};
let tabSequence = 0;

/** Only safe, persistent image addresses are loaded into a preview. */
export function itemImageUrl(value, base = 'https://gravewright.invalid/') {
  if (typeof value !== 'string' || !value.trim()) return '';
  const address = value.trim();
  if (!/^https?:\/\//i.test(address) && !/^\/(?![\/\\])/.test(address)) return '';
  try {
    const url = new URL(address, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function emblem(doc, type) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = type === 'armor' ? ['M24 5 40 11v12c0 9-8 16-16 20C16 39 8 32 8 23V11Z']
    : type === 'weapon' ? ['m10 38 7-7m-6-6 12 12M18 30 37 8l3 1-1 4-21 20', 'm34 36-7-7m-6 6 12-12M28 30 9 8l-3 1 1 4 21 20']
    : type === 'power' || type === 'effect' ? ['m24 5 5 13 14 6-14 5-5 14-5-14-14-5 14-6Z']
    : type === 'equipment' || type === 'consumable' ? ['M12 17h24v24H12Z', 'M18 17V9h12v8', 'M12 26h24', 'M20 24v5h8v-5']
    : ['M9 9h30v30H9Z', 'M17 17h1m12 0h1M23 24h2M17 31h1m12 0h1'];
  for (const d of paths) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}

/** Reusable editor for library items and independent copies on an actor. */
export function itemEditor(env) {
  const {doc, t, signal} = env, type = canonicalType(env.type);
  const data = () => typeof env.data === 'function' ? env.data() : env.data || {};
  const name = () => typeof env.name === 'function' ? env.name() : env.name || '';
  const canEdit = () => typeof env.canEdit === 'function' ? env.canEdit() : env.canEdit === true;
  if (!groups[type]) throw new Error(t('item.unsupported'));
  const root = element(doc, 'section', 'gws-item-editor'); root.dataset.itemType = type;
  const localNotice = element(doc, 'p', 'gws-item-notice'); localNotice.setAttribute('role', 'alert'); localNotice.hidden = true;
  const controls = new Map(), validations = new Map(), touched = new Set(), counters = [];
  function showError(error) {
    if (signal?.aborted) return;
    bindTranslation(localNotice, 'textContent', () => t(error?.code === 'conflict' ? 'common.conflict' : error?.code === 'validation' ? 'item.validationError' : 'common.saveError'));
    localNotice.hidden = false;
    if (error?.field && controls.has(error.field)) setValidation(error.field, t(error.field === 'core.name'
      ? error.reason === 'too_long' ? 'item.nameTooLong' : 'item.nameRequired' : 'item.validationError', {max: DOCUMENT_NAME_MAX}));
  }
  const caption = () => t(ITEM_TYPES.find(item => item.id === type)?.labelKey || `item.type.${type}`);
  const changed = (path, value) => {
    if (!canEdit() || signal?.aborted) return;
    try {
      if (path === 'core.name' && env.onNameChange) env.onNameChange(value);
      else env.changed(path, value);
      localNotice.hidden = true; refresh();
    } catch (error) { showError(error); env.onError?.(error); }
  };
  function setValidation(path, message = '') {
    const entry = controls.get(path); if (!entry) return;
    entry.error.textContent = message; entry.error.hidden = !message;
    entry.control.setAttribute('aria-invalid', String(!!message));
    entry.control.setCustomValidity(message);
    if (message) validations.set(path, message); else validations.delete(path);
  }
  function validateField(path, show = true) {
    const entry = controls.get(path); if (!entry || !canEdit()) return true;
    const {control} = entry; control.setCustomValidity('');
    let message = '';
    if (path === 'core.name' && !control.value.trim()) message = t('item.nameRequired');
    else if (path === 'core.name' && control.value.length > DOCUMENT_NAME_MAX) message = t('item.nameTooLong', {max: DOCUMENT_NAME_MAX});
    else if (path === 'img' && control.value.trim() && !itemImageUrl(control.value, doc.baseURI)) message = t('item.imageInvalid');
    else if (numericFields.has(path) && (!control.validity.valid || control.value !== '' && !Number.isFinite(Number(control.value)))) message = t('item.numberInvalid');
    if (show) setValidation(path, message);
    return !message;
  }
  function validate({focus = true, onlyTouched = false} = {}) {
    let first;
    for (const [path, {control}] of controls) if ((!onlyTouched || touched.has(path)) && !validateField(path) && !first) first = control;
    if (first && focus) {
      const panel = first.closest('[role=tabpanel]'); if (panel) activate([...panels].find(([, node]) => node === panel)[0]);
      first.focus();
    }
    if (!first && canEdit() && touched.has('img')) {
      const address = controls.get('img').control.value.trim();
      if (address !== data().img) changed('img', address);
    }
    return !first;
  }
  function field(path) {
    const label = () => t(path === 'core.name' ? 'common.name' : path === 'img' ? 'item.image' : `item.field.${path}`);
    const wrap = element(doc, 'label', 'gws-field'); wrap.append(element(doc, 'span', '', label));
    const value = path === 'core.name' ? name() : data()[path] ?? '';
    const isSelect = ['attribute', 'die'].includes(path), isBoolean = booleanFields.has(path);
    const control = element(doc, isSelect ? 'select' : longFields.has(path) ? 'textarea' : 'input');
    control.dataset.gwsItemField = path; bindTranslation(control, 'aria-label', label);
    if (isSelect) {
      const values = path === 'die' ? ['', 4, 6, 8, 10, 12] : ['', 'agility', 'smarts', 'spirit', 'strength', 'vigor'];
      if (value !== '' && !values.some(option => String(option) === String(value))) values.push(value);
      for (const choice of values) {
        const choiceLabel = () => choice === '' ? t('item.emptyValue') : path === 'die' ? String(choice).startsWith('d') ? String(choice) : `d${choice}`
          : ['agility', 'smarts', 'spirit', 'strength', 'vigor'].includes(choice) ? t(`attribute.${choice}`) : String(choice);
        const option = element(doc, 'option', '', choiceLabel); option.value = String(choice); control.append(option);
      }
    } else if (isBoolean) control.type = 'checkbox';
    else if (numericFields.has(path)) {
      control.type = 'number'; control.step = ['quantity', 'armorPiercing', 'rateOfFire', 'shots', 'uses', 'maxUses', 'powerPoints'].includes(path) ? '1' : 'any';
      if (!['modifier', 'size','handling','parryBonus'].includes(path)) control.min = '0';
    } else if (!longFields.has(path)) {
      control.type = 'text'; control.maxLength = path === 'img' ? 2048 : 1000;
      if (path === 'img') { control.inputMode = 'url'; control.spellcheck = false; control.autocomplete = 'off'; }
    } else { control.rows = path === 'description' ? 10 : 4; control.maxLength = 10000; }
    if (isBoolean) control.checked = !!value;
    else control.value = String(value);
    if (path === 'core.name') { control.maxLength = DOCUMENT_NAME_MAX; bindTranslation(control, 'placeholder', () => t('item.untitled')); }
    if (isSelect || isBoolean) control.disabled = !canEdit(); else control.readOnly = !canEdit();
    const error = element(doc, 'small', 'gws-field-error'); error.id = `gws-item-error-${++tabSequence}`; error.hidden = true;
    controls.set(path, {control, error}); control.setAttribute('aria-describedby', error.id);
    if (['description', 'notes'].includes(path)) {
      bindTranslation(control, 'placeholder', () => t(path === 'description' ? 'item.descriptionPlaceholder' : 'item.notesPlaceholder'));
      const counter = element(doc, 'small', 'gws-character-count'); counter.id = `gws-item-counter-${++tabSequence}`; counter.hidden = !canEdit();
      controls.get(path).counter = counter; counters.push({control, counter});
      control.setAttribute('aria-describedby', `${error.id} ${counter.id}`);
    }
    if (isBoolean) wrap.classList.add('gws-item-checkbox');
    if (longFields.has(path) || path === 'img' || path === 'source') wrap.classList.add('gws-item-field-wide');
    control.addEventListener(isSelect || isBoolean ? 'change' : 'input', () => {
      touched.add(path);
      const wasInvalid = validations.has(path);
      if (!validateField(path, wasInvalid) && path !== 'core.name') { updateCounters(); return; }
      if (path === 'img') return;
      const rawNumber = control.value.replace(/^d/i, '');
      const next = isBoolean ? control.checked : numericFields.has(path) || path === 'die'
        ? control.value === '' ? '' : Number.isFinite(Number(rawNumber)) ? Number(rawNumber) : control.value : control.value;
      changed(path, next);
    }, optionsFor(signal));
    control.addEventListener('blur', () => {
      touched.add(path);
      if (validateField(path) && path === 'img') changed(path, control.value.trim());
    }, optionsFor(signal));
    wrap.append(control, error); if (controls.get(path).counter) wrap.append(controls.get(path).counter); return wrap;
  }

  const hero = element(doc, 'header', 'gws-item-hero'), portrait = element(doc, 'div', 'gws-item-image');
  const image = element(doc, 'img'), placeholder = element(doc, 'div', 'gws-item-image-placeholder');
  image.alt = ''; image.referrerPolicy = 'no-referrer'; image.decoding = 'async'; placeholder.append(emblem(doc, type)); portrait.append(image, placeholder);
  portrait.setAttribute('role', 'img');
  image.addEventListener('load', () => {
    if (!itemImageUrl(data().img, doc.baseURI)) return;
    image.hidden = false; placeholder.hidden = true; portrait.dataset.imageState = 'loaded'; imageState.hidden = true;
  }, optionsFor(signal));
  image.addEventListener('error', () => {
    if (!itemImageUrl(data().img, doc.baseURI)) return;
    image.hidden = true; placeholder.hidden = false; portrait.dataset.imageState = 'error';
    bindTranslation(portrait, 'aria-label', () => t('item.imageUnavailable')); bindTranslation(imageState, 'textContent', () => t('item.imageUnavailable')); imageState.hidden = false;
  }, optionsFor(signal));
  const identity = element(doc, 'div', 'gws-item-identity'), title = field('core.name'); title.classList.add('gws-item-name');
  const readonlyHint = element(doc, 'p', 'gws-item-readonly', () => t('item.readOnlyHelp')); readonlyHint.hidden = canEdit();
  identity.append(element(doc, 'span', 'gws-item-kind', caption), title, readonlyHint); hero.append(portrait, identity); root.append(localNotice, hero);
  const facts = element(doc, 'dl', 'gws-item-facts'), outputs = [];
  for (const path of factFields[type] || []) {
    const fact = element(doc, 'div'), output = element(doc, 'dd');
    fact.append(element(doc, 'dt', '', () => t(`item.field.${path}`)), output); facts.append(fact); outputs.push({path, output});
  }
  root.append(facts);
  const nav = element(doc, 'nav', 'gws-item-tabs'), body = element(doc, 'div', 'gws-item-body');
  nav.setAttribute('role', 'tablist'); bindTranslation(nav, 'aria-label', () => t('item.sections'));
  const state = env.state || {}, panels = new Map(), tabs = new Map();
  let active = state.tab === 'details' ? 'details' : 'description', switching = false;
  function activate(id) {
    active = state.tab = id;
    for (const [key, panel] of panels) {
      panel.hidden = key !== id; tabs.get(key).setAttribute('aria-selected', String(key === id)); tabs.get(key).tabIndex = key === id ? 0 : -1;
    }
  }
  async function switchTab(id, focus = false) {
    if (id === active || switching) return;
    switching = true;
    try {
      if (!validate({onlyTouched: true})) return;
      nav.setAttribute('aria-busy', 'true');
      await env.beforeTabChange?.();
      if (signal?.aborted) return;
      activate(id); if (focus) tabs.get(id).focus();
    } catch (error) { showError(error); env.onError?.(error); }
    finally { switching = false; nav.removeAttribute('aria-busy'); }
  }
  for (const id of ['description', 'details']) {
    const tab = element(doc, 'button', 'gws-button', () => t(`item.${id}`)), panel = element(doc, 'section', 'gws-item-panel');
    tab.type = 'button'; tab.dataset.gwsItemTab = id; tab.id = `gws-item-tab-${++tabSequence}`;
    panel.id = `${tab.id}-panel`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    tab.addEventListener('click', () => { void switchTab(id); }, optionsFor(signal));
    tabs.set(id, tab); panels.set(id, panel); nav.append(tab); body.append(panel);
  }
  nav.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const id = event.key === 'Home' ? 'description' : event.key === 'End' ? 'details' : active === 'description' ? 'details' : 'description';
    void switchTab(id, true);
  }, optionsFor(signal));
  root.append(nav, body);
  const descriptionGrid = element(doc, 'div', 'gws-item-description-grid'), narrative = element(doc, 'div', 'gws-item-narrative');
  const aside = element(doc, 'aside', 'gws-item-aside'), reading = element(doc, 'dl', 'gws-item-reading-facts');
  const summaryEmpty = element(doc, 'p', 'gws-item-empty', () => t(canEdit() ? 'item.summaryEmpty' : 'common.empty'));
  const prose = element(doc, 'div', 'gws-item-reading'), proseOutputs = [];
  for (const path of ['description', 'notes']) {
    narrative.append(field(path));
    const section = element(doc, 'section'), output = element(doc, 'div', 'gws-item-prose');
    section.append(element(doc, 'h3', '', () => t(`item.field.${path}`)), output); prose.append(section); proseOutputs.push({path, output});
  }
  aside.append(element(doc, 'h3', '', () => t('item.summary')), reading, summaryEmpty);
  const modebar = element(doc, 'div', 'gws-item-modebar'), mode = element(doc, 'button', 'gws-button'); mode.type = 'button'; mode.hidden = !canEdit();
  let readingMode = !canEdit() || state.reading === true;
  function setReading(value) {
    readingMode = state.reading = value; narrative.hidden = value; prose.hidden = !value;
    bindTranslation(mode, 'textContent', () => t(value ? 'item.editText' : 'item.preview')); mode.setAttribute('aria-pressed', String(value));
  }
  mode.addEventListener('click', () => { if (readingMode || validate({onlyTouched: true})) setReading(!readingMode); }, optionsFor(signal)); modebar.append(mode);
  descriptionGrid.append(narrative, prose, aside); panels.get('description').append(modebar, descriptionGrid); setReading(readingMode);
  const detailGrid = element(doc, 'div', 'gws-item-detail-grid'); panels.get('details').append(detailGrid);
  let removeImage;
  const imageState = element(doc, 'p', 'gws-item-image-state'); imageState.setAttribute('role', 'status'); imageState.hidden = true;
  for (const [group, paths] of [...groups[type], ['other', ['source', 'img']]]) {
    const section = element(doc, 'section', 'gws-item-group'), fields = element(doc, 'div', 'gws-item-field-grid');
    section.append(element(doc, 'h3', '', () => t(`item.group.${group}`)), fields);
    for (const path of paths) fields.append(field(path));
    if (group === 'other') {
      const hint = element(doc, 'p', 'gws-field-hint', () => t('item.imageHint')); hint.id = `gws-item-image-hint-${++tabSequence}`;
      controls.get('img').control.setAttribute('aria-describedby', `${controls.get('img').error.id} ${hint.id}`);
      removeImage = element(doc, 'button', 'gws-button', () => t('item.removeImage')); removeImage.type = 'button'; removeImage.hidden = !canEdit();
      removeImage.addEventListener('click', () => {
        controls.get('img').control.value = ''; setValidation('img'); changed('img', ''); controls.get('img').control.focus();
      }, optionsFor(signal));
      section.append(hint, imageState, removeImage);
    }
    detailGrid.append(section);
  }
  detailGrid.append(itemRulesEditor({doc,t,type,data,changed,canEdit,skills:env.skills,pools:env.pools,powers:env.powers}));
  let previousImage;
  function display(path) {
    const value = data()[path];
    if (value === '' || value === null || value === undefined) return t('item.emptyValue');
    if (path === 'die') return String(value).startsWith('d') ? String(value) : `d${value}`;
    if (path === 'attribute' && ['agility', 'smarts', 'spirit', 'strength', 'vigor'].includes(value)) return t(`attribute.${value}`);
    return String(value);
  }
  function refresh() {
    updateCounters();
    for (const {path, output} of proseOutputs) {
      const text = String(data()[path] || ''); bindTranslation(output, 'textContent', () => text || t(path === 'description' ? 'item.descriptionEmpty' : 'item.notesEmpty'));
      output.classList.toggle('gws-item-empty', !text);
    }
    for (const {path, output} of outputs) bindTranslation(output, 'textContent', () => display(path));
    const src = itemImageUrl(data().img, doc.baseURI);
    if (src !== previousImage) {
      previousImage = src; image.hidden = true; placeholder.hidden = false; portrait.dataset.imageState = src ? 'loading' : 'empty';
      bindTranslation(portrait, 'aria-label', () => t(src ? 'item.image' : 'item.imageEmpty'));
      bindTranslation(imageState, 'textContent', () => t(data().img ? 'item.imageInvalid' : 'item.imageEmpty')); imageState.hidden = !!src;
      if (src) image.src = src; else image.removeAttribute('src');
    }
    removeImage.disabled = !canEdit() || !data().img;
    reading.replaceChildren();
    for (const path of [...(factFields[type] || []), 'source']) {
      if (data()[path] === '' || data()[path] === null || data()[path] === undefined) continue;
      const row = element(doc, 'div'); row.append(element(doc, 'dt', '', () => t(`item.field.${path}`)), element(doc, 'dd', '', () => display(path))); reading.append(row);
    }
    reading.hidden = !reading.childElementCount;
    summaryEmpty.hidden = !!reading.childElementCount;
  }
  function updateCounters() { for (const {control, counter} of counters) bindTranslation(counter, 'textContent', () => t('item.characters', {count: control.value.length, max: control.maxLength})); }
  refresh(); activate(active); root.refresh = refresh; root.validate = validate; root.showError = showError;
  root.clearError = () => { localNotice.hidden = true; };
  root.refreshLanguage = () => {refreshTranslations(root); for (const path of [...validations.keys()]) validateField(path);};
  root.initialFocus = '[data-gws-item-field="core.name"]'; return root;
}

/** Mount the native library item document using only the scoped public API. */
export async function mountItemSheet(block, system = {}) {
  const {root, context, api, signal} = block, doc = root.ownerDocument;
  const t = system.t || ((key, params) => api.i18n.t(key, params));
  const raw = await api.items.get(context.itemId, {}, optionsFor(signal));
  if (signal?.aborted) return;
  const initial = {...raw, canEdit: raw.canEdit === true && context.canEdit !== false};
  const shell = element(doc, 'form', 'gws-sheet gws-item-sheet'), notice = element(doc, 'p', 'gws-item-notice');
  shell.setAttribute('translate', 'no'); shell.noValidate = true; shell.addEventListener('submit', event => event.preventDefault(), optionsFor(signal));
  notice.setAttribute('role', 'alert'); notice.hidden = true;
  const footer = element(doc, 'footer', 'gws-item-statusbar'), indicator = element(doc, 'span', 'gws-save-status');
  indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite');
  const retry = element(doc, 'button', 'gws-button', () => t('common.retry')); retry.type = 'button'; retry.hidden = true; footer.append(indicator, retry);
  const recovery = element(doc, 'button', 'gws-button', () => t('item.recoverConflict')); recovery.type = 'button'; recovery.hidden = true; footer.append(recovery);
  const state = {tab: 'description'};
  let disposed = false, refreshing, editor, recoveryModal;
  function showError(error) {
    if (disposed || signal?.aborted) return;
    bindTranslation(notice, 'textContent', () => t(error.code === 'conflict' ? 'common.conflict' : error.code === 'validation' ? 'item.validationError' : 'common.saveError')); notice.hidden = false;
    retry.hidden = error.code === 'conflict';
    if (error.code === 'validation') retry.hidden = true;
    recovery.hidden = error.code !== 'conflict'; editor?.showError(error);
  }
  const controller = createItemSaveController({item: initial, write: (payload, options) => api.items.update(payload, options), signal,
    onStatus(status) {
      indicator.dataset.state = status;
      bindTranslation(indicator, 'textContent', () => t({saved: 'common.saved', saving: 'common.saving', waiting: 'common.waiting', error: 'common.saveError', readonly: 'common.readOnly'}[status]));
      if (status === 'saved') {notice.hidden = true; editor?.clearError();}
      if (status !== 'error') retry.hidden = true;
      if (status === 'saved' || status === 'readonly') recovery.hidden = true;
    }, onError: showError});
  function render() {
    editor = itemEditor({doc, t, type: controller.item.type, data: () => controller.item.data, name: () => controller.item.name,
      canEdit: () => editable(controller.item), changed: controller.change, signal, state, beforeTabChange: controller.flush, onError: showError});
    shell.replaceChildren(notice, editor, footer);
  }
  function flush() {
    if (editor && !editor.validate()) {
      const error = Object.assign(new Error(t('item.validationError')), {code: 'validation'}); showError(error); return Promise.reject(error);
    }
    return controller.flush();
  }
  retry.addEventListener('click', () => { void flush().catch(showError); }, optionsFor(signal));
  recovery.addEventListener('click', () => {
    if (recoveryModal?.isConnected) { recoveryModal.focus(); return; }
    const modal = openModal(api, doc, () => t('item.recoverConflict'), signal, () => t('common.close')); recoveryModal = modal;
    const body = element(doc, 'div', 'gws-modal-body'), message = element(doc, 'p', '', () => t('item.reloadConfirm'));
    const errorNotice = element(doc, 'p', 'gws-item-notice'); errorNotice.setAttribute('role', 'alert'); errorNotice.hidden = true;
    const actions = element(doc, 'div', 'gws-item-recovery-actions'), reload = element(doc, 'button', 'gws-button', () => t('item.reloadAction'));
    const cancel = element(doc, 'button', 'gws-button', () => t('common.cancel')); reload.type = cancel.type = 'button'; actions.append(cancel, reload);
    cancel.addEventListener('click', () => modal.close(), optionsFor(signal));
    reload.addEventListener('click', async () => {
      reload.disabled = true; errorNotice.hidden = true;
      try {
        const current = await api.items.get(context.itemId, {}, optionsFor(signal));
        if (disposed || signal?.aborted || !modal.isConnected) return;
        if (controller.reload({...current, canEdit: current.canEdit === true && context.canEdit !== false})) {
          notice.hidden = true; recovery.hidden = true; render(); await modal.close();
        }
      } catch (error) { if (!disposed && !signal?.aborted) { bindTranslation(errorNotice, 'textContent', () => t('sheet.loadError')); errorNotice.hidden = false; } }
      finally { reload.disabled = false; }
    }, optionsFor(signal));
    body.append(message, errorNotice, actions); modal.append(body); cancel.focus();
  }, optionsFor(signal));
  root.replaceChildren(shell); render();
  const window = root.closest('.item-sheet,.gw-window') || root;
  const flushHandler = event => event.detail?.waitUntil(flush().catch(error => { showError(error); throw error; }));
  window.addEventListener('gravewright:sheet-flush', flushHandler, optionsFor(signal));
  async function refresh() {
    if (disposed || signal?.aborted || controller.dirty || controller.saving) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const current = await api.items.get(context.itemId, {}, optionsFor(signal));
      if (disposed || signal?.aborted) return;
      if (current.version !== controller.item.version || current.canEdit !== controller.item.canEdit) {
        if (controller.replace({...current, canEdit: current.canEdit === true && context.canEdit !== false})) render();
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  const unsubscribe = api.events?.on('items.changed', () => { void refresh().catch(showError); });
  const unsubscribeLanguage = system.subscribeLanguage?.(() => {
    if (disposed || signal?.aborted) return;
    refreshTranslations(shell); editor?.refreshLanguage();
    if (recoveryModal?.isConnected) refreshTranslations(recoveryModal);
  });
  function dispose() {
    if (disposed) return;
    disposed = true; controller.dispose(); unsubscribe?.(); unsubscribeLanguage?.();
    window.removeEventListener('gravewright:sheet-flush', flushHandler);
    system.listeners?.delete(refresh);
  }
  signal?.addEventListener('abort', dispose, {once: true}); block.onDispose?.(dispose);
  system.listeners?.add(refresh);
  return {flush, refresh, dispose};
}
