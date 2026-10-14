"""Build original static action decks with Chromium's native Canvas renderer.

Python orchestrates files and the local browser only; all visual composition,
indices, pips, decorations and WebP encoding happen in renderer.mjs.
Generated source illustrations are preserved unchanged under output/imagegen.
"""
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

PACKAGE = Path(__file__).resolve().parents[2]
ROOT = PACKAGE.parents[1]
ASSETS = PACKAGE / 'assets/action-decks'
OUTPUT = ROOT / 'output/imagegen/swade-action-deck'
THEMES = ('ivory', 'gravewright', 'adventure')


def save_data_url(path, value):
    kind, encoded = value.split(',', 1)
    if kind != 'data:image/webp;base64':
        raise ValueError('Expected browser-encoded WebP')
    raw = base64.b64decode(encoded, validate=True)
    if not raw.startswith(b'RIFF') or raw[8:12] != b'WEBP':
        raise ValueError('Invalid WebP output')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return len(raw)


def build():
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    catalogue = {'schemaVersion': 1, 'themes': []}
    proof = {'schemaVersion': 1, 'dimensions': [600, 900], 'themes': []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/{PACKAGE.relative_to(ROOT).as_posix()}/scripts/cards/')
            page.evaluate("async()=>{window.deckRenderer=await import('./renderer.mjs');}")
            for theme in THEMES:
                for role in ('K', 'Q', 'J', 'joker'):
                    if not (OUTPUT / 'art' / theme / f'{role}.png').is_file():
                        raise FileNotFoundError(f'Missing original illustration: {theme}/{role}.png')
                specs = page.evaluate("()=>deckRenderer.cardSpecs()")
                page.evaluate("""async theme=>{
                  window.renderedCards={};window.deckArt={};
                  for(const role of ['K','Q','J','joker'])deckArt[role]=await deckRenderer.loadArt(`/output/imagegen/swade-action-deck/art/${theme}/${role}.png`);
                }""", theme)
                cards, measurements = [], []
                for card in specs:
                    result = page.evaluate("""({theme,card})=>{
                      const canvas=deckRenderer.renderFace(theme,card,deckArt);renderedCards[card.name]=canvas;
                      return {data:canvas.toDataURL('image/webp',.94),pips:card.joker?0:/^[2-9]$|^10$/.test(card.rank)?deckRenderer.pipLayout(card.rank).length:card.rank==='A'?1:0};
                    }""", {'theme': theme, 'card': card})
                    asset = f'assets/action-decks/{theme}/{card["file"]}'
                    size = save_data_url(ASSETS / theme / card['file'], result['data'])
                    cards.append({'name': card['name'], 'front': asset})
                    measurements.append({'name': card['name'], 'file': card['file'], 'pips': result['pips'], 'bytes': size})
                back = page.evaluate("""theme=>{window.renderedBack=deckRenderer.renderBack(theme);return renderedBack.toDataURL('image/webp',.94);}""", theme)
                save_data_url(ASSETS / theme / 'back.webp', back)
                preview = page.evaluate("theme=>deckRenderer.renderPreview(theme,renderedCards,renderedBack).toDataURL('image/webp',.94)", theme)
                save_data_url(ASSETS / theme / 'preview.webp', preview)
                save_data_url(OUTPUT / f'{theme}-complete-preview.webp', preview)
                contact = page.evaluate("theme=>deckRenderer.renderContactSheet(theme,renderedCards).toDataURL('image/webp',.91)", theme)
                save_data_url(OUTPUT / f'{theme}-54-card-contact-sheet.webp', contact)
                catalogue['themes'].append({'id': theme, 'titleKey': f'settings.deck.{theme}.title',
                    'descriptionKey': f'settings.deck.{theme}.description',
                    'preview': f'assets/action-decks/{theme}/preview.webp',
                    'back': f'assets/action-decks/{theme}/back.webp', 'cards': cards})
                proof['themes'].append({'id': theme, 'count': len(cards), 'cards': measurements})
                print(f'{theme}: {len(cards)} faces, back and preview; {sum(x["bytes"] for x in measurements):,} face bytes', flush=True)
            browser.close()
        ASSETS.mkdir(parents=True, exist_ok=True)
        (ASSETS / 'catalogue.json').write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (OUTPUT / 'deck-build-proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        fixture = PACKAGE / 'tests/fixtures/action-deck-build-proof.json'
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    build()
