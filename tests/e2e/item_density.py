"""Audit every SWADE item tab and owned editor on a disposable released host."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from sheet_density import (DOCUMENTS, METRICS, configure_storage, fingerprint,
                           host_root, start_server, stop_server, write_json)


def audit(output, seed, args):
    from playwright.sync_api import expect, sync_playwright
    if seed.get('kind') != 'swade-isolated-review':
        raise RuntimeError('Only disposable review fixtures are supported.')
    records, errors = [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(args.browser),
            env={**os.environ, 'CHROME_LOG_FILE': str(output / 'chromium.log')})
        try:
            context = browser.new_context(viewport={'width': 1500, 'height': 1000}, locale='pt-BR')
            context.add_cookies([{**seed['sessions']['gm'], 'url': seed['base']}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(seed['base'] + '/game/' + seed['campaign'])
            page.wait_for_function('!!window.gravewrightItems && !!window.gravewrightActors')
            page.wait_for_function("performance.getEntriesByType('resource').some(x=>x.name.includes('gravewright.savage-worlds')&&x.name.includes('/main.js'))")
            module = page.evaluate("()=>performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('gravewright.savage-worlds')&&x.includes('/main.js'))")
            manifest = page.evaluate("async url=>fetch(new URL('manifest.json',url)).then(r=>r.json())", module)
            page.evaluate("async url=>window.densityModel=await import(new URL('model.js',url))", module)
            document_script = DOCUMENTS.replace("result.items.push({type,variant,", "if(variant!=='empty')data.modifiers=[{target:'attribute.smarts.steps',mode:'add',value:1,enabled:true}];result.items.push({type,variant,")
            docs = page.evaluate(document_script, manifest)
            write_json(output / 'documents.json', docs)
            if args.readonly_only:
                docs['items'] = [doc for doc in docs['items'] if doc['variant'] == 'populated']
                page.evaluate('''async ({docs,reader})=>{for(const doc of docs){const item=await gravewright.items.get(doc.id);await gravewright.items.setPermissions({id:doc.id,version:item.version,permissions:{[reader]:'read'}})}}''',
                    {'docs': docs['items'], 'reader': seed['users']['reader']})
                context = browser.new_context(viewport={'width': 1500, 'height': 1000}, locale='pt-BR')
                context.add_cookies([{**seed['sessions']['reader'], 'url': seed['base']}])
                context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(seed['base'] + '/game/' + seed['campaign'])
                page.wait_for_function('!!window.gravewrightItems')
            if args.quick:
                docs['items'] = [doc for doc in docs['items'] if doc['type'] in ['skill', 'weapon', 'power'] and doc['variant'] == 'empty']
            elif args.representative:
                docs['items'] = [doc for doc in docs['items'] if doc['variant'] == 'empty']

            def capture(window, editor, kind, doc, tab, width):
                result = editor.evaluate(METRICS)
                result.update(kind=kind, type=doc['type'], variant=doc['variant'], tab=tab, width=width,
                    frame=window.evaluate('el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}'))
                assert result['frame']['width'] <= width + 2, result
                close = window.locator(':scope > form > header [data-close],.gws-modal-close').first
                result['closeInFrame'] = close.evaluate('(el,frame)=>{const r=el.getBoundingClientRect();return r.y>=frame.y&&r.bottom<=frame.y+frame.height}', result['frame'])
                if args.strict:
                    assert result['closeInFrame'], 'The close button scrolled out of its item window'
                records.append(result)
                window.screenshot(path=str(output / f'{width}-{kind}-{doc["type"]}-{doc["variant"]}-{tab}.png'))
                if args.bottom_check and tab == 'details':
                    last = editor.locator('.gws-item-rules > .gws-button')
                    last.scroll_into_view_if_needed()
                    expect(last).to_be_in_viewport()
                    expect(close).to_be_in_viewport()
                    window.screenshot(path=str(output / f'{width}-{kind}-{doc["type"]}-{doc["variant"]}-{tab}-bottom.png'))

            for width in args.widths:
                page.set_viewport_size({'width': width, 'height': 1000 if width > 1000 else 844})
                for doc in docs['items']:
                    before = page.evaluate('id=>gravewright.items.get(id)', doc['id'])
                    page.evaluate('id=>gravewrightItems.open(id)', doc['id'])
                    window = page.locator(f'.item-sheet[data-item-id="{doc["id"]}"]')
                    editor = window.locator('.gws-item-editor')
                    expect(editor).to_be_visible()
                    if args.readonly_only:
                        assert before['canEdit'] is False
                        expect(editor.locator('.gws-item-reading')).to_be_visible()
                        assert editor.locator('input,select,textarea').evaluate_all('nodes=>nodes.every(node=>node.matches("select,[type=checkbox]")?node.disabled:node.readOnly)')
                    for tab in ['description', 'details']:
                        editor.locator(f'[data-gws-item-tab={tab}]').click()
                        expect(editor.locator(f'[data-gws-item-tab={tab}]')).to_have_attribute('aria-selected', 'true')
                        capture(window, editor, 'readonly' if args.readonly_only else 'library', doc, tab, width)
                    if not args.readonly_only:
                        editor.locator('[data-gws-item-tab=description]').click()
                        editor.locator('.gws-item-modebar button').click()
                        expect(editor.locator('.gws-item-reading')).to_be_visible()
                        capture(window, editor, 'reading', doc, 'description', width)
                        window.evaluate('el=>el.close()')
                    else:
                        page.keyboard.press('Escape')
                    expect(window).to_have_count(0)
                    after = page.evaluate('id=>gravewright.items.get(id)', doc['id'])
                    assert (before['name'], before['data'], before['version']) == (after['name'], after['data'], after['version']), doc

                if not args.quick and not args.readonly_only and not args.representative:
                    actor = next(doc for doc in docs['actors'] if doc['type'] == 'character' and doc['variant'] == 'populated')
                    before_actor = page.evaluate('id=>gravewright.actors.sheet(id)', actor['id'])
                    page.evaluate('id=>gravewrightActors.open(id)', actor['id'])
                    actor_window = page.locator(f'.actor-directory__sheet[data-actor-id="{actor["id"]}"]')
                    expect(actor_window.locator('.gws-sheet')).to_be_visible()
                    seen = set()
                    for tab in ['overview', 'equipment', 'features', 'powers']:
                        actor_window.locator(f'[data-gws-tab={tab}]').click()
                        if args.strict:
                            for table in actor_window.locator('.gws-table tbody').all():
                                names = table.locator('.gws-link').all_inner_texts()
                                assert page.evaluate('(names)=>{const c=new Intl.Collator("pt-BR",{usage:"sort",sensitivity:"base",numeric:true});return names.every((name,index)=>!index||c.compare(names[index-1],name)<=0)}', names), names
                        rows = actor_window.locator('tr[data-entry-id]')
                        for index in range(rows.count()):
                            row = rows.nth(index)
                            name = row.locator('.gws-link').first.inner_text()
                            item_type = name.removeprefix('Synthetic ')
                            if item_type in seen:
                                continue
                            seen.add(item_type)
                            row.locator('.gws-link').first.click()
                            window = page.locator('.gws-modal').last
                            editor = window.locator('.gws-item-editor')
                            expect(editor).to_be_visible()
                            for item_tab in ['description', 'details']:
                                editor.locator(f'[data-gws-item-tab={item_tab}]').click()
                                expect(editor.locator(f'[data-gws-item-tab={item_tab}]')).to_have_attribute('aria-selected', 'true')
                                capture(window, editor, 'owned', {'type': item_type, 'variant': 'populated'}, item_tab, width)
                            window.locator('.gws-modal-close').click()
                            expect(window).to_have_count(0)
                            expect(row.locator('.gws-link').first).to_be_focused()
                    assert seen == {entry['id'] for entry in manifest['system']['itemTypes']}, seen
                    actor_window.locator('[data-window=close]').click()
                    expect(actor_window).to_have_count(0)
                    after_actor = page.evaluate('id=>gravewright.actors.sheet(id)', actor['id'])
                    assert (before_actor['name'], before_actor['data'], before_actor['version']) == (after_actor['name'], after_actor['data'], after_actor['version']), 'Item browsing changed its actor'
                write_json(output / 'metrics.json', records)
                print(f'{width}px: {len(records)} item views complete', flush=True)
        finally:
            browser.close()
    summary = {'views': len(records), 'package': manifest['version'], 'pageErrors': errors,
        'below12': sum(bool(row['below12']) for row in records),
        'overflow': sum(bool(row['overflow']) for row in records),
        'cramped': sum(bool(row['cramped']) for row in records)}
    write_json(output / 'summary.json', summary)
    print(json.dumps(summary), flush=True)
    if args.strict:
        assert not errors and not summary['below12'] and not summary['overflow'] and not summary['cramped'], summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-root')
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--browser', type=Path, required=True)
    parser.add_argument('--widths', type=int, nargs='+', default=[1500, 390, 320])
    parser.add_argument('--quick', action='store_true')
    parser.add_argument('--readonly-only', action='store_true')
    parser.add_argument('--representative', action='store_true')
    parser.add_argument('--bottom-check', action='store_true')
    parser.add_argument('--strict', action='store_true')
    args = parser.parse_args()
    root, output = host_root(args.host_root), args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise RuntimeError(f'Use an empty output directory: {output}')
    output.mkdir(parents=True, exist_ok=True)
    configure_storage(root, output)
    original = fingerprint(root / '.env')
    process = log = None
    try:
        process, log, seed = start_server(root, output, args.archive.resolve(), 0)
        audit(output, seed, args)
    finally:
        if process is not None:
            stop_server(process)
        if log is not None:
            log.close()
        assert fingerprint(root / '.env') == original, 'The host .env changed'


if __name__ == '__main__':
    main()
