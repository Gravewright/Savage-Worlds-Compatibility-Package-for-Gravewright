"""Chromium checks the customization UI with public SDK/modal test adapters.

The native database/deck importer integration is covered separately by E2E tests.
Only this package is served; no host data directory or environment file is exposed.
"""

import base64
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="
)
ROOT = Path(os.environ.get('GRAVEWRIGHT_TEST_HOST_ROOT', Path(__file__).resolve().parents[3])).resolve()
NATIVE_FILES = {
    "/static/gravewright_table/modal.js": ROOT / "gravewright/table/static/gravewright_table/modal.js",
    "/static/gravewright_web/escape.js": ROOT / "gravewright/web/static/gravewright_web/escape.js",
}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path in NATIVE_FILES:
            raw = NATIVE_FILES[self.path].read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        elif self.path.startswith("/assets/action-decks/"):
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PIXEL)))
            self.end_headers()
            self.wfile.write(PIXEL)
        else:
            super().do_GET()


def main():
    source = Path(__file__).resolve().parents[1]
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(source)))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.evaluate(r"""async () => {
              const {openCustomization}=await import('/customize.js');
              const {createSettingsManager,normalizeSettings,SETTINGS_KEY}=await import('/settings.js');
              const {mountModal}=await import('/static/gravewright_table/modal.js');
              const catalogs=Object.fromEntries(await Promise.all(['en','pt-BR','es'].map(async locale=>[locale,await fetch('/locales/'+locale+'.json').then(response=>response.json())])));
              let words=catalogs.en;
              const t=(key,params={})=>Object.entries(params).reduce((text,[name,value])=>text.replaceAll('{'+name+'}',String(value)),words[key]||key);
              const style=document.createElement('link');style.rel='stylesheet';style.href='/styles.css';document.head.append(style);
              const nativeStyle=document.createElement('style');nativeStyle.textContent='body{margin:0;background:#171a1e} .table-modal-window{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:100;display:block}';document.head.append(nativeStyle);
              document.body.replaceChildren();const opener=document.createElement('button');opener.textContent='Customize';opener.id='opener';document.body.append(opener);
              const rows=new Map(),nativeDecks=[{id:'existing',name:'Existing native deck',draw_count:54,discard_count:0}],counts={uploads:0,define:0,instantiate:0,saves:0};
              const storage={table:{get:async key=>structuredClone(rows.get(key)||null),set:async(key,value,{expectedRevision})=>{
                const old=rows.get(key);if((old?.revision??null)!==expectedRevision)throw Object.assign(Error('conflict'),{code:'conflict'});
                const next={value:structuredClone(value),revision:(old?.revision??0)+1};rows.set(key,next);counts.saves++;return structuredClone(next);
              }},user:{get:async()=>null,set:async(_key,value)=>({value:structuredClone(value),revision:1})}};
              let system,abort,context,isGM=true;const languageListeners=new Set();
              const api={cards:{state:async()=>({isGM,decks:structuredClone(nativeDecks)}),define:async()=>{counts.define++;return{deck:{id:'definition'}};},instantiate:async()=>{counts.instantiate++;nativeDecks.push({id:'imported',name:'Imported native deck',draw_count:54,discard_count:0});return{id:'imported'};}},ui:{openModal:mountModal}};
              const catalog={schemaVersion:1,themes:['ivory','gravewright','adventure'].map(id=>({id,titleKey:`settings.deck.${id}.title`,descriptionKey:`settings.deck.${id}.description`,back:`assets/action-decks/${id}/back.webp`,preview:`assets/action-decks/${id}/preview.webp`,cards:Array.from({length:54},(_,index)=>({name:`Test card ${index}`,front:`assets/action-decks/${id}/front-${index}.webp`}))}))};
              async function setup(gm=true){abort?.abort();system?.settings.dispose();isGM=gm;abort=new AbortController();
                const settings=createSettingsManager({api,storage,signal:abort.signal,pollInterval:0});await settings.start();system={t,settings,subscribeLanguage(callback){languageListeners.add(callback);return()=>languageListeners.delete(callback);}};
                context={api,storage,signal:abort.signal,assets:{json:async()=>structuredClone(catalog),url:path=>'/'+path,bytes:async path=>(await fetch('/'+path)).arrayBuffer()},
                  host:{call:async(name,payload)=>{if(name!=='card.asset.upload'||!(payload.file instanceof File)||(await payload.file.arrayBuffer()).byteLength<1)throw Error('Invalid public file upload');counts.uploads++;return{assetId:'asset-'+counts.uploads};}},onDispose:callback=>abort.signal.addEventListener('abort',callback,{once:true})};
              }
              async function open(){opener.focus();return openCustomization(context,system);}
              async function idle(){for(let index=0;index<100;index++){if(!document.querySelector('.gws-customization')||document.querySelector('.gws-customization').getAttribute('aria-busy')==='false')return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Customization stayed busy');}
              async function remote(label){const current=rows.get(SETTINGS_KEY);rows.set(SETTINGS_KEY,{value:{...normalizeSettings(current?.value),currency:{enabled:true,label}},revision:(current?.revision??0)+1});await system.settings.refresh();}
              function language(locale){words=catalogs[locale];for(const callback of [...languageListeners])callback();}
              function compatibility(state){system.compatibility={current:{state,active:state==='absent'?false:null,installed:[],isOwner:true},subscribe:()=>()=>{},async refresh(){if(state==='unknown')throw Object.assign(Error('unavailable'),{code:'legacy-status-unavailable'});return this.current;}};}
              await setup();window.harness={open,setup,idle,remote,language,compatibility,counts,words,rows,settings:()=>system.settings,key:SETTINGS_KEY};await open();
            }""")
            page.wait_for_function("[...document.querySelectorAll('.gws-deck-cover')].every(image=>image.naturalWidth>0)")
            assert page.locator(".gws-deck-option").count() == 3
            words = page.evaluate("harness.words")
            # Locale notifications update labels without discarding the settings draft.
            page.get_by_role("tab", name=words["settings.tableRules"], exact=True).click()
            page.evaluate("harness.idle()")
            page.locator("[data-gws-currency-label]").fill("Vigor")
            page.evaluate("window.currencyInput=document.querySelector('[data-gws-currency-label]');currencyInput.focus();currencyInput.setSelectionRange(1,3)")
            saves_before=page.evaluate("harness.counts.saves")
            for locale in ('es','pt-BR','en'):
                page.evaluate("locale=>harness.language(locale)",locale)
                assert page.evaluate("document.querySelector('[data-gws-currency-label]')===currencyInput")
                assert page.locator("[data-gws-currency-label]").input_value()=="Vigor"
                assert page.evaluate("[currencyInput.selectionStart,currencyInput.selectionEnd]")==[1,3]
                assert page.locator("[data-gws-currency-label]").evaluate("e=>e===document.activeElement")
                expected=page.evaluate("async locale=>(await fetch('/locales/'+locale+'.json').then(r=>r.json()))['settings.currencyName']",locale)
                assert page.locator("[data-gws-currency-label]").get_attribute('aria-label')==expected
                assert page.evaluate("harness.counts.saves")==saves_before
            page.get_by_role("tab", name=words["settings.decks"], exact=True).click()
            page.evaluate("harness.idle()")
            page.get_by_role("button", name=words["settings.preview"], exact=True).first.click()
            page.wait_for_selector(".gws-deck-preview .gws-card-preview")
            assert page.locator(".gws-deck-preview .gws-card-preview").count() == 54
            page.keyboard.press("Escape")
            page.wait_for_selector(".gws-deck-preview", state="detached")
            assert page.evaluate("document.querySelector('.gws-customization').contains(document.activeElement)")
            page.locator(".gws-customization .gws-modal-close").focus()
            page.keyboard.press("Shift+Tab")
            assert page.evaluate("document.querySelector('.gws-customization').contains(document.activeElement)")
            page.keyboard.press("Tab")
            assert page.locator(".gws-customization .gws-modal-close").evaluate("element=>element===document.activeElement")
            page.get_by_role("tab", name=words["settings.tableRules"], exact=True).click()
            page.evaluate("harness.idle()")
            currency = page.locator("[data-gws-currency-label]")
            currency.fill("Credits")
            page.locator("[data-gws-rule=jokersWild]").uncheck()
            assert page.evaluate("harness.settings().current.currency.label") == ""
            page.get_by_role("tab", name=words["settings.decks"], exact=True).click()
            page.evaluate("harness.idle()")
            page.locator(".gws-settings-group select").select_option("existing")
            page.get_by_role("button", name=words["settings.useDeck"], exact=True).click()
            page.evaluate("harness.idle()")
            page.get_by_role("tab", name=words["settings.tableRules"], exact=True).click()
            page.evaluate("harness.idle()")
            assert page.locator("[data-gws-currency-label]").input_value() == "Credits"
            assert not page.locator("[data-gws-rule=jokersWild]").is_checked()
            page.locator("[data-gws-save]").click()
            page.evaluate("harness.idle()")
            assert page.evaluate("harness.settings().current.deck.instanceId") == "existing"
            assert page.evaluate("harness.settings().current.currency.label") == "Credits"
            currency = page.locator("[data-gws-currency-label]")
            currency.fill("Draft value")
            currency.evaluate("element=>element.setSelectionRange(2,5)")
            page.evaluate("harness.remote('Remote value')")
            assert currency.input_value() == "Draft value"
            assert currency.evaluate("element=>[element.selectionStart,element.selectionEnd]") == [2, 5]
            page.locator("[data-gws-save]").click()
            page.evaluate("harness.idle()")
            assert page.locator(".gws-customize-notice").inner_text() == words["settings.conflict"]
            assert page.locator("[data-gws-currency-label]").input_value() == "Draft value"
            page.get_by_role("button", name=words["settings.reload"], exact=True).click()
            page.evaluate("harness.idle()")
            assert page.locator("[data-gws-currency-label]").input_value() == "Remote value"
            page.keyboard.press("Escape")
            page.wait_for_selector(".gws-customization", state="detached")
            assert page.evaluate("document.activeElement.id") == "opener"
            page.evaluate("harness.setup(false)")
            page.evaluate("harness.open()")
            assert page.locator("[data-gws-deck-theme]:enabled").count() == 0
            page.get_by_role("tab", name=words["settings.tableRules"], exact=True).click()
            page.evaluate("harness.idle()")
            assert page.locator(".gws-customization input:enabled").count() == 0
            assert page.locator("[data-gws-save]").count() == 0
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth<=document.documentElement.clientWidth")
            assert page.locator(".gws-customization").evaluate("element=>element.scrollWidth<=element.clientWidth")
            page.keyboard.press("Escape")
            page.wait_for_selector(".gws-customization", state="detached")
            # Fresh installations have no migration control. A failed status
            # read still permits opening the native recovery modal.
            page.evaluate("harness.setup(true)")
            page.evaluate("harness.compatibility('absent');harness.open()")
            page.get_by_role("tab", name=words["permission.about"], exact=True).click()
            page.evaluate("harness.idle()")
            assert page.locator('[data-gws-legacy-migration]').count() == 0
            page.keyboard.press("Escape")
            page.wait_for_selector(".gws-customization", state="detached")
            page.evaluate("harness.compatibility('unknown');harness.open()")
            page.get_by_role("tab", name=words["permission.about"], exact=True).click()
            page.evaluate("harness.idle()")
            page.locator('[data-gws-legacy-migration]').get_by_role('button', name=words['legacy.title'], exact=True).click()
            page.locator('.gws-legacy-migration').wait_for(state='visible')
            assert words['legacy.unknown'] in page.locator('.gws-legacy-migration').inner_text()
            page.keyboard.press('Escape')
            page.wait_for_selector('.gws-legacy-migration', state='detached')
            page.keyboard.press('Escape')
            page.wait_for_selector('.gws-customization', state='detached')
            assert page.locator("dialog").count() == 0
            assert not errors, errors
            print({"themes": 3, "previewFaces": 54, "draftPreserved": True, "CASConflict": True,
                   "focusedSelectionPreserved": True, "escapeRestoresFocus": True, "readonly": True,
                   "mobileNoOverflow": True, "liveLocaleDraftPreservation": True, "freshInstallNoMigration": True,
                   "unavailableLegacyRecovery": True, "noDialogTag": True, "pageErrors": errors})
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
