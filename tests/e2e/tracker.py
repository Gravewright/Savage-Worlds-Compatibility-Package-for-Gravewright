"""Focused native SDK/card tracker smoke in a disposable SWADE fixture."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess

from playwright.sync_api import expect, sync_playwright
from review_server import MODULE, default_archive, host_root
from swade import fingerprint, start_fixture

SCOPED_API = '**/api/tables/*/modules/gravewright.savage-worlds/api'
LABELS = json.loads((MODULE / 'locales' / 'pt-BR.json').read_text(encoding='utf-8'))


def setup_sheet(page, actor_id, token_id=None):
    return page.evaluate("""async ({id,token}) => {
      const view=await gravewright.actors.sheet(id,token?{tokenId:token}:{});
      const data=view.data;
      data.profile={kind:'wild-card',role:'player',wildDie:6,initiative:{draw:1,keep:'highest',redrawBelow:0}};
      data.resources={...data.resources,bennies:3,wounds:0,fatigue:0};
      data.status={...data.status,distracted:true};
      data.statusClocks={distracted:{remaining:1,phase:'end',owner:'self',awaitingStart:true}};
      return await gravewright.actors.saveSheet({actorId:id,tokenId:token||null,name:view.name,version:view.version,sheetVersion:view.sheetVersion,data});
    }""", {'id': actor_id, 'token': token_id})


def show_tracker(page):
    panel = page.locator('#combat-panel')
    if not panel.is_visible():
        page.locator('[data-native-directory-toggle="combat"]').click()
    tracker = page.locator('.gws-tracker')
    expect(tracker).to_be_visible(timeout=15000)
    return tracker


def native_snapshot(page, seed):
    # Compare the authoritative encounter, private cards and both document
    # instances, including versions. Pausing must not tick or rewrite any of them.
    return page.evaluate("""async ({actor,token,scene}) => {
      const [combat,cards,canonical,snapshot]=await Promise.all([
        gravewright.combat.state({sceneId:scene}), gravewright.cards.state({sceneId:scene}),
        gravewright.actors.sheet(actor), gravewright.actors.sheet(actor,{tokenId:token})
      ]);
      return {combat,cards,canonical,snapshot};
    }""", {'actor': seed['actor'], 'token': seed['snapshotToken'], 'scene': seed['scene']})


def assert_pause_controls(tracker, player_tracker):
    expect(tracker.locator('.gws-tracker-paused')).to_be_visible(timeout=15000)
    expect(tracker.locator('.gw-combat-toolbar [data-gws-tracker-action="tracker.resume"]')).to_be_enabled()
    expect(tracker.locator('.gw-combat-toolbar [data-gws-tracker-action="tracker.stop"]')).to_be_enabled()
    assert tracker.locator('[data-gws-tracker-action="tracker.pause"]').count() == 0
    for action in ('next', 'previous', 'nextRound', 'deal', 'beginRound', 'add', 'configureDeck', 'actions'):
        controls = tracker.locator(f'[data-gws-tracker-action="tracker.{action}"]')
        assert controls.count(), action
        for index in range(controls.count()):
            expect(controls.nth(index)).to_be_disabled()
    assert tracker.locator('.gws-tracker-row [data-gws-tracker-action="tracker.bennyCard"]').count() == 0
    # This is the existing player page, not a newly loaded page: the storage
    # polling must deliver both the notice and the blocked owner control.
    expect(player_tracker.locator('.gws-tracker-paused')).to_be_visible(timeout=15000)
    for action in ('pause', 'resume', 'stop', 'deal', 'add', 'actions', 'bennyCard'):
        assert player_tracker.locator(f'[data-gws-tracker-action="tracker.{action}"]').count() == 0, action
    expect(player_tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_disabled()


def assert_compact_layout(tracker, count=2):
    expect(tracker.locator('.gw-combat-header')).to_be_visible()
    rows = tracker.locator('.gw-combat-list .gw-combat-combatant')
    expect(rows).to_have_count(count)
    for row in rows.all():
        expect(row.locator('.gw-combat-combatant__position')).to_be_visible()
        expect(row.locator('.gw-combat-combatant__portrait')).to_be_visible()
        expect(row.locator('.gw-combat-combatant__main .gw-combat-combatant__name')).to_be_visible()
        expect(row.locator('.gw-combat-combatant__score.gws-tracker-card')).to_be_visible()
        expect(row.locator('.gw-combat-combatant__actions > button')).to_have_count(1)
        assert row.locator('button').count() == 1
        action = row.locator('[data-gws-tracker-action="tracker.actions"]')
        expect(action).to_have_attribute('aria-label', LABELS['tracker.actions'])
        assert action.locator('svg').count() == 1 and not action.inner_text().strip()


def assert_front_images(page, count=2):
    page.wait_for_function('''count=>{
      const images=[...document.querySelectorAll('.gws-tracker .gws-tracker-card img')];
      return images.length===count && images.every(image=>image.complete && image.naturalWidth>0);
    }''', arg=count, timeout=15000)
    for image in page.locator('.gws-tracker .gws-tracker-card img').all():
        assert image.get_attribute('alt')
        assert '/game/cards/card/' in image.get_attribute('src')
        bounds = image.bounding_box()
        assert bounds and bounds['width'] <= 34 and bounds['height'] <= 46, bounds


def reopen_and_reload_paused(gm, player_tracker, seed, expected):
    gm.locator('#combat-panel [data-close]').click()
    expect(gm.locator('#combat-panel')).not_to_be_visible()
    tracker = show_tracker(gm)
    assert_pause_controls(tracker, player_tracker)
    assert native_snapshot(gm, seed) == expected

    gm.reload()
    expect(gm.locator('.game-menubar__presence')).to_have_attribute('data-presence', 'seated', timeout=15000)
    gm.wait_for_function('!!window.gravewrightMaps?.current && !!window.gravewright')
    tracker = show_tracker(gm)
    assert_pause_controls(tracker, player_tracker)
    assert native_snapshot(gm, seed) == expected
    return tracker


def smoke(seed, output):
    errors, dialogs, calls = [], [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(env={**os.environ,
            'CHROME_LOG_FILE': str(output / 'chromium.log')})
        pages = {}
        for role in ('gm', 'editor'):
            context = browser.new_context(viewport={'width': 1440, 'height': 1050}, locale='pt-BR')
            context.add_cookies([{**seed['sessions'][role], 'url': seed['base']}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.type), dialog.dismiss()))
            page.goto(seed['base'] + '/game/' + seed['campaign'])
            expect(page.locator('.game-menubar__presence')).to_have_attribute('data-presence', 'seated', timeout=15000)
            page.wait_for_function('!!window.gravewrightMaps?.current && !!window.gravewright')
            pages[role] = page
        gm, player = pages['gm'], pages['editor']
        # A previous split installation keeps its immutable archive for rollback,
        # while the active system is the only visible Savage Worlds package.
        installed_response = gm.request.get(seed['base'] + '/api/module-packages')
        assert installed_response.ok
        installed = installed_response.json()
        system = next(row for row in installed if row['id'] == seed['package']['id'])
        previous = next(row for row in installed if row['id'] == system['django']['replaces'][0])
        assert system['globalEnabled'] is True and system['version'] == seed['package']['version']
        assert previous['globalEnabled'] is False
        assert previous['supersededBy'] == seed['package']
        library_page = gm.context.new_page()
        library_page.goto(seed['base'] + '/inside?section=addons')
        library = library_page.locator('[data-module-catalog=installed]')
        expect(library.locator('.module-catalog__empty')).to_be_visible()
        expect(library.locator('.module-catalog__card')).to_have_count(0)
        library_page.goto(seed['base'] + '/inside?section=systems')
        library = library_page.locator('[data-module-catalog=installed]')
        expect(library.locator('.module-catalog__card h3')).to_have_text([
            'Gravewright PDF System', 'Savage Worlds Compatibility Package for Gravewright'])
        library_page.screenshot(path=str(output / 'system-library.png'))
        library_page.close()
        def record_response(response):
            if '/modules/gravewright.savage-worlds/api' not in response.url:
                return
            request = response.request.post_data_json or {}
            calls.append({'domain': request.get('domain'), 'method': request.get('method'), 'status': response.status})
        gm.on('response', record_response)
        setup_sheet(gm, seed['actor'])
        setup_sheet(gm, seed['actor'], seed['snapshotToken'])
        gm.locator('[data-native-directory-toggle="combat"]').click()
        tracker = gm.locator('.gws-tracker')
        expect(tracker).to_be_visible()
        expect(tracker.locator('[data-gws-tracker-action="tracker.start"]')).to_be_disabled()
        expect(tracker.locator('.gws-tracker-deck-needed')).to_be_visible()
        assert seed['cardDeck'] and seed['cardDeck']['cards'] == 54

        # The module chooses an existing native image-bearing deck explicitly.
        # It must not create or substitute a deck behind the user's selection.
        tracker.locator('[data-gws-tracker-action="tracker.configureDeck"]').click()
        deck_picker = gm.locator('.gws-tracker-modal')
        choice = deck_picker.locator('.gws-tracker-choice').filter(has_text=seed['cardDeck']['name'])
        expect(choice).to_have_count(1)
        choice.get_by_role('button', name=LABELS['tracker.selectDeck'], exact=True).click()
        try:
            expect(deck_picker).to_have_count(0)
        except AssertionError:
            gm.screenshot(path=str(output / 'failure-deck-selection.png'))
            diagnostic = gm.evaluate('''()=>({
              busy:document.querySelector('.gws-tracker')?.getAttribute('aria-busy'),
              tracker:document.querySelector('.gws-tracker')?.innerText,
              modals:[...document.querySelectorAll('.gws-tracker-modal')].map(node=>({
                text:node.innerText,html:node.outerHTML,
                buttons:[...node.querySelectorAll('button')].map(button=>({text:button.innerText,disabled:button.disabled,busy:button.getAttribute('aria-busy')}))
              }))
            })''')
            diagnostic.update(pageErrors=errors, calls=calls[-24:])
            (output / 'failure-deck-selection.json').write_text(json.dumps(diagnostic,ensure_ascii=False,indent=2),encoding='utf-8')
            print('Deck diagnostic:', str(output), flush=True)
            print(json.dumps(diagnostic,ensure_ascii=False),flush=True)
            raise
        expect(tracker.locator('.gws-tracker-deck-needed')).to_have_count(0)
        expect(tracker.locator('[data-gws-tracker-action="tracker.configureDeck"]')).to_be_focused()
        expect(tracker.locator('[data-gws-tracker-action="tracker.start"]')).to_be_disabled()
        decks_before = gm.evaluate('async()=>(await gravewright.cards.state()).decks')
        assert len(decks_before) == 1 and decks_before[0]['id'] == seed['cardDeck']['id']

        tracker.locator('[data-gws-tracker-action="tracker.add"]').click()
        picker = gm.locator('.gws-tracker-modal')
        expect(picker.locator('.gws-tracker-choice')).to_have_count(2)
        choices = picker.locator('.gws-tracker-choice')
        choices.nth(0).get_by_role('button').click()
        expect(choices.nth(0).get_by_role('button')).to_be_disabled()
        choices.nth(1).get_by_role('button').click()
        expect(choices.nth(1).get_by_role('button')).to_be_disabled()
        picker.press('Escape')
        expect(picker).to_have_count(0)
        expect(tracker.locator('[data-gws-tracker-action="tracker.add"]')).to_be_focused()

        # Commit a native draw but replace its response with a transport failure.
        # Retry must replay that same card, not draw one extra or restart combat.
        intercepted = {'done': False, 'requestId': None}
        def lose_draw(route):
            payload = route.request.post_data_json
            if payload.get('domain') == 'cards' and payload.get('method') == 'draw' and not intercepted['done']:
                intercepted['done'] = True
                intercepted['requestId'] = payload.get('requestId')
                response = route.fetch()
                assert response.ok
                route.fulfill(status=503, json={'error': 'unavailable'})
            else:
                route.continue_()
        gm.route(SCOPED_API, lose_draw)
        tracker.locator('[data-gws-tracker-action="tracker.start"]').click()
        expect(tracker.locator('.gws-tracker-error')).to_be_visible(timeout=15000)
        assert intercepted['done']
        native_before = gm.evaluate('async()=>await gravewright.cards.state()')
        assert len(native_before['hand']) == 1
        tracker.locator('[data-gws-tracker-action="common.retry"]').click()
        expect(tracker.locator('.gws-tracker-phase')).to_be_visible(timeout=15000)
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        gm.unroute(SCOPED_API, lose_draw)
        native_cards = gm.evaluate('async()=>await gravewright.cards.state()')
        assert len(native_cards['hand']) == 2, native_cards
        assert native_cards['cards'] == []
        assert len(native_cards['decks']) == 1 and native_cards['decks'][0]['id'] == seed['cardDeck']['id']
        combat = gm.evaluate('async sceneId=>await gravewright.combat.state({sceneId})', seed['scene'])
        assert combat['round'] == 1 and all(entry['initiative'] > 0 for entry in combat['combatants']), combat
        original_encounter = combat['encounterId']
        assert tracker.locator('.gws-tracker-error').count() == 0
        assert_compact_layout(tracker)
        assert_front_images(gm)

        # The GM reserve is a single compact counter that opens its own modal.
        tracker.locator('[data-gws-tracker-action="tracker.gmBennies"]').click()
        pool = gm.locator('.gws-tracker-modal')
        expect(pool.locator('.gws-gm-benny-value')).to_have_text('0')
        pool.get_by_role('button', name=LABELS['tracker.gmBennyAdd'], exact=True).click()
        expect(pool.locator('.gws-gm-benny-value')).to_have_text('1')
        pool.get_by_role('button', name=LABELS['tracker.gmBennyRemove'], exact=True).click()
        expect(pool.locator('.gws-gm-benny-value')).to_have_text('0')
        pool.press('Escape')
        expect(pool).to_have_count(0)
        expect(tracker.locator('[data-gws-tracker-action="tracker.gmBennies"]')).to_be_focused()

        tracker.locator('[data-gws-tracker-action="tracker.beginRound"]').click()
        expect(tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_enabled(timeout=15000)
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        assert tracker.locator('.gws-tracker-phase').count() == 0
        combat = gm.evaluate('async sceneId=>await gravewright.combat.state({sceneId})', seed['scene'])
        current = next(entry for entry in combat['combatants'] if entry['current'])
        source = gm.evaluate("async ({actor,token})=>await gravewright.actors.sheet(actor,{tokenId:token})", {'actor': seed['actor'], 'token': current['token_id']})
        assert source['data']['statusClocks']['distracted']['awaitingStart'] is False
        other_token = seed['snapshotToken'] if current['token_id'] == seed['linkedToken'] else seed['linkedToken']
        other = gm.evaluate("async ({actor,token})=>await gravewright.actors.sheet(actor,{tokenId:token})", {'actor': seed['actor'], 'token': other_token})
        assert other['data']['statusClocks']['distracted']['awaitingStart'] is True

        player_tracker = show_tracker(player)
        expect(player_tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_enabled(timeout=15000)
        expect(player_tracker.locator('.gws-tracker-card img')).to_have_count(0)
        private_urls = [card['frontUrl'] for card in native_cards['hand'] if card.get('frontUrl')]
        player_markup = player_tracker.inner_html()
        assert all(url not in player_markup for url in private_urls)

        # Pause the playing phase. Reloading the GM must preserve its phase,
        # encounter identity, current turn, cards, resources and pending clocks.
        playing_before = native_snapshot(gm, seed)
        tracker.locator('[data-gws-tracker-action="tracker.pause"]').click()
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        assert_pause_controls(tracker, player_tracker)
        expect(tracker.locator('[data-gws-tracker-action="tracker.resume"]')).to_be_focused()
        assert tracker.locator('.gws-tracker-phase').count() == 0
        assert native_snapshot(gm, seed) == playing_before
        tracker = reopen_and_reload_paused(gm, player_tracker, seed, playing_before)
        assert tracker.locator('.gws-tracker-phase').count() == 0
        tracker.screenshot(path=str(output / 'tracker-paused-playing.png'))
        tracker.locator('[data-gws-tracker-action="tracker.resume"]').click()
        expect(tracker.locator('.gws-tracker-paused')).to_have_count(0)
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        expect(tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_enabled()
        expect(tracker.locator('[data-gws-tracker-action="tracker.pause"]')).to_be_focused()
        expect(tracker.locator('[data-gws-tracker-action="tracker.beginRound"]')).to_be_disabled()
        assert tracker.locator('.gws-tracker-phase').count() == 0
        expect(player_tracker.locator('.gws-tracker-paused')).to_have_count(0, timeout=15000)
        expect(player_tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_enabled(timeout=15000)
        assert native_snapshot(gm, seed) == playing_before

        # The existing owner regains its working native next-turn control.
        player_tracker.locator('[data-gws-tracker-action="tracker.next"]').click()
        expect(player_tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        current_after = gm.evaluate('async sceneId=>await gravewright.combat.state({sceneId})', seed['scene'])
        assert current_after['turn'] == 1, current_after
        first_after = gm.evaluate("async ({actor,token})=>await gravewright.actors.sheet(actor,{tokenId:token})", {'actor': seed['actor'], 'token': current['token_id']})
        assert first_after['data']['status']['distracted'] is False
        tracker.locator('[data-gws-tracker-action="tracker.next"]').click()
        expect(tracker.locator('.gws-tracker-phase')).to_be_visible(timeout=15000)
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        round_two = gm.evaluate('async sceneId=>await gravewright.combat.state({sceneId})', seed['scene'])
        assert round_two['round'] == 2 and round_two['encounterId'] == original_encounter

        # Also pause the ready phase: resuming must allow extra-card choices and
        # Begin Round, without silently starting play or dealing a fresh hand.
        ready_before = native_snapshot(gm, seed)
        tracker.locator('[data-gws-tracker-action="tracker.pause"]').click()
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        assert_pause_controls(tracker, player_tracker)
        expect(tracker.locator('.gws-tracker-phase')).to_have_count(0)
        assert native_snapshot(gm, seed) == ready_before
        tracker = reopen_and_reload_paused(gm, player_tracker, seed, ready_before)
        expect(tracker.locator('.gws-tracker-phase')).to_have_count(0)
        tracker.screenshot(path=str(output / 'tracker-paused-ready.png'))
        tracker.locator('[data-gws-tracker-action="tracker.resume"]').click()
        expect(tracker.locator('.gws-tracker-paused')).to_have_count(0)
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        expect(tracker.locator('.gws-tracker-phase')).to_be_visible()
        expect(tracker.locator('[data-gws-tracker-action="tracker.beginRound"]')).to_be_enabled()
        expect(tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_disabled()
        assert tracker.locator('[data-gws-tracker-action="tracker.bennyCard"]').count() == 0
        for row in tracker.locator('.gws-tracker-row').all():
            row.locator('[data-gws-tracker-action="tracker.actions"]').click()
            actions = gm.locator('.gws-tracker-modal')
            expect(actions.get_by_role('button', name=LABELS['tracker.bennyCard'], exact=True)).to_be_enabled()
            actions.press('Escape')
            expect(actions).to_have_count(0)
        expect(player_tracker.locator('.gws-tracker-paused')).to_have_count(0, timeout=15000)
        expect(player_tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_disabled()
        assert native_snapshot(gm, seed) == ready_before
        assert_front_images(gm)
        assert_compact_layout(tracker)

        assert player_tracker.locator('[data-gws-tracker-action="tracker.deal"]').count() == 0
        assert player.evaluate('async()=>(await gravewright.cards.state()).hand.length') == 0
        unauthorized = player.evaluate("""async sceneId=>{
          try {await gravewright.combat.setInitiative({sceneId,version:(await gravewright.combat.state({sceneId})).version,tokenId:(await gravewright.combat.state({sceneId})).combatants[0].token_id,value:61});return 'allowed';}
          catch(error){return error.code;}
        }""", seed['scene'])
        assert unauthorized in ('forbidden', 'permission_denied'), unauthorized
        tracker.screenshot(path=str(output / 'tracker-desktop.png'))
        gm.set_viewport_size({'width': 390, 'height': 1000})
        width = tracker.evaluate('element=>({client:element.clientWidth,scroll:element.scrollWidth})')
        assert width['scroll'] <= width['client'] + 1, width
        assert_compact_layout(tracker)
        assert_front_images(gm)
        gm.screenshot(path=str(output / 'tracker-mobile.png'))

        tracker.locator('[data-gws-tracker-action="tracker.beginRound"]').click()
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        expect(tracker.locator('[data-gws-tracker-action="tracker.next"]')).to_be_enabled()
        tracker.locator('[data-gws-tracker-action="tracker.next"]').click()
        expect(tracker).not_to_have_attribute('aria-busy', 'true', timeout=15000)
        resumed_ready = gm.evaluate('async sceneId=>await gravewright.combat.state({sceneId})', seed['scene'])
        assert resumed_ready['round'] == 2 and resumed_ready['turn'] == 1 and resumed_ready['encounterId'] == original_encounter
        tracker.locator('[data-gws-tracker-action="tracker.stop"]').click()
        expect(tracker.locator('[data-gws-tracker-action="tracker.start"]')).to_be_visible(timeout=15000)
        assert gm.locator('dialog').count() == 0 and not dialogs
        assert not errors, errors
        browser.close()
    return {'passed': True, 'nativeCards': True, 'lostResponseReplay': True, 'roundClockOrder': True, 'independentToken': True,
        'playerPermissions': True, 'pausePlaying': True, 'pauseReady': True, 'pausePersistence': True,
        'existingPlayerPauseSync': True, 'pausePreservesNativeState': True, 'configuredNativeDeck': True,
        'nativeFrontImages': True, 'privateFacesHidden': True, 'compactDndLayout': True, 'gmPoolModal': True,
        'mobile': width, 'output': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-root')
    parser.add_argument('--archive', type=Path, default=default_archive())
    args = parser.parse_args()
    root = host_root(args.host_root)
    output = root / 'test-results' / 'swade-tracker' / secrets.token_hex(8)
    output.mkdir(parents=True)
    server = log = None
    try:
        server, log, seed = start_fixture(root, output, args.archive.resolve(), 30019,
                                        with_card_deck=True, legacy_companion=True)
        result = smoke(seed, output)
        result['legacyCompanionSuperseded'] = True
        result['systemOnlyInInstalledLibrary'] = True
        result['bundledServerLoadedFromInstalledSystem'] = True
        archives = list((Path(seed['fixture']) / 'modules' / 'archives').glob('*.zip'))
        result['archiveSha256'] = fingerprint(archives[0]) if len(archives) == 1 else fingerprint(args.archive.resolve())
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        if log is not None:
            log.close()


if __name__ == '__main__':
    main()
