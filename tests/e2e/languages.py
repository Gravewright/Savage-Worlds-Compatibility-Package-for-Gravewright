"""SWADE translations through the installed official Translator and native preferences.

No injected locale globals, replaced Translator, live database or .env edits.
Run from the Gravewright checkout after building the SWADE release ZIP.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import secrets
import subprocess

from playwright.sync_api import expect, sync_playwright

from review_server import MODULE, default_archive, host_root
from swade import fingerprint, start_fixture, open_actor, close_actor, open_item, close_item, read_actor
from tracker import show_tracker
from customization import open_customization, close_customization
from branding import NOTICE, PUBLIC_NAME


LOCALES = ('pt-BR', 'es', 'en')
ATTRIBUTES = ('agility', 'smarts', 'spirit', 'strength', 'vigor')


def wait_table(page, seed, locale=None):
    expect(page.locator('.game-menubar__presence')).to_have_attribute('data-presence', 'seated', timeout=15000)
    page.wait_for_function('!!window.gravewrightActors && !!window.gravewrightItems && !!window.gravewright')
    if locale:
        expect(page.locator('html')).to_have_attribute('lang', locale)
        config_node = page.locator('#gravewright-language')
        if config_node.count():
            config = json.loads(config_node.text_content())
            assert config['id'] == locale
        else:
            # The host omits the catalog script when no language pack is
            # active. The official adapter's original language is English.
            assert locale == 'en'
    assert page.url == seed['base'] + '/game/' + seed['campaign'], page.url


def change_language(page, seed, locale):
    # The official host stores this choice on the authenticated account and
    # reloads the same table. Browser locale alone must not affect the system.
    page.locator('.game-menubar__logo').click()
    page.locator('.house-menu__section').nth(2).click()
    selector = page.locator('[data-table-language] select[name="locale"]')
    expect(selector).to_be_visible()
    expect(selector).to_be_enabled()
    expect(selector.locator('option')).to_have_count(3)
    if selector.input_value() == locale:
        page.locator('.house-menu__close').click()
    else:
        with page.expect_navigation(wait_until='domcontentloaded'):
            selector.select_option(locale)
    wait_table(page, seed, locale)
    page.reload()
    wait_table(page, seed, locale)


def activate_translator(page, seed, enabled):
    # Use the owner-facing Installed modules action. Its native transport
    # obtains a fresh CSRF token and verifies the installed archive.
    page.goto(seed['base'] + '/inside?section=addons')
    card = page.locator(f'.module-catalog__card[data-package-id="{seed["translator"]["id"]}"]')
    button = card.locator('[data-action="global-activation"]')
    expect(button).to_have_attribute('aria-pressed', str(not enabled).lower())
    button.click()
    expect(button).to_have_attribute('aria-pressed', str(enabled).lower(), timeout=15000)
    page.goto(seed['base'] + '/game/' + seed['campaign'])


def assert_actor_labels(page, seed, labels):
    window = open_actor(page, seed['actor'])
    sheet = window.locator('.gws-sheet')
    for attribute in ATTRIBUTES:
        expect(sheet.locator(f'[data-attribute="{attribute}"] h4')).to_have_text(labels[f'attribute.{attribute}'])
    for tab, key in [('overview', 'sheet.overview'), ('equipment', 'sheet.equipment'),
                     ('features', 'sheet.features'), ('powers', 'sheet.powers'), ('notes', 'sheet.notes')]:
        expect(sheet.locator(f'[data-gws-tab="{tab}"]')).to_have_text(labels[key])
    expect(sheet.locator('[data-gws-path="core.name"]')).to_have_value('Settings')
    expect(sheet.locator('[data-gws-path="identity.concept"]')).to_have_value('Armor')
    edit_name = labels['sheet.editAttribute'].replace('{name}', labels['attribute.agility'])
    sheet.get_by_role('button', name=edit_name, exact=True).click()
    editor = page.locator('.gws-modal').last
    expect(editor.locator('.gws-modal-title h2')).to_have_text(edit_name)
    expect(editor.locator('.gws-modal-close')).to_have_attribute('aria-label', labels['common.close'])
    expect(editor.locator('label').first).to_contain_text(labels['common.die'])
    editor.locator('.gws-modal-close').click()
    sheet.locator('[data-gws-tab="powers"]').click()
    expect(sheet.get_by_text(labels['resource.powerPoints'], exact=True).first).to_be_visible()
    sheet.locator('[data-gws-tab="notes"]').click()
    expect(sheet.locator('[data-gws-path="notes"]')).to_have_value('Settings · Action / Ação / Acción')
    sheet.locator('[data-gws-tab="overview"]').click()
    return window


def assert_item_labels(page, item, labels):
    window = open_item(page, item['id'])
    expect(window.locator('[data-gws-item-field="core.name"]')).to_have_value('Settings')
    expect(window.locator('[data-gws-item-tab="description"]')).to_have_text(labels['item.description'])
    expect(window.locator('[data-gws-item-tab="details"]')).to_have_text(labels['item.details'])
    expect(window.locator('[data-gws-item-field="description"]')).to_have_value('Armor')
    expect(window.locator('[data-gws-item-field="description"]')).to_have_attribute('placeholder', labels['item.descriptionPlaceholder'])
    window.locator('[data-gws-item-tab="details"]').click()
    expect(window.locator('.gws-item-sheet')).to_contain_text(labels['item.type.weapon'])
    close_item(window)


def assert_customization_labels(page, labels, output, locale, role='gm'):
    modal = open_customization(page)
    expect(modal.locator('.gws-modal-title h2')).to_have_text(labels['settings.title'])
    expect(modal.get_by_role('tab', name=labels['settings.decks'], exact=True)).to_be_visible()
    expect(modal.get_by_role('tab', name=labels['settings.tableRules'], exact=True)).to_be_visible()
    host_language = json.loads(page.locator('#gravewright-language').text_content())
    reset_label = host_language['messages'].get('Reset window layout', 'Reset window layout')
    expect(modal.locator('[data-window-action="reset"]')).to_have_attribute('aria-label', reset_label)
    expect(modal.locator('[data-window-action="reset"]')).to_have_attribute('title', reset_label)
    for theme in ('ivory', 'gravewright', 'adventure'):
        expect(modal.get_by_role('heading', name=labels[f'settings.deck.{theme}.title'], exact=True)).to_be_visible()
    page.screenshot(path=str(output / f'{role}-{locale}-decks.png'))
    modal.get_by_role('tab', name=labels['settings.tableRules'], exact=True).click()
    expect(modal.get_by_text(labels['settings.usePowerPoints'], exact=True)).to_be_visible()
    expect(modal.locator('[data-gws-currency-label]')).to_have_value('Credits')
    if role == 'reader':
        expect(modal.locator('[data-gws-currency-label]')).to_be_disabled()
    page.screenshot(path=str(output / f'{role}-{locale}-settings.png'))
    modal.get_by_role('tab', name=labels['permission.about'], exact=True).click()
    expect(modal.locator('.gws-package-about h3')).to_have_text(PUBLIC_NAME)
    expect(modal.locator('.gws-permission-notice')).to_have_text(NOTICE)
    expect(modal.locator('.gws-permission-notice')).to_have_attribute('lang', 'en')
    expect(modal.get_by_role('link', name=labels['permission.officialRules'], exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    bounds = modal.evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})')
    assert bounds['scroll'] <= bounds['width'] + 1, bounds
    page.screenshot(path=str(output / f'{role}-{locale}-about-mobile.png'))
    page.set_viewport_size({'width': 1440, 'height': 1050})
    close_customization(page, modal)


def smoke(seed, output):
    assert seed['translator']['id'] == 'gravewright.translator'
    catalogs = {locale: json.loads((MODULE / 'locales' / f'{locale}.json').read_text(encoding='utf-8')) for locale in LOCALES}
    errors, dialogs, requests = [], [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        pages = {}
        for role in ('gm', 'reader'):
            # Deliberately use the same browser locale for different account
            # languages. No init scripts or globals select the translation.
            context = browser.new_context(viewport={'width': 1440, 'height': 1050}, locale='en-US')
            context.add_cookies([{**seed['sessions'][role], 'url': seed['base']}])
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.type), dialog.dismiss()))
            page.on('request', lambda request: requests.append(request.url))
            page.goto(seed['base'] + '/game/' + seed['campaign'])
            wait_table(page, seed, 'en')
            pages[role] = page
        gm, reader = pages['gm'], pages['reader']
        packages = gm.request.get(seed['base'] + '/api/module-packages').json()
        installed = next(package for package in packages if package['id'] == 'gravewright.translator')
        assert installed['version'] == seed['translator']['version'] and installed['globalEnabled'] is True
        assert gm.locator('[data-table-modules] [data-package-id="gravewright.translator"]').count() == 0

        # Save authored content before the language tour, then compare exact
        # document data and versions after every screen and reload.
        window = open_actor(gm, seed['actor'])
        window.locator('[data-gws-path="core.name"]').fill('Settings')
        window.locator('[data-gws-path="identity.concept"]').fill('Armor')
        window.locator('[data-gws-tab="notes"]').click()
        window.locator('[data-gws-path="notes"]').fill('Settings · Action / Ação / Acción')
        close_actor(window)
        actor_before = read_actor(gm, seed['actor'])
        item = gm.evaluate('''async reader=>await gravewright.items.create({name:'Settings',type:'weapon',
          data:{description:'Armor',notes:'Settings'},permissions:{[reader]:'read'}})''', seed['users']['reader'])
        item_before = gm.evaluate('async id=>await gravewright.items.get(id)', item['id'])

        modal = open_customization(gm)
        modal.get_by_role('tab', name=catalogs['en']['settings.tableRules'], exact=True).click()
        modal.locator('[data-gws-currency-label]').fill('Credits')
        modal.locator('[data-gws-save]').click()
        expect(modal).to_have_attribute('aria-busy', 'false')
        close_customization(gm, modal)
        change_language(reader, seed, 'es')

        for locale in LOCALES:
            labels = catalogs[locale]
            change_language(gm, seed, locale)
            window = assert_actor_labels(gm, seed, labels)
            gm.screenshot(path=str(output / f'gm-{locale}-sheet.png'))
            close_actor(window)
            assert_item_labels(gm, item, labels)
            tracker = show_tracker(gm)
            expect(tracker.locator('[data-gws-tracker-action="tracker.start"]')).to_have_attribute('aria-label', labels['tracker.start'])
            expect(tracker.locator('.gw-combat-header__title')).to_have_text(labels['tracker.inactive'])
            expect(tracker.locator('[data-gws-tracker-action="tracker.configureDeck"]')).to_have_attribute('title', labels['tracker.configureDeck'])
            gm.locator('#combat-panel [data-close]').click()
            assert_customization_labels(gm, labels, output, locale)
            assert read_actor(gm, seed['actor']) == actor_before
            assert gm.evaluate('async id=>await gravewright.items.get(id)', item['id']) == item_before
            assert gm.evaluate('async()=>(await gravewright.cards.state()).decks.length') == 0
            reader.reload()
            wait_table(reader, seed, 'es')
            expect(reader.locator('[data-table-language] select')).to_have_value('es')

        window = assert_actor_labels(reader, seed, catalogs['es'])
        expect(window.locator('[data-gws-path="core.name"]')).to_have_attribute('readonly', '')
        close_actor(window)
        assert_customization_labels(reader, catalogs['es'], output, 'es', role='reader')

        # Deactivation temporarily restores English without erasing the saved
        # account choices; reactivation restores both independent languages.
        change_language(gm, seed, 'pt-BR')
        activate_translator(gm, seed, False)
        for page in (gm, reader):
            page.reload()
            wait_table(page, seed, 'en')
            expect(page.locator('[data-table-language] select')).to_be_disabled()
            expect(page.locator('[data-table-language] option')).to_have_count(1)
        fallback = assert_actor_labels(gm, seed, catalogs['en'])
        close_actor(fallback)
        activate_translator(gm, seed, True)
        gm.reload()
        reader.reload()
        wait_table(gm, seed, 'pt-BR')
        wait_table(reader, seed, 'es')
        assert read_actor(gm, seed['actor']) == actor_before
        assert gm.evaluate('async id=>await gravewright.items.get(id)', item['id']) == item_before
        assert gm.locator('dialog').count() == 0 and reader.locator('dialog').count() == 0
        assert not errors, errors
        assert not dialogs, dialogs
        assert all(url.startswith(seed['base']) for url in requests), [url for url in requests if not url.startswith(seed['base'])]
        browser.close()
    return {'passed': True, 'locales': list(LOCALES), 'officialTranslator': seed['translator'],
            'nativeAccountPreferences': True, 'independentAccounts': True, 'reloadPersistence': True,
            'sheetsItemsTrackerAndCustomization': True, 'authoredDataAndVersionsPreserved': True,
            'englishFallbackWhenDisabled': True, 'reactivationRestoresChoices': True,
            'exactPermissionNotice': True, 'noAutomaticDeckCreation': True, 'noDialog': True,
            'pageErrors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-root')
    parser.add_argument('--archive', type=Path, default=default_archive())
    parser.add_argument('--translator-zip', type=Path)
    parser.add_argument('--port', type=int, default=30025)
    args = parser.parse_args()
    root = host_root(args.host_root)
    translator = args.translator_zip or root / 'data/translator-source/dist/translator-0.1.2.zip'
    if not translator.is_file():
        raise RuntimeError(f'Build or supply the official Translator release ZIP: {translator}')
    output = root / 'test-results' / 'swade-languages' / secrets.token_hex(8)
    output.mkdir(parents=True)
    env_before = fingerprint(root / '.env')
    server = log = None
    try:
        server, log, seed = start_fixture(root, output, args.archive.resolve(), args.port,
                                         translator_zip=translator.resolve())
        result = smoke(seed, output)
        result.update(output=str(output), archiveSha256=fingerprint(args.archive), translatorSha256=fingerprint(translator))
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        if server:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        if log:
            log.close()
        assert fingerprint(root / '.env') == env_before, 'The host .env changed during the test.'


if __name__ == '__main__':
    main()
