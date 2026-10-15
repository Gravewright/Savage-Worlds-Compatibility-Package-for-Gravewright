"""Modal regression checks against the real native SDK on an isolated server."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def find_host_root(source):
    override = os.environ.get('GRAVEWRIGHT_TEST_HOST_ROOT')
    candidates = [Path(override)] if override else source.parents
    for candidate in candidates:
        root = candidate.resolve()
        if (root / 'manage.py').is_file() and (root / 'gravewright').is_dir():
            return root
    raise RuntimeError('Set GRAVEWRIGHT_TEST_HOST_ROOT to a Gravewright checkout containing manage.py and gravewright/.')


def main():
    source = Path(__file__).resolve().parents[1]
    host = find_host_root(source)
    modules = host / "gravewright/modules/static/gravewright_modules"

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def translate_path(self, path):
            path = urlsplit(path).path
            if path == "/host/table-modal.js":
                return str(host / "gravewright/table/static/gravewright_table/modal.js")
            if path == "/static/gravewright_web/escape.js":
                return str(host / "gravewright/web/static/gravewright_web/escape.js")
            if path.startswith("/host/modules/"):
                target = (modules / path.removeprefix("/host/modules/")).resolve()
                if target.is_relative_to(modules.resolve()):
                    return str(target)
            return super().translate_path(path)

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(source)))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.add_style_tag(path=str(source / "styles.css"))
            page.add_style_tag(content=".ownership-modal-overlay{position:fixed;inset:0;display:grid;place-items:center;background:#0008}")
            result = page.evaluate(r"""async () => {
              const {openModal}=await import('/ui.js');
              const {mountModal}=await import('/host/table-modal.js');
              const {createUiApi}=await import('/host/modules/modal-api.js');
              const {itemEditor}=await import('/item-editor.js');
              const {createItemSheet}=await import('/model.js');
              const abort=new AbortController(),linked=new Set();
              const life={signal:abort.signal,check(){if(abort.signal.aborted)throw Error('stale_context');},link(fn){linked.add(fn);return()=>linked.delete(fn);}};
              const api={ui:createUiApi(life,{}, {mountModal,document})};
              const opener=document.createElement('textarea');opener.value='Original selection';document.body.append(opener);opener.focus();opener.setSelectionRange(2,7);
              const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
              const escape=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
              const modal=openModal(api,document,'Autosave',abort.signal,'Close');
              const input=document.createElement('input'),cancel=document.createElement('button');cancel.textContent='Cancel';modal.append(input,cancel);cancel.focus();await tick();
              if(document.activeElement!==cancel)throw Error('Default focus stole explicit Cancel');
              let release;const writing=new Promise(resolve=>release=resolve);
              modal.addEventListener('gravewright:sheet-flush',event=>event.detail.waitUntil(writing));escape();
              const closing=modal.close();if(closing!==modal.close())throw Error('Close requests are not coalesced');
              if(!modal.isConnected||modal.querySelector('.gws-modal-close').getAttribute('aria-busy')!=='true')throw Error('Close lost autosave or busy feedback');
              release();await closing;await tick();
              if(modal.isConnected||document.activeElement!==opener||opener.selectionStart!==2||opener.selectionEnd!==7)throw Error('Focus or selection not restored');
              const failed=openModal(api,document,'Retry',abort.signal,'Close'),notice=document.createElement('p'),draft=document.createElement('textarea');
              notice.setAttribute('role','alert');notice.hidden=true;draft.value='Retained draft';failed.append(notice,draft);let offline=true;
              failed.addEventListener('gravewright:sheet-flush',event=>event.detail.waitUntil(offline?Promise.reject(Error('Offline')):Promise.resolve()));
              await failed.close();if(!failed.isConnected||draft.value!=='Retained draft'||notice.hidden)throw Error('Failed flush discarded draft or hid error');
              offline=false;await failed.close();await tick();
              const parent=openModal(api,document,'Parent',abort.signal,'Close'),parentInput=document.createElement('input');parent.append(parentInput);parentInput.focus();await tick();
              const child=openModal(api,document,'Child',abort.signal,'Close'),childCancel=document.createElement('button');childCancel.textContent='Cancel';child.append(childCancel);childCancel.focus();await tick();escape();await tick();
              if(child.isConnected||!parent.isConnected||document.activeElement!==parentInput)throw Error('Escape did not close only the nested modal');
              escape();await tick();if(parent.isConnected)throw Error('Parent Escape did not close');
              const item=createItemSheet('equipment'),editor=itemEditor({doc:document,t:key=>key,type:'equipment',data:()=>item,name:()=> 'Custom item',canEdit:true,changed:(key,value)=>item[key]=value});
              const imageModal=openModal(api,document,'Image edit',abort.signal,'Close');imageModal.append(editor);editor.querySelector('[data-gws-item-tab=details]').click();await tick();
              const url=editor.querySelector('[data-gws-item-field=img]');url.focus();url.value='/media/without-blur.png';url.dispatchEvent(new Event('input'));
              imageModal.addEventListener('gravewright:sheet-flush',event=>event.detail.waitUntil(editor.validate()?Promise.resolve():Promise.reject(Error('invalid'))));
              escape();await tick();if(imageModal.isConnected||item.img!=='/media/without-blur.png')throw Error('Escape lost the unblurred URL');
              const cancelled=openModal(api,document,'Cancelled',abort.signal,'Close');abort.abort();await tick();
              if(cancelled.isConnected||linked.size||document.querySelector('dialog'))throw Error('Abort failed cleanup or a dialog was created');
              return {nativeSDK:true,escape:true,nested:true,autosave:true,retryDraft:true,focusSelection:true,imageCommit:true,noDialog:true};
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
