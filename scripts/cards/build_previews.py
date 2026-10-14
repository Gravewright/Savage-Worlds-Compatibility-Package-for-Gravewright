"""Compose language-neutral gallery previews from the existing original card assets."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright
from build_decks import save_data_url

PACKAGE=Path(__file__).resolve().parents[2]

def build():
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*_args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(PACKAGE)))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        catalog=json.loads((PACKAGE/'assets/action-decks/catalogue.json').read_text(encoding='utf-8'))
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(headless=True);page=browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/scripts/cards/')
            page.evaluate("async()=>{window.renderer=await import('./renderer.mjs');}")
            for theme in catalog['themes']:
                image=page.evaluate("""async theme=>{
                  const cards={};
                  for(const card of theme.cards)cards[card.name]=(await renderer.loadArt('/'+card.front)).image;
                  const back=(await renderer.loadArt('/'+theme.back)).image;
                  return renderer.renderPreview(theme.id,cards,back).toDataURL('image/webp',.94);
                }""",theme)
                size=save_data_url(PACKAGE/theme['preview'],image)
                print(f"{theme['id']}: neutral preview, {size} bytes",flush=True)
            browser.close()
    finally:server.shutdown();server.server_close()
if __name__=='__main__':build()
