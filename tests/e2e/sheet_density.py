"""Review every installed SWADE sheet/tab in a disposable native host fixture.

Build the system ZIP first, then run this script with --host-root pointing at a
Gravewright checkout. The default matrix covers all registered actor/item types,
empty/populated/long data, and 1500/1024/390px viewports. --strict rejects interface
text below 12px and visible horizontal overflow. No live campaign is supported.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import sysconfig
import time
from urllib.request import ProxyHandler, build_opener
from zipfile import ZipFile

from review_server import available_port, configure_environment, create_fixture, default_archive, host_root


METRICS = r"""sheet => {
  const visible=el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const bounds=el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};
  const nodes=[sheet,...sheet.querySelectorAll('*')].filter(el=>visible(el)&&!el.closest('svg'));
  const text=nodes.filter(el=>[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||el.matches('input:not([type=checkbox]):not([type=file]),select,textarea'));
  const below=text.filter(el=>parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({tag:el.tagName,class:el.className,text:el.textContent.slice(0,60),font:getComputedStyle(el).fontSize}));
  const overflow=nodes.filter(el=>el.clientWidth>0&&el.scrollWidth>el.clientWidth+2&&getComputedStyle(el).overflowX==='visible').map(el=>({tag:el.tagName,class:el.className,width:el.clientWidth,scroll:el.scrollWidth}));
  const cramped=nodes.filter(el=>el.matches('.gws-modifier-row > input[type=number]')&&el.getBoundingClientRect().width<48).map(bounds);
  const selectors=['.gws-header','.gws-attribute','.gws-attribute-grid','.gws-resources','.gws-overview-top','.gws-overview-bottom','.gws-item-hero','.gws-item-image','.gws-item-facts','.gws-item-body','.gws-item-group','.gws-item-detail-grid','.gws-field textarea','.gws-empty-state'];
  return {sheet:bounds(sheet),below12:below,overflow,cramped,sections:Object.fromEntries(selectors.map(s=>[s,[...sheet.querySelectorAll(s)].filter(visible).map(bounds)]))};
}"""

DOCUMENTS = r"""async manifest => {
  const m=window.densityModel,result={actors:[],items:[]};
  const text='Synthetic long authored note with Unicode: Ação - Élan. This checks wrapping and usable density. '.repeat(12);
  for(const type of manifest.system.actorTypes.map(x=>x.id))for(const variant of ['empty','populated','long']){
    const data=m.createSheet({actorType:type});
    if(variant!=='empty'){
      data.identity.concept=variant==='long'?text:'Synthetic traveller';data.identity.advances=8;
      data.biography=text;data.notes=text;data.profile.kind=variant==='long'?'extra':'wild-card';
      for(const itemType of manifest.system.itemTypes.map(x=>x.id)){
        const itemData=m.createItemSheet(itemType);Object.assign(itemData,{description:text,notes:text,quantity:2,weight:1,cost:10,die:6,equipped:true});
        if(itemType==='weapon')Object.assign(itemData,{category:'Melee',damage:'Str+d6',range:'Touch'});
        if(itemType==='power')Object.assign(itemData,{powerPoints:3,range:'12',duration:'3 rounds'});
        const row=m.itemToRow({id:crypto.randomUUID(),type:itemType,name:variant==='long'?text.slice(0,180):'Synthetic '+itemType,data:itemData});
        const col=m.collectionForType(itemType);if(col)data[col].push(row);
      }
      data.arcanePools=[{id:'test-pool',name:variant==='long'?text.slice(0,120):'Synthetic pool',current:8,max:12,skillId:''}];
    }
    result.actors.push({type,variant,...await gravewright.actors.create({name:type+' '+variant,type,data})});
  }
  for(const type of manifest.system.itemTypes.map(x=>x.id))for(const variant of ['empty','populated','long']){
    const data=m.createItemSheet(type);
    if(variant!=='empty')for(const key of Object.keys(data)){
      if(typeof data[key]==='string'&&!['img','attribute','die'].includes(key))data[key]=['description','notes','properties','requirements','trapping'].includes(key)?text:'Synthetic '+key;
      else if(typeof data[key]==='number')data[key]=2;
    }
    if(type==='skill')Object.assign(data,{attribute:'agility',die:6});
    result.items.push({type,variant,...await gravewright.items.create({name:variant==='long'?('Synthetic long '+type+' name ').repeat(8).slice(0,120):'Synthetic '+type+' '+variant,type,data})});
  }
  return result;
}"""


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def fingerprint(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def configure_storage(root: Path, output: Path) -> None:
    # Resolve an already installed browser before the helper redirects child
    # profile/cache paths. This test never downloads browsers or dependencies.
    if 'PLAYWRIGHT_BROWSERS_PATH' not in os.environ:
        candidates = [root / 'data/runner/ms-playwright', root / 'data/runner/playwright']
        if os.name == 'nt' and os.environ.get('LOCALAPPDATA'):
            candidates.append(Path(os.environ['LOCALAPPDATA']) / 'ms-playwright')
        for candidate in candidates:
            if candidate.is_dir() and any(candidate.glob('chromium*')):
                os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(candidate.resolve())
                break
    sys.path.insert(0, str(root))
    from scripts.runtime_storage import configure_runtime_storage
    configure_runtime_storage(root, tools_root=output / 'runtime')
    os.environ.update(PYTHONDONTWRITEBYTECODE='1', PYTHONUTF8='1', PYTHON_DOTENV_DISABLED='1')


def serve(root: Path, output: Path, archive: Path, fixture: Path, port: int) -> None:
    fixture.mkdir(parents=True, exist_ok=True)
    if any(fixture.iterdir()):
        raise RuntimeError(f'Use a fresh disposable fixture: {fixture}')
    configure_environment(root, fixture, port)
    seed = create_fixture(root, fixture, archive, None)
    seed['base'] = f'http://127.0.0.1:{port}'
    write_json(output / 'seed.json', seed)
    from django.core.management import call_command
    # Disable Django's reloader. The parent launches the actual interpreter on
    # Windows, avoiding a virtualenv redirector and its unowned child process.
    call_command('runserver', f'127.0.0.1:{port}', use_reloader=False, verbosity=0)


def stop_server(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def start_server(root: Path, output: Path, archive: Path, port: int):
    fixture = output / 'fixture'
    if os.name == 'nt':
        with ZipFile(archive) as package:
            manifest = json.loads(package.read('manifest.json'))
            destination = fixture / 'modules/packages' / manifest['id'] / manifest['version'] / fingerprint(archive)
            if any(len(str(destination / name)) >= 260 for name in package.namelist()):
                fixture = root / 'data' / f'sd-{secrets.token_hex(4)}'
    log = (output / 'server.log').open('w', encoding='utf-8')
    interpreter = sys.executable
    environment = os.environ.copy()
    if os.name == 'nt':
        # A venv's python.exe redirects to another process on Windows. Launch
        # that actual interpreter while retaining this environment's packages;
        # terminate()/wait() then own the complete server lifetime directly.
        interpreter = sys._base_executable
        environment['PYTHONPATH'] = os.pathsep.join(filter(None, [
            sysconfig.get_path('purelib'), environment.get('PYTHONPATH', '')]))
    port = available_port(port)
    command = [interpreter, '-B', '-X', 'utf8', str(Path(__file__).resolve()), '--server',
               '--host-root', str(root), '--output', str(output), '--archive', str(archive),
               '--fixture', str(fixture), '--port', str(port)]
    process = None
    try:
        process = subprocess.Popen(command, cwd=root, stdout=log, stderr=log, env=environment)
        write_json(output / 'owned-server.json', {'pid': process.pid, 'port': port,
                   'interpreter': str(interpreter), 'fixture': str(fixture)})
    except BaseException:
        if process is not None:
            stop_server(process)
        log.close()
        raise
    opener = build_opener(ProxyHandler({}))
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f'Server failed; inspect {output / "server.log"}')
            if (output / 'seed.json').is_file():
                seed = json.loads((output / 'seed.json').read_text(encoding='utf-8'))
                try:
                    with opener.open(seed['base'] + '/api/auth/status', timeout=1) as response:
                        if response.status == 200:
                            return process, log, seed
                except OSError:
                    pass
            time.sleep(.1)
        raise RuntimeError(f'Server startup timeout; inspect {output / "server.log"}')
    except BaseException:
        stop_server(process)
        log.close()
        raise


def extras(page, docs, output: Path, viewport: dict) -> list:
    from playwright.sync_api import expect
    records = []
    actor = next(doc for doc in docs['actors'] if doc['type'] == 'character' and doc['variant'] == 'populated')
    page.evaluate(r"""async id=>{
      const view=await gravewright.actors.sheet(id);
      for(const col of ['inventory','skills','edges','hindrances','ancestries','racialFeatures','powers','effects'])for(const row of view.data[col]||[])row.data.modifiers=[{target:'attribute.smarts.steps',mode:'add',value:1,enabled:true}];
      await gravewright.actors.saveSheet({actorId:id,name:view.name,version:view.version,sheetVersion:view.sheetVersion,data:view.data});
    }""", actor['id'])
    page.evaluate('id=>gravewrightActors.open(id)', actor['id'])
    window = page.locator(f'.actor-directory__sheet[data-actor-id="{actor["id"]}"]')
    expect(window.locator('.gws-sheet')).to_be_visible()
    for tab in ['overview', 'equipment', 'features', 'powers']:
        window.locator(f'[data-gws-tab={tab}]').click()
        rows = window.locator('[data-entry-id]')
        for index in range(rows.count()):
            row = rows.nth(index)
            label = row.locator('.gws-link').first.inner_text()
            if tab == 'overview' and label != 'Synthetic skill':
                continue
            if tab == 'powers' and label != 'Synthetic power':
                continue
            row.locator('.gws-link').first.click()
            modal = page.locator('.gws-modal').last
            expect(modal).to_be_visible()
            for item_tab in ['description', 'details']:
                modal.locator(f'[data-gws-item-tab={item_tab}]').click()
                result = modal.evaluate(METRICS)
                result.update(kind='embedded', type=label, tab=item_tab, viewport=viewport)
                records.append(result)
                stem = f"{viewport['width']}-embedded-{label.replace(' ', '-')}-{item_tab}"
                modal.screenshot(path=str(output / f'{stem}.png'))
                if item_tab == 'details':
                    modal.evaluate('el=>el.scrollTop=el.scrollHeight')
                    modal.screenshot(path=str(output / f'{stem}-bottom.png'))
            modal.locator('.gws-modal-close').click()
            expect(modal).to_have_count(0)
    window.locator('[data-window=close]').click()
    expect(window).to_have_count(0)
    for doc in [entry for entry in docs['items'] if entry['variant'] == 'populated']:
        page.evaluate('id=>gravewrightItems.open(id)', doc['id'])
        window = page.locator(f'.item-sheet[data-item-id="{doc["id"]}"]')
        expect(window.locator('.gws-sheet')).to_be_visible()
        window.locator('.gws-item-modebar button').click()
        expect(window.locator('.gws-item-reading')).to_be_visible()
        result = window.locator('.gws-sheet').evaluate(METRICS)
        result.update(kind='reading', type=doc['type'], tab='description', viewport=viewport)
        records.append(result)
        window.screenshot(path=str(output / f"{viewport['width']}-reading-{doc['type']}.png"))
        window.evaluate('el=>el.close()')
        expect(window).to_have_count(0)
    return records


def audit(output: Path, seed: dict, args) -> dict:
    from playwright.sync_api import expect, sync_playwright
    if seed.get('kind') != 'swade-isolated-review' or not (Path(seed['fixture']) / 'review.sqlite3').is_file():
        raise RuntimeError('Only disposable review_server.py fixture seeds are supported.')
    records, extra_records, errors = [], [], []
    with sync_playwright() as playwright:
        launch = {'env': {**os.environ, 'CHROME_LOG_FILE': str(output / 'chromium.log')}}
        if args.browser_executable:
            launch['executable_path'] = str(args.browser_executable.resolve())
        browser = playwright.chromium.launch(**launch)
        try:
            context = browser.new_context(viewport={'width': 1500, 'height': 1000}, locale='pt-BR')
            context.add_cookies([{**seed['sessions']['gm'], 'url': seed['base']}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(seed['base'] + '/game/' + seed['campaign'])
            page.wait_for_function('!!window.gravewrightActors && !!window.gravewrightItems && !!window.gravewright')
            page.wait_for_function("performance.getEntriesByType('resource').some(x=>x.name.includes('gravewright.savage-worlds')&&x.name.includes('/main.js'))", timeout=30000)
            module_url = page.evaluate("()=>performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('gravewright.savage-worlds')&&x.includes('/main.js'))")
            manifest = page.evaluate("async url=>await fetch(new URL('manifest.json',url)).then(r=>r.json())", module_url)
            page.evaluate("async url=>{window.densityModel=await import(new URL('model.js',url))}", module_url)
            docs = page.evaluate(DOCUMENTS, manifest)
            write_json(output / 'documents.json', docs)
            for width in args.widths:
                viewport = {'width': width, 'height': {1500: 1000, 1024: 768, 390: 844}.get(width, 1000)}
                page.set_viewport_size(viewport)
                for kind in ['actors', 'items']:
                    for doc in docs[kind]:
                        actor = kind == 'actors'
                        page.evaluate('async args=>await(args.actor?gravewrightActors:gravewrightItems).open(args.id)', {'id': doc['id'], 'actor': actor})
                        window = page.locator(f'.actor-directory__sheet[data-actor-id="{doc["id"]}"]' if actor else f'.item-sheet[data-item-id="{doc["id"]}"]')
                        sheet = window.locator('.gws-sheet').first
                        expect(sheet).to_be_visible()
                        attribute = 'data-gws-tab' if actor else 'data-gws-item-tab'
                        tabs = sheet.locator(f'[{attribute}]').evaluate_all('(nodes,attribute)=>nodes.map(el=>el.getAttribute(attribute))', attribute)
                        for tab in tabs:
                            control = sheet.locator(f'[{attribute}="{tab}"]')
                            control.click()
                            expect(control).to_have_attribute('aria-selected', 'true')
                            result = sheet.evaluate(METRICS)
                            result.update(document=doc['id'], kind=kind, type=doc['type'], variant=doc['variant'], tab=tab, viewport=viewport)
                            records.append(result)
                            window.screenshot(path=str(output / f"{width}-{kind}-{doc['type']}-{doc['variant']}-{tab}.png"))
                        if actor:
                            window.locator('[data-window=close]').click()
                        else:
                            window.evaluate('el=>el.close()')
                        expect(window).to_have_count(0)
                write_json(output / 'metrics.json', records)
                if args.extras:
                    extra_records.extend(extras(page, docs, output, viewport))
                    write_json(output / 'extra-metrics.json', extra_records)
                print(f'Viewport {width}: {len(records)} primary views complete', flush=True)
        finally:
            browser.close()
    write_json(output / 'browser-errors.json', errors)
    all_records = records + extra_records
    summary = {'views': len(records), 'extraViews': len(extra_records), 'actors': len(docs['actors']),
               'items': len(docs['items']), 'package': seed['package'], 'pageErrors': errors,
               'sub12Views': sum(bool(record['below12']) for record in all_records),
               'overflowViews': sum(bool(record['overflow']) for record in all_records),
               'crampedModifierViews': sum(bool(record['cramped']) for record in all_records)}
    if args.baseline:
        baseline = args.baseline.resolve()
        if baseline.is_dir():
            baseline /= 'metrics.json'
        before = json.loads(baseline.read_text(encoding='utf-8'))
        key = lambda row: (row['kind'], row['type'], row['variant'], row['tab'], row['viewport']['width'])
        previous = {key(row): row for row in before}
        changes = [{'key': list(key(row)), 'beforeHeight': previous[key(row)]['sheet']['height'],
                    'afterHeight': row['sheet']['height']} for row in records if key(row) in previous]
        write_json(output / 'baseline-comparison.json', changes)
        summary['comparedViews'] = len(changes)
    write_json(output / 'summary.json', summary)
    print(json.dumps(summary), flush=True)
    if args.strict:
        assert not errors, errors
        assert not summary['sub12Views'], 'Interface text below 12px; inspect metrics.json and extra-metrics.json'
        assert not summary['overflowViews'], 'Visible content overflow; inspect metrics.json and extra-metrics.json'
        assert not summary['crampedModifierViews'], 'Modifier amounts need at least 48px; inspect extra-metrics.json'
    return summary


def contacts(output: Path) -> None:
    from PIL import Image, ImageDraw
    paths = sorted(output.glob('*.png'))
    for offset in range(0, len(paths), 12):
        chunk = paths[offset:offset + 12]
        canvas = Image.new('RGB', (1440, 370 * ((len(chunk) + 3) // 4)), '#eff0f2')
        draw = ImageDraw.Draw(canvas)
        for index, path in enumerate(chunk):
            with Image.open(path) as image:
                thumbnail = image.convert('RGB')
            thumbnail.thumbnail((348, 335))
            x, y = index % 4 * 360, index // 4 * 370
            draw.text((x + 6, y + 4), path.stem, fill='black')
            canvas.paste(thumbnail, (x + 6, y + 25))
        canvas.save(output / f'contact-{offset // 12:03}.jpg')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-root')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--archive', type=Path, default=default_archive())
    parser.add_argument('--browser-executable', '--browser', type=Path)
    parser.add_argument('--port', type=int, default=0, help='Disposable localhost port; 0 chooses a free port.')
    parser.add_argument('--seed', type=Path, help='Reuse an explicitly started disposable review_server.py fixture.')
    parser.add_argument('--widths', nargs='+', type=int, default=[1500, 1024, 390])
    parser.add_argument('--strict', action='store_true')
    parser.add_argument('--extras', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--contacts', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--baseline', type=Path, help='Previous metrics.json or its directory for measured height comparisons.')
    parser.add_argument('--server', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--fixture', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not all(width >= 320 for width in args.widths):
        parser.error('--widths must be at least 320px')
    root = host_root(args.host_root)
    output = (args.output or root / 'test-results/swade-density' / secrets.token_hex(4)).resolve()
    if not args.server and output.exists() and any(output.iterdir()):
        raise RuntimeError(f'Use a new, empty --output directory: {output}')
    output.mkdir(parents=True, exist_ok=True)
    configure_storage(root, output)
    if args.server:
        serve(root, output, args.archive.resolve(), args.fixture.resolve(), args.port)
        return
    before_env = fingerprint(root / '.env')
    process = log = None
    try:
        if args.seed:
            seed = json.loads(args.seed.resolve().read_text(encoding='utf-8'))
        else:
            archive = args.archive.resolve()
            if not archive.is_file():
                raise RuntimeError(f'Build the SWADE ZIP before running the density review: {archive}')
            process, log, seed = start_server(root, output, archive, args.port)
        audit(output, seed, args)
        if args.contacts:
            contacts(output)
    finally:
        if process is not None:
            stop_server(process)
        if log is not None:
            log.close()
        assert fingerprint(root / '.env') == before_env, 'The host .env changed during the isolated review'


if __name__ == '__main__':
    main()
