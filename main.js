import {mountActorSheet} from './sheet.js';
import {mountItemSheet} from './item-editor.js';
import {mountCombatTracker} from './tracker.js';
import {createSettingsManager} from './settings.js';
import {openCustomization} from './customize.js';

let system;
export default {
  async start(context) {
    if (!context.i18n?.register || !context.api?.i18n?.t || !context.api?.ui?.openModal) {
      throw new Error('Savage Worlds requires Gravewright VTT 0.2.2 or newer.');
    }
    const [locales, manifest] = await Promise.all([context.assets.json('locales.json'),context.assets.json('manifest.json')]);
    context.i18n.register(locales);
    context.styles.use('styles.css');
    const languageListeners = new Set();
    const active = system = {listeners:new Set(),version:manifest.version,
      t:(key,params)=>context.api.i18n.t(key,params),
      number:(value,options)=>context.api.i18n.number(value,options),
      subscribeLanguage(callback){languageListeners.add(callback);return()=>languageListeners.delete(callback);},
      languageListeners};
    active.unsubscribeLanguage = context.api.i18n.onChange?.(() => {
      for(const callback of [...languageListeners])callback();
    });
    const settings = createSettingsManager(context);
    system.settings = settings;
    await settings.start();
    context.onDispose?.(() => settings.dispose());
  },
  register({register}) {
    register('actor.sheet', {mode: 'replace', types: ['character', 'npc'], mount: block => mountActorSheet(block, system)});
    register('item.sheet', {mode: 'replace', mount: block => mountItemSheet(block, system)});
    register('combat.tracker', {mode:'replace', mount:block=>mountCombatTracker(block,system)});
  },
  customize(context) {return openCustomization(context,system);},
  stop() { system?.customization?.close(true); system?.settings.dispose(); system?.unsubscribeLanguage?.(); system?.languageListeners.clear(); system?.listeners.clear(); system = null; },
};
