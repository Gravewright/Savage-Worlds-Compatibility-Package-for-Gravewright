/** Explicitly import packaged artwork into the native deck service. No combat creates cards. */
const fail = code => Object.assign(new Error(code), {code});
const ids = new Set(['ivory','gravewright','adventure']);
export function validateDeckCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.themes) || catalog.themes.length !== 3) throw fail('deck-catalog-invalid');
  const themes = new Set();
  function path(value) {
    if (typeof value !== 'string' || !value.startsWith('assets/action-decks/') || /(?:^|\/)\.\.(?:\/|$)|[\\?#]/.test(value)) throw fail('deck-catalog-invalid');
  }
  for (const theme of catalog.themes) {
    if (!ids.has(theme.id) || themes.has(theme.id) || !Array.isArray(theme.cards) || theme.cards.length !== 54) throw fail('deck-catalog-invalid');
    themes.add(theme.id); path(theme.back); path(theme.preview);
    const names = new Set(), fronts = new Set();
    for (const card of theme.cards) {
      if (typeof card.name !== 'string' || !card.name.trim() || names.has(card.name)) throw fail('deck-catalog-invalid');
      path(card.front); if (fronts.has(card.front)) throw fail('deck-catalog-invalid'); names.add(card.name); fronts.add(card.front);
    }
  }
  return catalog;
}
export function createDeckImporter({api, host, assets, storage}) {
  let busy = false;
  const key = themeId => `deck.import.${themeId}`;
  async function record(themeId) {return storage.user.get(key(themeId));}
  async function importTheme(theme, {name, onProgress = () => {}, signal} = {}) {
    if (busy) throw fail('operation-busy');
    if (!ids.has(theme?.id) || theme.cards?.length !== 54) throw fail('deck-catalog-invalid');
    if (!host?.call) throw fail('host-update-required');
    if (!(await api.cards.state()).isGM) throw fail('permission_denied');
    busy = true;
    try {
      let saved = await record(theme.id);
      const native = await api.cards.state();
      if (saved?.value.deckId && native.decks.some(deck => deck.id === saved.value.deckId)) return {instanceId:saved.value.deckId, themeId:theme.id, name:saved.value.name};
      if (!saved) saved = await storage.user.set(key(theme.id), {schemaVersion:1,themeId:theme.id,name:String(name || theme.id).slice(0,120),assets:{},
        definitionRequest:globalThis.crypto.randomUUID(),instanceRequest:globalThis.crypto.randomUUID()}, {expectedRevision:null});
      // A removed instance is rebuilt from its existing definition, without duplicating image uploads.
      if (saved.value.deckId) saved = await storage.user.set(key(theme.id), {...saved.value,deckId:null,instanceRequest:globalThis.crypto.randomUUID()}, {expectedRevision:saved.revision});
      async function persist(patch) {
        saved = await storage.user.set(key(theme.id), {...saved.value,...patch}, {expectedRevision:saved.revision});
      }
      function check() {if (signal?.aborted) throw fail('cancelled');}
      const files = [{path:theme.back,purpose:'card_back'}, ...theme.cards.map(card => ({path:card.front,purpose:'card_front'}))];
      for (let index = 0; index < files.length; index++) {
        check(); const file = files[index];
        if (!saved.value.assets[file.path]) {
          const bytes = await assets.bytes(file.path); check();
          const content = new File([bytes], file.path.split('/').at(-1), {type:file.path.endsWith('.webp') ? 'image/webp' : 'image/png'});
          const uploaded = await host.call('card.asset.upload', {file:content,purpose:file.purpose});
          if (!uploaded?.assetId) throw fail('invalid_data');
          await persist({assets:{...saved.value.assets,[file.path]:uploaded.assetId}});
        }
        onProgress({completed:index+1,total:files.length,stage:'images'});
      }
      check(); onProgress({completed:files.length,total:files.length,stage:'deck'});
      if (!saved.value.definitionId) {
        const result = await api.cards.define({name:saved.value.name,default_back_asset_id:saved.value.assets[theme.back],
          cards:theme.cards.map(card => ({name:card.name,front_asset_id:saved.value.assets[card.front]}))}, {requestId:saved.value.definitionRequest});
        await persist({definitionId:result.deck.id});
      }
      check();
      if (!saved.value.deckId) {
        const result = await api.cards.instantiate({deck_definition_id:saved.value.definitionId}, {requestId:saved.value.instanceRequest});
        await persist({deckId:result.id});
      }
      onProgress({completed:files.length,total:files.length,stage:'complete'});
      return {instanceId:saved.value.deckId, themeId:theme.id, name:saved.value.name};
    } finally {busy = false;}
  }
  return {importTheme, record, get busy(){return busy;}};
}
