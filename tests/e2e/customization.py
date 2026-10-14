"""Exercise installed customization, native image imports and shared settings in a disposable table."""
from __future__ import annotations
import json
from io import BytesIO
from pathlib import Path
import secrets
import subprocess
from PIL import Image
from playwright.sync_api import expect, sync_playwright
from review_server import MODULE, default_archive, host_root
from swade import fingerprint, start_fixture, open_actor, close_actor
from tracker import show_tracker, assert_front_images

LABELS = json.loads((MODULE / 'locales' / 'pt-BR.json').read_text(encoding='utf-8'))
SCOPED_API = '**/api/tables/*/modules/gravewright.savage-worlds/api'

def open_customization(page):
    page.locator('.game-menubar__logo').click()
    page.locator('.house-menu__section').nth(1).click()
    customize=page.locator('[data-module-customize="gravewright.savage-worlds"]')
    expect(customize).to_be_visible(timeout=15000)
    customize.click()
    modal=page.locator('.gws-customization')
    expect(modal).to_be_visible(timeout=15000)
    expect(modal.locator('.gws-deck-option')).to_have_count(3)
    page.wait_for_function('''()=>[...document.querySelectorAll('.gws-deck-cover')].length===3 && [...document.querySelectorAll('.gws-deck-cover')].every(image=>image.complete&&image.naturalWidth>0)''',timeout=15000)
    return modal

def close_customization(page, modal):
    modal.locator('.gws-modal-close').click()
    expect(modal).to_have_count(0)
    page.locator('.house-menu__close').click()

