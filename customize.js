import {el, openModal, bindTranslation, refreshTranslations} from './ui.js';
import {RULE_DEFAULTS} from './settings.js';
import {createDeckImporter, validateDeckCatalog} from './deck-importer.js';
import {PUBLIC_PACKAGE_NAME, OFFICIAL_LOGO, PERMISSION_NOTICE} from './permission.js';

/** Optional native module hook: every control and asset belongs to this package. */
export async function openCustomization(context, system) {
  if (system.customization?.isConnected) {system.customization.querySelector('button')?.focus();return;}
  const {api,assets,storage,signal} = context, t = system.t, doc = globalThis.document;
  await system.settings.refresh();
  const modal = openModal(api,doc,()=>t('settings.title'),signal,()=>t('common.close'));
  modal.classList.add('gws-customization'); system.customization = modal;
  const body = el(doc,'div','gws-modal-body'), notice = el(doc,'p','gws-customize-notice'); notice.setAttribute('role','status'); notice.hidden = true;
  const tabs = el(doc,'nav','gws-tabs');bindTranslation(tabs,'aria-label',()=>t('settings.title'));
  const content = el(doc,'div','gws-customize-content'); body.append(tabs,notice,content); modal.append(body);
  let tab = 'decks', draft = system.settings.current, base = system.settings.current, revision = system.settings.revision, dirty = false, busy = false, work, catalog, decks = [], cancelImport;
  const importer = createDeckImporter(context);
  const tabButtons = new Map();
  const previews = new Set();
  function message(key, params) {bindTranslation(notice,'textContent',()=>t(key,params)); notice.hidden = !key; notice.setAttribute('role',key.includes('error') || key.includes('conflict') ? 'alert':'status');}
  function button(key, task, disabled = false) {
    const node = el(doc,'button','gws-button',()=>t(key)); node.type = 'button';node.disabled = disabled;
    node.onclick = () => {void run(task).catch(() => {});}; return node;
  }
  function updateBusy(value) {
    busy = value;modal.setAttribute('aria-busy',String(value));
    for (const node of modal.querySelectorAll('button,input,select')) {
      if (node.closest('.gws-modal-title')) continue;
      node.disabled = value || node.dataset.gwsReadOnly === 'true';
    }
  }
  async function run(task) {
    if (busy || signal.aborted) return;
    updateBusy(true); message('');
    work = Promise.resolve().then(task);
    try {await work;} catch (error) {
      if (error.code === 'cancelled') message('settings.importPaused');
      else message(error.code === 'conflict' ? 'settings.conflict' : error.code === 'host-update-required' ? 'settings.hostUpdateRequired' : 'settings.error');
    } finally {work = null; if (modal.isConnected) {updateBusy(false);render();}}
  }
  function mark() {dirty = true;content.querySelector('[data-gws-save]')?.removeAttribute('disabled');}
  function field(title, description, control) {
    const label = el(doc,'label','gws-setting-field'), copy = el(doc,'span','gws-setting-copy');
    bindTranslation(control,'aria-label',()=>t(title));
    copy.append(el(doc,'strong','',()=>t(title)));if(description)copy.append(el(doc,'small','gws-field-hint',()=>t(description)));
    label.append(copy,control);return label;
  }
  function checkbox(key, description, checked, change) {
    const input = el(doc,'input'); input.type = 'checkbox';input.checked = checked;input.disabled = !system.settings.isGM;
    input.dataset.gwsReadOnly = String(!system.settings.isGM);input.onchange = () => {change(input.checked);mark();};
    return field(key,description,input);
  }
  function group(title) {const section=el(doc,'section','gws-settings-group');section.append(el(doc,'h3','',()=>t(title)));return section;}
  async function chooseDeck(choice) {
    await system.settings.refresh();
    const next = system.settings.current;
    if(dirty && (JSON.stringify(next.rules)!==JSON.stringify(base.rules) || JSON.stringify(next.currency)!==JSON.stringify(base.currency)))throw Object.assign(new Error('conflict'),{code:'conflict'});
    next.deck = choice;
    await system.settings.save(next,{expectedRevision:system.settings.revision});
    base = system.settings.current;
    draft = dirty ? {...base,currency:draft.currency,rules:draft.rules} : base;
    revision = system.settings.revision; message('settings.deckSelected',{name:choice.name});
    decks = (await api.cards.state()).decks;
  }
  function preview(theme) {
    const window = openModal(api,doc,()=>t(theme.titleKey),signal,()=>t('common.close')); window.classList.add('gws-deck-preview');
    previews.add(window);window.addEventListener('close',()=>previews.delete(window),{once:true});
    const grid=el(doc,'div','gws-modal-body gws-card-gallery');
    for(const card of theme.cards) {const figure=el(doc,'figure','gws-card-preview'),img=el(doc,'img');img.src=assets.url(card.front);img.alt=card.name;img.loading='lazy';figure.append(img,el(doc,'figcaption','',card.name));grid.append(figure);}
    window.append(grid);
  }
  function renderDecks() {
    const info=el(doc,'p','gws-field-hint',()=>t('settings.deckHint'));content.append(info);
    const gallery=el(doc,'div','gws-deck-gallery');content.append(gallery);
    for(const theme of catalog.themes) {
      const section=el(doc,'section','gws-deck-option'),image=el(doc,'img','gws-deck-cover');image.src=assets.url(theme.preview);bindTranslation(image,'alt',()=>t(theme.titleKey));image.loading='lazy';
      const heading=el(doc,'div','gws-deck-heading');heading.append(el(doc,'h3','',()=>t(theme.titleKey)));
      const selected=draft.deck.themeId===theme.id && decks.some(deck=>deck.id===draft.deck.instanceId);
      if(selected){section.classList.add('gws-deck-selected');heading.append(el(doc,'span','gws-deck-badge',()=>t('settings.selected')));}
      const actions=el(doc,'div','gws-deck-actions');
      const see=button('settings.preview',()=>preview(theme));
      const use=button(selected?'settings.useAgain':'settings.createAndUse',async()=>{
        let choice;
        if(selected)choice={...draft.deck};
        else {
          const shared=system.settings.current.deck;
          if(shared.themeId===theme.id && decks.some(deck=>deck.id===shared.instanceId))choice=shared;
          else {
            cancelImport=new AbortController();
            const progress=el(doc,'progress','gws-import-progress');progress.max=55;progress.value=0;content.prepend(progress);
            choice=await importer.importTheme(theme,{name:t(theme.titleKey),signal:cancelImport.signal,
              onProgress:state=>{progress.value=state.completed;message(state.stage==='images'?'settings.importProgress':'settings.importFinishing',state);}});
          }
        }
        await chooseDeck(choice);cancelImport=null;
      },!system.settings.isGM);use.dataset.gwsReadOnly=String(!system.settings.isGM);use.dataset.gwsDeckTheme=theme.id;
      actions.append(see,use);section.append(image,heading,el(doc,'p','gws-field-hint',()=>t(theme.descriptionKey)),el(doc,'small','',()=>t('settings.cardCount')),actions);gallery.append(section);
    }
    const existing=group('settings.existingDeck'), select=el(doc,'select');bindTranslation(select,'aria-label',()=>t('settings.existingDeck'));select.disabled=!system.settings.isGM;select.dataset.gwsReadOnly=String(!system.settings.isGM);
    const empty=el(doc,'option','',()=>t('settings.chooseDeck'));empty.value='';select.append(empty);
    for(const deck of decks){const option=el(doc,'option','',deck.name);option.value=deck.id;select.append(option);}select.value=decks.some(deck=>deck.id===draft.deck.instanceId)?draft.deck.instanceId:'';
    const choose=button('settings.useDeck',async()=>{
      const current=(await api.cards.state()).decks.find(deck=>deck.id===select.value);if(!current)throw Object.assign(new Error('deck-required'),{code:'deck-required'});
      await chooseDeck({instanceId:current.id,name:current.name,themeId:''});
    },!system.settings.isGM || !select.value);choose.dataset.gwsReadOnly=String(!system.settings.isGM);select.onchange=()=>{choose.disabled=!system.settings.isGM || !select.value;};
    existing.append(el(doc,'p','gws-field-hint',()=>t('settings.existingDeckHint')),select,choose);content.append(existing);
  }
  function renderRules() {
    const currency=group('settings.currency');currency.append(checkbox('settings.showCurrency','settings.showCurrencyHint',draft.currency.enabled,value=>{draft.currency.enabled=value;}));
    const name=el(doc,'input');name.type='text';name.maxLength=60;name.value=draft.currency.label;bindTranslation(name,'placeholder',()=>t('rules.gold'));name.disabled=!system.settings.isGM;name.dataset.gwsReadOnly=String(!system.settings.isGM);name.dataset.gwsCurrencyLabel='';name.oninput=()=>{draft.currency.label=name.value;mark();};currency.append(field('settings.currencyName','settings.currencyNameHint',name));content.append(currency);
    const rules=group('settings.rules');rules.append(el(doc,'p','gws-field-hint',()=>t('settings.inheritHint')));
    rules.append(checkbox('settings.usePowerPoints','settings.usePowerPointsHint',!draft.rules.noPowerPoints,value=>{draft.rules.noPowerPoints=!value;}));
    for(const key of Object.keys(RULE_DEFAULTS).filter(key=>key!=='noPowerPoints')) {
      const row=checkbox(`settings.rule.${key}`,`settings.rule.${key}.hint`,draft.rules[key],value=>{draft.rules[key]=value;});row.querySelector('input').dataset.gwsRule=key;rules.append(row);
    }
    content.append(rules);
    if(system.settings.isGM) {
      const footer=el(doc,'footer','gws-modal-footer'),reload=button('settings.reload',async()=>{await system.settings.refresh();draft=base=system.settings.current;revision=system.settings.revision;dirty=false;message('');});
      const save=button('common.save',async()=>{
        await system.settings.save(draft,{expectedRevision:revision});revision=system.settings.revision;draft=base=system.settings.current;dirty=false;message('settings.saved');
      },!dirty);save.dataset.gwsSave='';footer.append(reload,save);content.append(footer);
    }
  }
  function renderAbout() {
    const section=el(doc,'section','gws-package-about'), logo=el(doc,'img','gws-permission-logo');
    logo.src=assets.url(OFFICIAL_LOGO);logo.alt='Savage Worlds Fan Product';
    const copy=el(doc,'div','gws-package-about-copy');
    copy.append(el(doc,'h3','',PUBLIC_PACKAGE_NAME),el(doc,'p','',()=>t('permission.scope')));
    const notice=el(doc,'p','gws-permission-notice',PERMISSION_NOTICE);notice.lang='en';notice.setAttribute('translate','no');
    const website=el(doc,'a','gws-button',()=>t('permission.officialRules'));website.href='https://peginc.com/';website.target='_blank';website.rel='noopener noreferrer';
    copy.append(notice,website);section.append(logo,copy);content.append(section);
  }
  function render() {
    content.replaceChildren();
    for(const [id,node]of tabButtons)node.setAttribute('aria-selected',String(tab===id));
    if(!system.settings.isGM)content.append(el(doc,'p','gws-readonly',()=>t('settings.readOnly')));
    if(!catalog){content.append(el(doc,'p','',()=>t('common.loading')));return;}
    if(tab==='decks')renderDecks();else if(tab==='rules')renderRules();else renderAbout();
    if(busy)updateBusy(true);
  }
  for(const [id,key]of [['decks','settings.decks'],['rules','settings.tableRules'],['about','permission.about']]){const node=button(key,()=>{tab=id;render();});node.setAttribute('role','tab');tabButtons.set(id,node);tabs.append(node);}tabs.setAttribute('role','tablist');
  const unsubscribe=system.settings.subscribe(()=>{
    if(!modal.isConnected || busy)return;
    if(dirty){message('settings.externalChange');return;}
    draft=base=system.settings.current;revision=system.settings.revision;
    // A background refresh must not replace a focused text field or its selection.
    if(!content.contains(doc.activeElement))render();
  });
  const unsubscribeLanguage=system.subscribeLanguage?.(()=>{
    refreshTranslations(modal);for(const preview of previews)if(preview.isConnected)refreshTranslations(preview);
  });
  modal.addEventListener('gravewright:sheet-flush',event=>event.detail?.waitUntil?.(work ?? Promise.resolve()));
  modal.addEventListener('close',()=>{unsubscribe();unsubscribeLanguage?.();cancelImport?.abort();if(system.customization===modal)system.customization=null;},{once:true});
  context.onDispose?.(()=>{unsubscribe();unsubscribeLanguage?.();modal.close(true);});
  render();
  await run(async()=>{catalog=validateDeckCatalog(await assets.json('assets/action-decks/catalogue.json'));decks=(await api.cards.state()).decks;});
  return modal;
}
