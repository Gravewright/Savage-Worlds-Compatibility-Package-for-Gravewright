"""Verify the permitted logo and exact public notice in the installed package, for GM and player."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
from playwright.sync_api import expect, sync_playwright
from review_server import MODULE, default_archive, host_root
from swade import fingerprint, start_fixture
from customization import open_customization, close_customization, LABELS

NOTICE='This game references the Savage Worlds game system, available from Pinnacle Entertainment Group at www.peginc.com. Savage Worlds and all associated logos and trademarks are copyrights of Pinnacle Entertainment Group. Used with permission. Pinnacle makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.'
LOGO_SHA='3a54347241721cff5891cde5a38cbfff54aeeb76257136b774948b81ccf9dd76'
PUBLIC_NAME='Savage Worlds Compatibility Package for Gravewright'

def smoke(seed, output):
    errors=[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch()
        for role in ('gm','reader'):
            context=browser.new_context(viewport={'width':1440,'height':1050},locale='pt-BR')
            context.add_cookies([{**seed['sessions'][role],'url':seed['base']}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(seed['base']+'/game/'+seed['campaign'])
            expect(page.locator('.game-menubar__presence')).to_have_attribute('data-presence','seated',timeout=15000)
            modal=open_customization(page)
            expect(page.locator('[data-package-id="gravewright.savage-worlds"] strong')).to_have_text(PUBLIC_NAME)
            modal.get_by_role('tab',name=LABELS['permission.about'],exact=True).click()
            expect(modal.locator('.gws-package-about h3')).to_have_text(PUBLIC_NAME)
            notice=modal.locator('.gws-permission-notice')
            assert notice.text_content()==NOTICE
            expect(notice).to_have_attribute('lang','en')
            expect(notice).to_have_attribute('translate','no')
            page.wait_for_function('''()=>{const image=document.querySelector('.gws-permission-logo');return image?.complete&&image.naturalWidth===4500&&image.naturalHeight===3000;}''',timeout=15000)
            image=modal.locator('.gws-permission-logo')
            response=page.request.get(image.get_attribute('src'));assert response.ok
            assert hashlib.sha256(response.body()).hexdigest()==LOGO_SHA
            expect(modal.locator('.gws-package-about a')).to_have_attribute('href','https://peginc.com/')
            assert page.evaluate('async()=>(await gravewright.cards.state()).decks.length')==0
            if role=='gm':page.screenshot(path=str(output/'branding-about.png'))
            page.set_viewport_size({'width':390,'height':844})
            sizes=modal.evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})');assert sizes['scroll']<=sizes['width']+1,sizes
            if role=='gm':page.screenshot(path=str(output/'branding-about-mobile.png'))
            assert page.locator('dialog').count()==0
            close_customization(page,modal)
            context.close()
        assert not errors,errors
        browser.close()
    return {'passed':True,'publicName':PUBLIC_NAME,'exactPermissionNotice':True,'originalLogoSha256':LOGO_SHA,
        'gmAndPlayer':True,'mobileNoOverflow':True,'noDialog':True,'noAutomaticDeckCreation':True,'pageErrors':errors}

def main():
    root=host_root();output=root/'test-results'/'swade-branding'/secrets.token_hex(8);output.mkdir(parents=True)
    server=log=None
    try:
        server,log,seed=start_fixture(root,output,default_archive(),30023)
        result=smoke(seed,output);result.update(output=str(output),archiveSha256=fingerprint(default_archive()))
        (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False),flush=True)
    finally:
        if server:
            server.terminate()
            try:server.wait(timeout=10)
            except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
        if log:log.close()
if __name__=='__main__':main()
