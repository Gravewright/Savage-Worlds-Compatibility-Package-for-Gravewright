"""Mechanical and permission regression checks on a disposable installed ZIP.

No production database or environment file is used. Critical dice facts are
controlled only in this browser fixture; saves use the actual native host API.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import secrets
import subprocess

from playwright.sync_api import expect, sync_playwright

from review_server import MODULE, default_archive, host_root
from swade import close_actor, close_item, open_actor, open_item, read_actor, start_fixture


LABELS = json.loads((MODULE / 'locales' / 'pt-BR.json').read_text(encoding='utf-8'))
SCOPED_API = '**/api/tables/*/modules/gravewright.savage-worlds/api'
TYPES = ('weapon', 'armor', 'equipment', 'consumable', 'vehicle', 'arcane-device',
         'skill', 'edge', 'hindrance', 'ancestry', 'racial-feature', 'power', 'effect')


def button(scope, key):
    return scope.get_by_role('button', name=re.compile(r'^(?:\+ )?' + re.escape(LABELS[key]) + '$'))


def dismiss(page):
    while page.locator('.gws-modal').count():
        modal = page.locator('.gws-modal').last
        done = button(modal, 'common.done')
        if done.count():
            done.click()
        else:
            modal.locator('.gws-modal-close').click()
        expect(modal).to_have_count(0)


def save_data(page, actor, data):
    return page.evaluate('''async ({id,data})=>{
        const view=await gravewright.actors.sheet(id);
        return await gravewright.actors.saveSheet({actorId:id,name:view.name,
          version:view.version,sheetVersion:view.sheetVersion,data});
    }''', {'id': actor, 'data': data})


def stat(window, key, value):
    expect(window.locator(f'[data-gws-path="stats.{key}"]')).to_have_value(str(value))


def row(item_id, item_type, name, data, equipped=False):
    return {'id': item_id, 'sourceId': '', 'type': item_type, 'name': name, 'img': '',
            'quantity': 1, 'equipped': equipped, 'prepared': False,
            'data': {**data, 'quantity': 1, 'equipped': equipped}}


def dice_message(message, faces):
    """Replace native numeric facts without changing its authorized message id."""
    result = {'schema': 'gravewright-dice-result',
              'value': {'kind': 'number', 'value': max(faces)},
              'rolls': [{'facts': [{'id': f'{index}-0', 'face': face,
                                   'cause': {'kind': 'initial'}}],
                         'selection': {f'{index}-0': 'active'}}
                        for index, face in enumerate(faces)]}
    message.setdefault('roll', {})['result'] = result
    return message


def test_rules(seed, output):
    errors, dialogs, passed = [], [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        pages = {}
        for role in ('gm', 'editor', 'reader'):
            context = browser.new_context(viewport={'width': 1500, 'height': 1100}, locale='pt-BR')
            context.add_cookies([{**seed['sessions'][role], 'url': seed['base']}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page = context.new_page()
            page.on('pageerror', lambda error: (errors.append(str(error)), print('Browser error:', error, flush=True)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.type), dialog.dismiss()))
            page.goto(seed['base'] + '/game/' + seed['campaign'])
            page.wait_for_function('!!window.gravewrightActors && !!window.gravewrightItems')
            expect(page.locator('.game-menubar__presence')).to_have_attribute('data-presence', 'seated', timeout=15000)
            pages[role] = page
        page, actor = pages['gm'], seed['actor']
        window = open_actor(page, actor)
        stat(window, 'pace', 6)
        stat(window, 'parry', 2)
        stat(window, 'toughness', 4)
        expect(window.locator('[data-resource="wounds"] .gws-pip')).to_have_count(3)
        expect(window.locator('[data-resource="fatigue"] .gws-pip')).to_have_count(2)
        window.locator('[data-gws-tab="notes"]').click()
        window.locator('[data-gws-path="notes"]').fill('Disposable rules fixture')
        close_actor(window)
        base = read_actor(page, actor)['data']
        assert base['calculation']['automatic'] is True
        assert base['profile']['kind'] == 'wild-card' and base['profile']['role'] == 'player'
        assert base['resources']['bennies'] == 3
        passed.append('fresh-derived-defaults')

        npc = page.evaluate("async()=>await gravewright.actors.create({name:'Fixture Extra',type:'npc',data:{}})")
        expect(page.locator('#actors-panel').get_by_text('Fixture Extra', exact=True)).to_have_count(1)
        npc_window = open_actor(page, npc['id'])
        button(npc_window.locator('.gws-footer'), 'rules.characterSettings').click()
        settings = page.locator('.gws-modal').last
        expect(settings.locator('[data-gws-path="profile.kind"]')).to_have_value('extra')
        expect(settings.locator('[data-gws-path="profile.role"]')).to_have_value('enemy')
        settings.locator('[data-gws-path="profile.wildDie"]').fill('8')
        settings.locator('[data-gws-path="profile.kind"]').select_option('wild-card')
        page.screenshot(path=str(output / 'swade-settings-modal.png'))
        dismiss(page)
        close_actor(npc_window)
        npc_data = read_actor(page, npc['id'])['data']
        assert npc_data['resources']['bennies'] == 0 and npc_data['profile']['wildDie'] == 8
        assert npc_data['profile']['kind'] == 'wild-card'
        passed.append('npc-profile-settings')

        window = open_actor(page, actor)
        vigor = window.locator('.gws-attribute[data-attribute="vigor"]')
        vigor.locator('.gws-attribute-controls button').nth(1).click()
        editor = page.locator('.gws-modal').last
        editor.locator('[data-gws-path="attributes.vigor.die"]').select_option('12')
        editor.locator('[data-gws-path="attributes.vigor.modifier"]').fill('2')
        dismiss(page)
        stat(window, 'toughness', 9)
        close_actor(window)
        base = read_actor(page, actor)['data']
        assert base['attributes']['vigor'] == {'die': 12, 'modifier': 2}
        passed.append('post-d12-attribute-derived')

        base['skills'] = [row('fight', 'skill', 'User combat skill',
                              {'attribute': 'agility', 'die': 8, 'modifier': 0, 'role': 'fighting'}),
                          row('magic', 'skill', 'User arcane skill',
                              {'attribute': 'smarts', 'die': 6, 'modifier': 0, 'role': 'arcane'})]
        base['inventory'] = [
            row('outer', 'armor', 'Outer armor', {'kind': 'armor', 'protection': 4, 'locations': ['torso'], 'weight': 1}, True),
            row('inner', 'armor', 'Inner armor', {'kind': 'armor', 'protection': 2, 'locations': ['torso'], 'weight': 1}, True),
            row('shield', 'armor', 'User shield', {'kind': 'shield', 'protection': 6, 'locations': [], 'parryBonus': 2, 'weight': 1}, True),
            row('vehicle', 'vehicle', 'Parked vehicle', {'weight': 10000, 'carried': False}),
        ]
        save_data(page, actor, base)
        window = open_actor(page, actor)
        stat(window, 'parry', 8)
        stat(window, 'toughness', 14)
        stat(window, 'pace', 6)
        expect(window.locator('.gws-stat-armor')).to_contain_text('5')
        page.screenshot(path=str(output / 'swade-rules-desktop.png'))
        close_actor(window)
        passed.append('layered-armor-shield-vehicle-load')

        # Real native expressions include permanent trait bonuses and only the
        # penalties appropriate to the action; bound still allows mental rolls.
        normal = read_actor(page, actor)['data']
        penalized = json.loads(json.dumps(normal))
        penalized['resources'].update(wounds=2, fatigue=1)
        penalized['status']['distracted'] = True
        save_data(page, actor, penalized)
        trait_expressions = []
        def inspect_trait(route):
            request = route.request.post_data_json
            if request.get('domain') == 'dice' and request.get('method') == 'roll':
                trait_expressions.append(request['payload']['expression'])
            route.continue_()
        page.route(SCOPED_API, inspect_trait)
        window = open_actor(page, actor)
        stat(window, 'pace', 4)
        window.locator('.gws-attribute[data-attribute="vigor"] .gws-die').click()
        trait_modal = page.locator('.gws-modal').last
        trait_modal.locator('[data-gws-rule="actions"]').fill('2')
        trait_modal.locator('[data-gws-rule="running"]').check()
        button(trait_modal, 'rules.roll').click()
        expect(button(trait_modal, 'rules.roll')).to_be_hidden()
        assert trait_expressions[-1] == 'max(1d12!,1d6!)-7', trait_expressions
        dismiss(page)
        close_actor(window)
        penalized['status']['bound'] = True
        save_data(page, actor, penalized)
        window = open_actor(page, actor)
        window.locator('.gws-attribute[data-attribute="smarts"] .gws-die').click()
        trait_modal = page.locator('.gws-modal').last
        button(trait_modal, 'rules.roll').click()
        expect(button(trait_modal, 'rules.roll')).to_be_hidden()
        assert trait_expressions[-1] == 'max(1d4!,1d6!)-5', trait_expressions
        dismiss(page)
        window.locator('.gws-attribute[data-attribute="strength"] .gws-die').click()
        trait_modal = page.locator('.gws-modal').last
        button(trait_modal, 'rules.roll').click()
        expect(trait_modal.get_by_text(LABELS['rules.cannotAct'], exact=True)).to_be_visible()
        assert len(trait_expressions) == 2
        dismiss(page)
        close_actor(window)
        page.unroute(SCOPED_API, inspect_trait)
        save_data(page, actor, normal)
        passed.append('native-trait-penalties-bound-mental')

        # Every registered type opens its own installed native item template.
        item_ids = {}
        for item_type in TYPES:
            item = page.evaluate('async type=>await gravewright.items.create({name:"Fixture "+type,type,data:{}})', item_type)
            item_ids[item_type] = item['id']
            item_window = open_item(page, item['id'])
            item_window.locator('[data-gws-item-tab="details"]').click()
            expect(item_window.locator('.gws-item-rules')).to_be_visible()
            if item_type == 'vehicle':
                expect(item_window.locator('[data-gws-item-field="woundsMax"]')).to_have_value('3')
            if item_type == 'skill':
                item_window.locator('[data-gws-item-field="role"]').select_option('fighting')
                item_window.locator('[data-gws-item-field="untrained"]').check()
            if item_type == 'edge':
                button(item_window, 'rules.addModifier').click()
                modifier = item_window.locator('.gws-modifier-row')
                target = modifier.get_by_label(LABELS['rules.modifierTarget'], exact=True)
                if target.evaluate('node=>node.tagName') == 'SELECT':
                    target.select_option('toughness')
                else:
                    target.fill('toughness')
                modifier.get_by_role('spinbutton', name=LABELS['rules.modifierValue'], exact=True).fill('2')
                page.screenshot(path=str(output / 'swade-item-mechanics.png'))
            close_item(item_window)
        saved_edge = page.evaluate('async id=>await gravewright.items.get(id)', item_ids['edge'])
        assert saved_edge['data']['modifiers'][0]['target'] == 'toughness'
        assert saved_edge['data']['modifiers'][0]['value'] == 2
        passed.append('13-installed-item-templates')

        # Stage boundaries update after a flushed edit; ledger is user-authored.
        window = open_actor(page, actor)
        for advances, rank in ((3, 'novice'), (4, 'seasoned'), (8, 'veteran'), (12, 'heroic'), (16, 'legendary')):
            window.locator('[data-gws-path="identity.advances"]').fill(str(advances))
            window.locator('[data-gws-tab="notes"]').click()
            expect(window.locator('[data-gws-path="identity.rank"]')).to_have_value(LABELS['rules.rank.' + rank])
            window.locator('[data-gws-tab="overview"]').click()
        button(window.locator('.gws-footer'), 'rules.characterSettings').click()
        settings = page.locator('.gws-modal').last
        button(settings, 'rules.addProgress').click()
        ledger = settings.locator('.gws-progress-list .gws-pool-row').last
        ledger.get_by_role('spinbutton', name=LABELS['rules.progressNumber'], exact=True).fill('16')
        ledger.get_by_role('combobox', name=LABELS['rules.progressKind'], exact=True).select_option('attribute')
        ledger.get_by_role('textbox', name=LABELS['rules.progressTarget'], exact=True).fill('vigor')
        if button(settings, 'rules.reviewLedger').count():
            button(settings, 'rules.reviewLedger').click()
            expect(settings.get_by_text(LABELS['common.saved'], exact=True)).to_be_visible()
            button(settings, 'rules.addProgress').click()
            duplicate = settings.locator('.gws-progress-list .gws-pool-row').last
            duplicate.get_by_role('combobox', name=LABELS['rules.progressKind'], exact=True).select_option('attribute')
            button(settings, 'rules.reviewLedger').click()
            expect(settings.get_by_text(re.compile(re.escape(LABELS['rules.ledgerIssues'].split('{count}')[0])))).to_be_visible()
            button(duplicate, 'common.remove').click()
        dismiss(page)
        close_actor(window)
        assert read_actor(page, actor)['data']['advancement']['ledger'][-1]['advance'] == 16
        passed.append('stage-boundaries-ledger')

        # Create independent pools via UI, then activate a user-authored power.
        base = read_actor(page, actor)['data']
        base['arcanePools'] = []
        base['powers'] = [row('power', 'power', 'User power', {
            'powerPoints': 3, 'poolId': '', 'skillId': 'magic', 'durationRounds': 5, 'maintainable': True})]
        save_data(page, actor, base)
        window = open_actor(page, actor)
        window.locator('[data-gws-tab="powers"]').click()
        for name in ('Pool A', 'Pool B'):
            button(window, 'rules.addPool').click()
            pool = window.locator('[data-pool-id]').last
            pool.get_by_role('textbox', name=LABELS['common.name'], exact=True).fill(name)
            pool.get_by_role('spinbutton', name=LABELS['common.current'], exact=True).fill('10')
            pool.get_by_role('spinbutton', name=LABELS['common.maximum'], exact=True).fill('10')
            pool.get_by_role('combobox', name=LABELS['rules.arcaneSkill'], exact=True).select_option('magic')
        close_actor(window)
        base = read_actor(page, actor)['data']
        pool_id = base['arcanePools'][0]['id']
        base['powers'][0]['data']['poolId'] = pool_id
        save_data(page, actor, base)
        probe = {'rolls': 0, 'failed': False, 'critical': False, 'fail_save': False, 'expressions': []}
        def controlled_native(route):
            request = route.request.post_data_json
            if request.get('domain') == 'dice' and request.get('method') == 'roll':
                probe['rolls'] += 1
                probe['expressions'].append(request.get('payload', {}).get('expression'))
                response = route.fetch()
                response_data = response.json()
                response_data['value'] = dice_message(response_data['value'], [1, 1] if probe['critical'] else [4, 2])
                route.fulfill(response=response, json=response_data)
            elif request.get('domain') == 'actors' and request.get('method') == 'saveSheet' and probe['fail_save'] and not probe['failed']:
                probe['failed'] = True
                route.fulfill(status=503, json={'error': 'isolated-test-retry'})
            else:
                route.continue_()
        page.route(SCOPED_API, controlled_native)
        window = open_actor(page, actor)
        window.locator('[data-gws-tab="powers"]').click()
        button(window.locator('[data-entry-id="power"]'), 'rules.roll').click()
        cast = page.locator('.gws-modal').last
        button(cast, 'rules.roll').click()
        expect(button(cast, 'rules.apply')).to_be_visible()
        page.screenshot(path=str(output / 'swade-power-modal.png'))
        button(cast, 'rules.apply').click()
        expect(button(cast, 'rules.apply')).to_be_disabled()
        dismiss(page)
        data = read_actor(page, actor)['data']
        assert [pool['current'] for pool in data['arcanePools']] == [7, 10]
        assert len(data['activePowers']) == 1 and data['activePowers'][0]['active']
        button(window, 'rules.maintain').click()
        expect(window.locator('.gws-picker-row').filter(has_text='User power')).to_contain_text('10')
        data = read_actor(page, actor)['data']
        assert data['arcanePools'][0]['current'] == 6 and data['activePowers'][0]['maintained']
        probe.update(critical=True, fail_save=True)
        button(window.locator('[data-entry-id="power"]'), 'rules.roll').click()
        cast = page.locator('.gws-modal').last
        button(cast, 'rules.roll').click()
        expect(button(cast, 'rules.apply')).to_be_visible()
        button(cast, 'rules.apply').click()
        expect(cast.locator('.gws-notice').filter(has_text=LABELS['common.saveError']).first).to_be_visible()
        assert read_actor(page, actor)['data']['resources']['fatigue'] == 0
        button(cast, 'rules.apply').click()
        expect(button(cast, 'rules.apply')).to_be_disabled()
        dismiss(page)
        close_actor(window)
        data = read_actor(page, actor)['data']
        assert data['resources']['fatigue'] == 1 and data['arcanePools'][0]['current'] == 5
        assert data['arcanePools'][1]['current'] == 10
        assert len(data['activePowers']) == 1 and not data['activePowers'][0]['active']
        assert probe['rolls'] == 2 and probe['failed'], probe
        page.unroute(SCOPED_API, controlled_native)
        passed.append('independent-pools-maintenance-critical-retry')

        owner = pages['editor']
        owner_window = open_actor(owner, actor)
        owner_window.locator('[data-gws-path="core.name"]').fill('Owner edited fixture')
        close_actor(owner_window)
        assert read_actor(page, actor)['name'] == 'Owner edited fixture'
        reader = pages['reader']
        reader_window = open_actor(reader, actor)
        assert reader_window.locator('[data-gws-path="core.name"]').evaluate('node=>node.readOnly')
        for control in reader_window.locator('.gws-actionbar button').all():
            expect(control).to_be_disabled()
        button(reader_window.locator('.gws-footer'), 'rules.characterSettings').click()
        settings = reader.locator('.gws-modal').last
        expect(settings.locator('[data-gws-path="profile.kind"]')).to_be_disabled()
        expect(button(settings, 'rules.addProgress')).to_be_disabled()
        dismiss(reader)
        close_actor(reader_window)
        denied = reader.evaluate('''async id=>{const view=await gravewright.actors.sheet(id);
          try{await gravewright.actors.saveSheet({actorId:id,name:view.name,
          version:view.version,sheetVersion:view.sheetVersion,data:{...view.data,notes:'denied'}});return null;}
          catch(error){return error.code;}}''', actor)
        assert denied in ('permission_denied', 'not_found'), denied
        passed.append('owner-readonly-server-permissions')

        page.set_viewport_size({'width': 390, 'height': 844})
        window = open_actor(page, actor)
        page.screenshot(path=str(output / 'swade-rules-mobile.png'))
        assert window.locator('.gws-sheet').evaluate('node=>node.scrollWidth<=node.clientWidth+2'), 'Sheet overflows on mobile'
        button(window.locator('.gws-footer'), 'rules.characterSettings').click()
        page.screenshot(path=str(output / 'swade-settings-mobile.png'))
        assert page.locator('.gws-modal').last.evaluate('node=>node.scrollWidth<=node.clientWidth+2'), 'Settings overflow on mobile'
        dismiss(page)
        close_actor(window)
        assert page.locator('dialog').count() == 0 and not dialogs, dialogs
        assert not errors, errors
        passed.append('mobile-native-modal-no-browser-dialogs')
        browser.close()
    return {'passed': True, 'scenarios': passed, 'itemTypes': len(TYPES), 'screenshots': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-root')
    parser.add_argument('--archive', type=Path, default=default_archive())
    parser.add_argument('--port', type=int, default=30029)
    args = parser.parse_args()
    root = host_root(args.host_root)
    output = root / 'test-results' / 'swade-rules' / secrets.token_hex(8)
    output.mkdir(parents=True)
    server = log = None
    try:
        server, log, seed = start_fixture(root, output, args.archive.resolve(), args.port)
        result = test_rules(seed, output)
        installed_archives = list((Path(seed['fixture']) / 'modules' / 'archives').glob('*.zip'))
        if len(installed_archives) == 1:
            result['archiveSha256'] = installed_archives[0].stem
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


if __name__ == '__main__':
    main()