def smoke(seed, output):
    errors=[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch()
        pages={}
        for role in ('gm','reader'):
            context=browser.new_context(viewport={'width':1440,'height':1050},locale='pt-BR')
            context.add_cookies([{**seed['sessions'][role],'url':seed['base']}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(seed['base']+'/game/'+seed['campaign'])
            expect(page.locator('.game-menubar__presence')).to_have_attribute('data-presence','seated',timeout=15000)
            page.wait_for_function('!!window.gravewright && !!window.gravewrightActors')
            pages[role]=page
        gm,player=pages['gm'],pages['reader']
        assert gm.evaluate('async()=>(await gravewright.cards.state()).decks.length')==0
        modal=open_customization(gm)
        gm.screenshot(path=str(output/'customization-decks.png'))
        assert modal.bounding_box()['width']>=1000
        assert gm.evaluate('async()=>(await gravewright.cards.state()).decks.length')==0
        modal.get_by_role('button',name=LABELS['settings.preview'],exact=True).first.click()
        preview=gm.locator('.gws-deck-preview');expect(preview.locator('figure')).to_have_count(54)
        preview.locator('.gws-modal-close').click();expect(preview).to_have_count(0)
        imported=[]
        lost={'done':False}
        def lose_definition(route):
            payload=route.request.post_data_json
            if payload.get('domain')=='cards' and payload.get('method')=='define' and not lost['done']:
                lost['done']=True;response=route.fetch();assert response.ok
                route.fulfill(status=503,json={'error':'unavailable'})
            else:route.continue_()
        gm.route(SCOPED_API,lose_definition)
        for index,theme in enumerate(('ivory','gravewright','adventure')):
            choice=modal.locator(f'[data-gws-deck-theme="{theme}"]');choice.click()
            expect(modal).to_have_attribute('aria-busy','false',timeout=180000)
            if index==0:
                assert lost['done'];expect(modal.locator('[role="alert"]')).to_be_visible()
                choice.click();expect(modal).to_have_attribute('aria-busy','false',timeout=30000)
                gm.unroute(SCOPED_API,lose_definition)
            expect(modal.locator('.gws-deck-selected')).to_have_count(1)
            state=gm.evaluate('async()=>await gravewright.cards.state()')
            assert len(state['decks'])==index+1,state
            deck=next(row for row in state['decks'] if row['name']==LABELS[f'settings.deck.{theme}.title'])
            assert deck['draw_count']==54 and deck['discard_count']==0
            imported.append(deck['id'])
            # A second choice reuses the instance; it does not manufacture another deck.
            choice.click();expect(modal).to_have_attribute('aria-busy','false',timeout=30000)
            assert gm.evaluate('async()=>(await gravewright.cards.state()).decks.length')==index+1
            faces=gm.evaluate('''async id=>{
              const a=await gravewright.cards.draw({deck_instance_id:id,count:50});
              const b=await gravewright.cards.draw({deck_instance_id:id,count:4});
              return [...a.cards,...b.cards];
            }''',deck['id'])
            assert len(faces)==54 and len({row['name'] for row in faces})==54
            for card in faces:
                assert card['frontUrl'] and card['backUrl']
                response=gm.request.get(seed['base']+card['frontUrl']);assert response.ok
                with Image.open(BytesIO(response.body())) as image:
                    assert image.size==(600,900),image.size
                    image.verify()
            updated=gm.evaluate('async()=>await gravewright.cards.state()')
            current=next(row for row in updated['decks'] if row['id']==deck['id'])
            gm.evaluate('async deck=>await gravewright.cards.reset({deck_instance_id:deck.id,version:deck.version})',current)
        modal.get_by_role('tab',name=LABELS['settings.tableRules'],exact=True).click()
        currency=modal.locator('[data-gws-currency-label]');currency.fill('Créditos')
        modal.get_by_label(LABELS['settings.usePowerPoints'],exact=True).uncheck()
        modal.locator('[data-gws-rule="jokersWild"]').uncheck()
        modal.get_by_role('button',name=LABELS['common.save'],exact=True).click()
        expect(modal.locator('[role="status"]')).to_contain_text(LABELS['settings.saved'])
        gm.screenshot(path=str(output/'customization-settings.png'))
        close_customization(gm,modal)
        actor=open_actor(gm,seed['actor']);actor.locator('[data-gws-tab="equipment"]').click()
        expect(actor.get_by_label('Créditos',exact=True)).to_be_visible()
        actor.locator('[data-gws-tab="powers"]').click()
        expect(actor.locator('[data-gws-path="resources.powerPoints"]')).not_to_be_visible()
        close_actor(actor)
        modal=open_customization(player)
        for button in modal.locator('[data-gws-deck-theme]').all():expect(button).to_be_disabled()
        modal.get_by_role('tab',name=LABELS['settings.tableRules'],exact=True).click()
        expect(modal.locator('[data-gws-currency-label]')).to_have_value('Créditos')
        expect(modal.locator('[data-gws-currency-label]')).to_be_disabled()
        expect(modal.get_by_label(LABELS['settings.usePowerPoints'],exact=True)).not_to_be_checked()
        close_customization(player,modal)
        # Default chosen through Customize is immediately usable by the tracker.
        gm.evaluate('async({actor,scene})=>await gravewright.combat.add({actorId:actor,sceneId:scene})',{'actor':seed['actor'],'scene':seed['scene']})
        tracker=show_tracker(gm);expect(tracker.locator('[data-gws-tracker-action="tracker.start"]')).to_be_enabled(timeout=10000)
        tracker.locator('[data-gws-tracker-action="tracker.start"]').click()
        expect(tracker).not_to_have_attribute('aria-busy','true',timeout=30000)
        assert_front_images(gm,count=1)
        tracker.locator('[data-gws-tracker-action="tracker.stop"]').click()
        expect(tracker.locator('[data-gws-tracker-action="tracker.start"]')).to_be_visible()
        gm.reload();expect(gm.locator('.game-menubar__presence')).to_have_attribute('data-presence','seated',timeout=15000)
        modal=open_customization(gm);expect(modal.locator('.gws-deck-selected')).to_contain_text(LABELS['settings.deck.adventure.title'])
        gm.set_viewport_size({'width':400,'height':850})
        sizes=modal.evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})');assert sizes['scroll']<=sizes['width']+1,sizes
        gm.screenshot(path=str(output/'customization-mobile.png'))
        assert gm.locator('dialog').count()==0 and not errors,errors
        browser.close()
    return {'passed':True,'threeNativeDecks':True,'nativeFrontImages':162,'nativeBacks':3,'lostDefinitionReplay':True,'noDuplicateImports':True,
        'sharedSettings':True,'playerReadOnly':True,'defaultDeckCombat':True,'reloadPersistence':True,'noDialog':True,'pageErrors':errors}

def main():
    root=host_root();output=root/'test-results'/'swade-customization'/secrets.token_hex(8);output.mkdir(parents=True)
    server=log=None
    try:
        server,log,seed=start_fixture(root,output,default_archive(),30021)
        result=smoke(seed,output);result.update(output=str(output),archiveSha256=fingerprint(default_archive()))
        (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False),flush=True)
    finally:
        if server:
            server.terminate()
            try:server.wait(timeout=10)
            except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
        if log:log.close()
if __name__=='__main__':main()
