/** Package-owned table settings. Actor overrides are never written by inheritance. */
export const SETTINGS_KEY = 'settings.table';
export const RULE_DEFAULTS = Object.freeze({noPowerPoints:false, woundCap:false, jokersWild:true, enableWoundPace:true, applyEncumbrance:true});
export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const rules = {};
  for (const [key, fallback] of Object.entries(RULE_DEFAULTS)) rules[key] = typeof value.rules?.[key] === 'boolean' ? value.rules[key] : fallback;
  return {schemaVersion:1,
    currency:{enabled:value.currency?.enabled !== false, label:typeof value.currency?.label === 'string' ? value.currency.label.trim().slice(0,60) : ''},
    rules, deck:{instanceId:typeof value.deck?.instanceId === 'string' ? value.deck.instanceId.slice(0,130) : '',
      themeId:['ivory','gravewright','adventure'].includes(value.deck?.themeId) ? value.deck.themeId : '',
      name:typeof value.deck?.name === 'string' ? value.deck.name.slice(0,120) : ''},
  };
}
export function effectiveRules(sheet, settings) {
  const defaults = normalizeSettings(settings).rules, result = {...(sheet?.rules ?? {})};
  for (const [key, fallback] of Object.entries(defaults)) result[key] = typeof sheet?.rules?.[key] === 'boolean' ? sheet.rules[key] : fallback;
  return result;
}
export function currencyLabel(settings, t = key => key) {return normalizeSettings(settings).currency.label || t('rules.gold');}
export function validateSettings(value) {
  if (typeof value?.currency?.label !== 'string' || value.currency.label.trim().length > 60) throw Object.assign(new Error('settings-invalid'), {code:'settings-invalid'});
  return normalizeSettings(value);
}

export function createSettingsManager({api, storage, signal, pollInterval = 2000}) {
  let record = null, current = normalizeSettings(), isGM = false, disposed = false, pending, timer;
  const listeners = new Set();
  function publish(next) {
    const normalized = normalizeSettings(next?.value), changed = JSON.stringify(normalized) !== JSON.stringify(current) || next?.revision !== record?.revision;
    record = next; current = normalized;
    if (changed && !disposed) for (const callback of listeners) callback(structuredClone(current));
  }
  async function refresh() {
    if (!pending) pending = Promise.all([storage.table.get(SETTINGS_KEY), api.cards.state()]).then(([next, cards]) => {
      if (disposed) return current;
      isGM = cards.isGM === true; publish(next); return structuredClone(current);
    }).finally(() => {pending = undefined;});
    return pending;
  }
  async function save(value, {expectedRevision = record?.revision ?? null} = {}) {
    if (!isGM) throw Object.assign(new Error('permission_denied'), {code:'permission_denied'});
    const normalized = validateSettings(value), next = await storage.table.set(SETTINGS_KEY, normalized, {expectedRevision});
    publish(next); return structuredClone(current);
  }
  function dispose() {disposed = true; clearTimeout(timer); listeners.clear();}
  function schedule() {
    if (disposed || signal?.aborted || pollInterval <= 0) return;
    timer = setTimeout(async () => {try {await refresh();} catch { /* Reconnect rereads shared settings; existing sheets retain the last confirmed rules. */ } schedule();}, pollInterval);
  }
  signal?.addEventListener('abort', dispose, {once:true});
  return {get current(){return structuredClone(current);}, get revision(){return record?.revision ?? null;}, get isGM(){return isGM;},
    refresh, save, subscribe(callback){listeners.add(callback);return () => listeners.delete(callback);},
    async start(){await refresh();schedule();}, dispose};
}
