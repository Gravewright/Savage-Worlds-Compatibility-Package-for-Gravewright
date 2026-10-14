"""Run from the host virtualenv to exercise the item editor in real Chromium."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    source = Path(__file__).resolve().parents[1]
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(source)))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            result = page.evaluate(r"""async () => {
              const {itemEditor,mountItemSheet}=await import('/item-editor.js');
              const {ITEM_TYPES,createItemSheet}=await import('/model.js');
              const locales=Object.fromEntries(await Promise.all(['en','pt-BR','es'].map(async locale=>[locale,await fetch('/locales/'+locale+'.json').then(r=>r.json())])));
              let language='en';const languageListeners=new Set();
              const t=(key,params={})=>Object.entries(params).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',v),locales[language][key]||key);
              const changeLanguage=locale=>{language=locale;for(const callback of languageListeners)callback();};
              for(const {id} of ITEM_TYPES){
                const data=createItemSheet(id),ed=itemEditor({doc:document,t,type:id,data:()=>data,name:()=>'',canEdit:true,changed:(k,v)=>data[k]=v});
                document.body.append(ed);ed.querySelector('[data-gws-item-tab=details]').click();await Promise.resolve();
                if(ed.querySelector('[data-gws-item-tab=details]').getAttribute('aria-selected')!=='true')throw Error('Cannot browse blank template '+id);
                ed.remove();
              }
              const data=createItemSheet('power');let name='Custom power';
              const ed=itemEditor({doc:document,t,type:'power',data:()=>data,name:()=>name,canEdit:true,onNameChange:v=>name=v,changed:(k,v)=>data[k]=v});document.body.append(ed);
              if(!ed.validate())throw Error('Blank optional fields fail validation');
              const nameInput=ed.querySelector('[data-gws-item-field="core.name"]');
              if(nameInput.maxLength!==120)throw Error('Name does not match native budget');
              nameInput.value='A'.repeat(121);nameInput.dispatchEvent(new Event('input'));
              if(ed.validate()||nameInput.getAttribute('aria-invalid')!=='true')throw Error('Oversized name has no inline validation');
              nameInput.value='A'.repeat(120);nameInput.dispatchEvent(new Event('input'));if(!ed.validate())throw Error('120 character name refused');
              const description=ed.querySelector('[data-gws-item-field=description]');description.value='<script>evil()</script>\nUser text';description.dispatchEvent(new Event('input'));
              ed.querySelector('.gws-item-modebar button').click();
              if(ed.querySelector('.gws-item-prose').textContent!==data.description||ed.querySelector('.gws-item-prose script'))throw Error('Read view unsafe');
              const number=ed.querySelector('[data-gws-item-field=powerPoints]');number.value='-1';number.dispatchEvent(new Event('input'));
              if(ed.validate()||number.getAttribute('aria-invalid')!=='true')throw Error('Inline number validation missing');
              number.value='3';number.dispatchEvent(new Event('input'));if(!ed.validate())throw Error('Validation does not recover');
              const image=ed.querySelector('[data-gws-item-field=img]');image.value='javascript:alert(1)';image.dispatchEvent(new Event('blur'));
              if(ed.validate()||data.img!=='')throw Error('Unsafe URL accepted');
              image.value='/media/item.png';image.dispatchEvent(new Event('blur'));if(!ed.validate()||data.img!=='/media/item.png')throw Error('Native URL refused');
              image.value='/media/typed-without-blur.png';image.dispatchEvent(new Event('input'));
              if(!ed.validate()||data.img!=='/media/typed-without-blur.png')throw Error('Closing without blur loses the image URL');
              const readonly=itemEditor({doc:document,t,type:'power',data:()=>data,name:()=>name,canEdit:false,changed:()=>{throw Error('Readonly changed');}});document.body.append(readonly);
              if(!readonly.querySelector('[data-gws-item-field=description]').readOnly||readonly.querySelector('[data-gws-item-field=description]').disabled)throw Error('Readonly prevents copy');
              if(readonly.querySelector('.gws-item-reading').hidden)throw Error('Readonly not reading');readonly.remove();ed.remove();
              const abort=new AbortController(),wrapper=document.createElement('div'),root=document.createElement('div');wrapper.className='item-sheet';wrapper.append(root);document.body.append(wrapper);
              let current={id:'item',type:'power',name:'Spirit',version:1,canEdit:true,data:createItemSheet('power')},conflict=true,updates=0;
              const api={i18n:{t},items:{get:async()=>structuredClone(current),update:async payload=>{
                updates++;if(conflict)throw Object.assign(Error('Stale'),{code:'conflict'});current={...current,...payload,version:current.version+1};return{item:structuredClone(current)};
              }},events:{on:()=>()=>{}},ui:{openModal:section=>{
                document.body.append(section);section.close=async force=>{
                  if(!force){const waits=[];section.dispatchEvent(new CustomEvent('gravewright:sheet-flush',{detail:{waitUntil:p=>waits.push(p)}}));await Promise.all(waits);}
                  section.dispatchEvent(new Event('close'));section.remove();
                };return section;
              }}};
              const mounted=await mountItemSheet({root,context:{itemId:'item',canEdit:true},api,signal:abort.signal},{t,listeners:new Set(),
                subscribeLanguage(callback){languageListeners.add(callback);return()=>languageListeners.delete(callback);}});
              const d=root.querySelector('[data-gws-item-field=description]');d.value='Unsaved draft';d.dispatchEvent(new Event('input'));d.focus();d.setSelectionRange(1,7);changeLanguage('pt-BR');
              if(root.querySelector('[data-gws-item-tab=description]').textContent!==t('item.description')||root.querySelector('[data-gws-item-field=description]')!==d||d.value!=='Unsaved draft'||document.activeElement!==d||d.selectionStart!==1||d.selectionEnd!==7||root.querySelector('[data-gws-item-field="core.name"]').value!=='Spirit'||updates)throw Error('Item language change lost authored values, focus or wrote a document');
              root.querySelector('[data-gws-item-tab=details]').click();await new Promise(r=>setTimeout(r,0));
              // Tab changes flush the pending edit through its original request.
              await mounted.flush().catch(()=>{});changeLanguage('es');
              const attribute=root.querySelector('[data-gws-item-field=rank]');
              if(attribute.getAttribute('aria-label')!==t('item.field.rank')||d.value!=='Unsaved draft')throw Error('Item labels failed Spanish translation');changeLanguage('en');
              const recover=[...root.querySelectorAll('button')].find(b=>b.textContent===t('item.recoverConflict'));
              if(recover.hidden)throw Error('Conflict has no recovery');recover.click();
              let modal=document.querySelector('.gws-modal');if(!modal)throw Error('No recovery section');changeLanguage('es');
              if(modal.querySelector('h2').textContent!==t('item.recoverConflict')||![...modal.querySelectorAll('button')].some(b=>b.textContent===t('item.reloadAction')))throw Error('Open item recovery did not translate');changeLanguage('en');
              [...modal.querySelectorAll('button')].find(b=>b.textContent===t('common.cancel')).click();await Promise.resolve();await Promise.resolve();
              if(!root.querySelector('[data-gws-item-field=description]').value.includes('Unsaved'))throw Error('Cancel discarded draft');
              recover.click();modal=document.querySelector('.gws-modal');current={...current,version:6,data:{...current.data,description:'Remote text'}};conflict=false;
              [...modal.querySelectorAll('button')].find(b=>b.textContent===t('item.reloadAction')).click();await new Promise(r=>setTimeout(r,20));
              if(root.querySelector('[data-gws-item-field=description]').value!=='Remote text')throw Error('Reload not applied');
              if(document.querySelector('dialog'))throw Error('Native dialog used');abort.abort();if(languageListeners.size)throw Error('Item retained language subscription');
              return {types:ITEM_TYPES.length,reading:true,inlineValidation:true,readonlyCopy:true,conflictRecovery:true,languageDraftFocus:true,languageRecovery:true,languageUnsubscribe:true,noDialog:true};
            }""")
            print(result)
            assert not errors, errors
            print({"pageErrors": errors})
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
