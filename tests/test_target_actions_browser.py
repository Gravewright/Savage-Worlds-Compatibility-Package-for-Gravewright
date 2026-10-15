"""Target actions through actual SDK adapters, native modals and dice facts."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def main():
    source = Path(__file__).resolve().parents[1]
    override = os.environ.get('GRAVEWRIGHT_TEST_HOST_ROOT')
    candidates = [Path(override)] if override else source.parents
    host = next((path.resolve() for path in candidates if (path / 'manage.py').is_file() and (path / 'gravewright').is_dir()), None)
    if host is None:
        raise RuntimeError('Set GRAVEWRIGHT_TEST_HOST_ROOT to a Gravewright checkout containing manage.py and gravewright/.')
    sys.path.insert(0, str(host))
    from gravewright.dice.engine import evaluate
    modules = host / 'gravewright/modules/static/gravewright_modules'

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def translate_path(self, path):
            path = urlsplit(path).path
            if path == '/host/table-modal.js':
                return str(host / 'gravewright/table/static/gravewright_table/modal.js')
            if path == '/static/gravewright_web/escape.js':
                return str(host / 'gravewright/web/static/gravewright_web/escape.js')
            if path.startswith('/host/modules/'):
                target = (modules / path.removeprefix('/host/modules/')).resolve()
                if target.is_relative_to(modules.resolve()):
                    return str(target)
            return super().translate_path(path)

    def facts(expression, scenario):
        values = iter([0, 0] if scenario == 'critical' else [0.999, 0.375, 0.5] if scenario == 'raise' else [0.45, 0.5])
        return evaluate(expression, random_source=lambda: next(values, 0.4))

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(source)))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1280, 'height': 1000})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.expose_function('nativeDiceFacts', facts)
            page.goto(f'http://127.0.0.1:{server.server_port}/')
            page.add_style_tag(path=str(source / 'styles.css'))
            page.add_style_tag(content='.ownership-modal-overlay{position:fixed;inset:0;display:grid;place-items:center;background:#0008}')
            result = page.evaluate(r"""async () => {
              const {targetActions}=await import('/target-actions.js');
              const {actorActions}=await import('/actor-actions.js');
              const {createSheet,createItemSheet}=await import('/model.js');
              const {openModal,el}=await import('/ui.js');
              const {mountModal}=await import('/host/table-modal.js');
              const {createUiApi}=await import('/host/modules/modal-api.js');
              const {createDomainApi}=await import('/host/modules/domain-api.js');
              const words=await fetch('/locales/en.json').then(r=>r.json());
              const t=(key,params={})=>Object.entries(params).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',v),words[key]||key);
              const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
              const until=async(predicate,label)=>{for(let i=0;i<200;i++){if(predicate())return;await tick();}throw Error('Timeout '+label);};
              const find=(scope,key)=>[...scope.querySelectorAll('button')].find(button=>button.textContent===t(key));
              const click=async(scope,key)=>{const control=find(scope,key);if(!control)throw Error('Missing button '+key);control.click();await until(()=>control.getAttribute('aria-busy')!=='true',key);return control;};
              const field=(scope,key)=>scope.querySelector('[data-gws-target-option="'+key+'"]');
              let abort,documents,stats,actions,lastConfig,scenario,loseSave,holdRead;
              function skill(id,name,role='',attribute='smarts') {return {id,type:'skill',name,data:{...createItemSheet('skill'),die:8,modifier:0,attribute,role}};}
              async function setup(role='gm') {
                abort?.abort();await tick();abort=new AbortController();scenario='success';loseSave=false;holdRead=null;lastConfig=null;
                const source=createSheet();source.skills=[skill('source-a','User authored A'),skill('source-h','Arbitrary medic label','healing')];
                const recipient=createSheet();recipient.skills=[skill('target-s','User authored target trait')];recipient.resources.wounds=3;
                recipient.status.holding=true;recipient.status.incapacitated=true;recipient.status.bleedingOut=true;recipient.notes='Retain this note';
                documents=new Map([['source',{id:'source',name:'Source',canOpen:true,canEdit:true,version:1,sheetVersion:1,data:source}],
                  ['recipient',{id:'recipient',name:'Recipient',canOpen:true,canEdit:true,version:7,sheetVersion:11,data:recipient}],
                  ['read-only',{id:'read-only',name:'Readable ally',canOpen:true,canEdit:false,version:2,sheetVersion:2,data:createSheet()}],
                  ['token:independent',{id:'recipient',tokenId:'independent',name:'Independent ally',canOpen:true,canEdit:true,version:7,sheetVersion:31,data:structuredClone(recipient)}]]);
                stats={reads:[],payloads:[],saves:0,rolls:0,refreshes:0};const receipts=new Map();
                const links=new Set(),life={signal:abort.signal,check(){if(abort.signal.aborted)throw Error('stale_context');},link(fn){links.add(fn);return()=>links.delete(fn);}};
                const ui=createUiApi(life,{}, {mountModal,document});
                const call=async(domain,method,payload,options={})=>{
                  life.check();
                  if(domain==='actors'&&method==='state')return {actors:[...documents.values()].filter(view=>!view.tokenId).map(({data,...view})=>view)};
                  if(domain==='tokens'&&method==='state')return {tokens:[{id:'independent',actorId:'recipient',name:'Independent ally',linkMode:'snapshot',canControl:true,canOpenSheet:true},
                    {id:'linked',actorId:'recipient',name:'Linked alias',linkMode:'linked',canControl:true,canOpenSheet:true}]};
                  if(domain==='actors'&&method==='sheet') {
                    stats.reads.push(payload.tokenId?'token:'+payload.tokenId:payload.id);
                    if(holdRead)await holdRead.promise;
                    const view=documents.get(payload.tokenId?'token:'+payload.tokenId:payload.id);
                    if(!view?.canOpen)throw Object.assign(Error('Forbidden'),{code:'forbidden'});return structuredClone(view);
                  }
                  if(domain==='actors'&&method==='saveSheet') {
                    stats.payloads.push({payload:structuredClone(payload),requestId:options.requestId});
                    if(receipts.has(options.requestId))return structuredClone(receipts.get(options.requestId));
                    const key=payload.tokenId?'token:'+payload.tokenId:payload.actorId,view=documents.get(key);
                    if(!view?.canEdit)throw Object.assign(Error('Forbidden'),{code:'forbidden'});
                    if(view.version!==payload.version||view.sheetVersion!==payload.sheetVersion)throw Object.assign(Error('Stale'),{code:'conflict'});
                    if(role!=='gm'&&JSON.stringify(payload.data.effects)!==JSON.stringify(view.data.effects))throw Error('Native GM-only effects contract');
                    documents.set(key,{...view,data:structuredClone(payload.data),version:view.version+1,sheetVersion:view.sheetVersion+1});stats.saves++;
                    const saved={version:view.version+1,sheetVersion:view.sheetVersion+1};receipts.set(options.requestId,saved);
                    if(loseSave){loseSave=false;throw Object.assign(Error('Response lost after save'),{code:'network_error'});}return saved;
                  }
                  if(domain==='dice'&&method==='roll') {stats.rolls++;return {id:'roll-'+stats.rolls,roll:{result:await nativeDiceFacts(payload.expression,scenario)}};}
                  throw Error('Unexpected SDK operation '+domain+'.'+method);
                };
                const api=createDomainApi(call,{ui,i18n:{t}});
                const button=(text,run,disabled=false)=>{const node=el(document,'button','gws-button',text);node.type='button';node.disabled=disabled;
                  node.onclick=()=>{node.disabled=true;node.setAttribute('aria-busy','true');Promise.resolve().then(run).catch(()=>{}).finally(()=>{
                    node.removeAttribute('aria-busy');node.disabled=disabled||node.dataset.gwsActionLocked==='true'||node.dataset.gwsTemporarilyDisabled==='true';});};return node;};
                const context={actorId:'source',sceneId:'scene',role,systemId:'gravewright.savage-worlds'},getSheet=()=>documents.get('source').data;
                const env={doc:document,api,context,signal:abort.signal,t,button,modal:title=>openModal(api,document,title,abort.signal,t('common.close')),
                  canEdit:()=>true,getSheet,getName:()=>documents.get('source').name,flush:async()=>{},replaceSheet:async data=>{documents.get('source').data=data;},
                  onTargetSaved:async()=>{stats.refreshes++;}};
                const actor=actorActions(env);actions=targetActions({...env,trait:(data,config)=>{lastConfig=config;return actor.trait(data,config);}});
              }
              async function picker(kind) {const modal=actions[kind]();await until(()=>modal.querySelector('[data-gws-target-key]'),'target list');return modal;}
              async function select(modal,key='actor:recipient') {const row=modal.querySelector('[data-gws-target-key="'+key+'"]');if(!row)throw Error('Missing target '+key);await click(row,'target.select');}
              async function traitModal() {await until(()=>document.querySelector('.gws-modal:not([data-gws-target-action])'),'trait modal');return document.querySelector('.gws-modal');}
              async function rollApply(modal) {await click(modal,'rules.roll');await click(modal,'rules.apply');}
              await setup();let modal=await picker('support');
              if(stats.reads.length)throw Error('Target sheets loaded eagerly');
              await select(modal);const targetTrait=field(modal,'targetTrait');
              if(![...targetTrait.options].some(option=>option.value==='skill.target-s'))throw Error('Target skill missing');
              if(stats.reads.join()!=='recipient')throw Error('Selecting target fetched unrelated sheets');
              targetTrait.value='skill.target-s';await click(modal,'target.startRoll');modal=await traitModal();
              if(lastConfig.options.some(([key])=>key.startsWith('attribute.')))throw Error('Support source offers attributes');
              await click(modal,'rules.roll');loseSave=true;await click(modal,'rules.apply');await click(modal,'rules.apply');
              let recipient=documents.get('recipient');
              if(stats.saves!==1||recipient.data.effects.length!==1||stats.refreshes!==1)throw Error('Support retry duplicated effect');
              if(JSON.stringify(stats.payloads[0])!==JSON.stringify(stats.payloads[1]))throw Error('Support retry changed receipt or payload');
              if(recipient.data.effects[0].data.modifiers[0].target!=='skill.target-s'||recipient.data.effects[0].data.remaining!==1)throw Error('Wrong support target or clock');
              await modal.close();
              await setup();modal=await picker('test');field(modal,'testState').value='vulnerable';await select(modal);modal=await traitModal();
              if(lastConfig.options.some(([key])=>key.startsWith('attribute.'))||!modal.querySelector('[data-gws-rule=opposed]').checked)throw Error('Test allows attributes or is not opposed');
              scenario='raise';await rollApply(modal);recipient=documents.get('recipient');
              if(!recipient.data.status.vulnerable||!recipient.data.status.shaken||recipient.data.status.holding||recipient.data.resources.wounds!==3)throw Error('Test state/wounds incorrect');
              if(!recipient.data.statusClocks.vulnerable.awaitingStart)throw Error('Test duration not next turn');await modal.close();
              await setup();modal=await picker('heal');await select(modal);
              if(lastConfig||modal.querySelector('[role=alert]').hidden)throw Error('Healing skipped golden hour confirmation');
              field(modal,'goldenHourConfirm').checked=true;await select(modal);
              if(lastConfig)throw Error('Healing skipped attempted wounds confirmation');
              field(modal,'healingAttemptConfirm').checked=true;field(modal,'kitAvailable').checked=true;await select(modal);modal=await traitModal();
              if(lastConfig.selected!=='skill.source-h'||lastConfig.options.some(([key])=>key==='skill.source-a'))throw Error('Healing relies on name or allows unrelated role');
              scenario='raise';await rollApply(modal);recipient=documents.get('recipient');
              if(recipient.data.resources.wounds!==1||recipient.data.status.incapacitated||recipient.data.notes!=='Retain this note')throw Error('Healing did not remove two wounds safely');await modal.close();
              await setup();modal=await picker('stabilize');field(modal,'kitAvailable').checked=true;await select(modal,'token:independent');modal=await traitModal();await rollApply(modal);
              const independent=documents.get('token:independent');
              if(independent.data.status.bleedingOut||independent.data.resources.wounds!==3||documents.get('recipient').data.status.bleedingOut!==true)throw Error('Independent stabilization mutated wrong sheet');
              if(stats.payloads[0].payload.tokenId!=='independent'||stats.payloads[0].payload.sheetVersion!==31)throw Error('Independent revision lost');await modal.close();
              await setup('player');modal=await picker('support');await select(modal,'actor:read-only');await click(modal,'target.startRoll');modal=await traitModal();
              if(lastConfig.applyResult!==undefined)throw Error('Player support can apply a GM-only effect');await click(modal,'rules.roll');
              if(!find(modal,'rules.apply').hidden||stats.saves)throw Error('Player support wrote target');await modal.close();
              await setup('player');documents.get('recipient').data.effects=[{id:'legacy-effect',custom:'Keep exact native data'}];
              modal=await picker('heal');if(modal.querySelector('[data-gws-target-key="actor:read-only"]'))throw Error('Player healing offers readonly target');
              for(const key of ['goldenHourConfirm','healingAttemptConfirm','kitAvailable'])field(modal,key).checked=true;
              await select(modal);modal=await traitModal();await rollApply(modal);
              if(stats.saves!==1||documents.get('recipient').data.effects[0].custom!=='Keep exact native data')throw Error('Healing rewrote GM effects');await modal.close();
              await setup('player');modal=await picker('test');documents.get('recipient').canEdit=false;await select(modal);
              if(lastConfig||stats.saves||modal.querySelector('[role=alert]').hidden)throw Error('Revoked target permissions bypassed');await modal.close();
              await setup();modal=await picker('test');let release;holdRead={promise:new Promise(resolve=>release=resolve)};
              const row=modal.querySelector('[data-gws-target-key="actor:recipient"]');find(row,'target.select').click();await until(()=>stats.reads.length===1,'pending target read');
              window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();if(!modal.isConnected)throw Error('Escape skipped pending authorized read');
              release();await until(()=>!modal.isConnected,'cancelled target picker');await tick();if(lastConfig||document.querySelector('.gws-modal'))throw Error('Cancelled picker opened a delayed roll');
              abort.abort();if(document.querySelector('dialog'))throw Error('Browser dialog created');
              return {nativeSDK:true,nativeDice:true,targetSkills:true,supportReceiptRetry:true,testsSkillsOnly:true,healingConfirmations:true,
                healingRole:true,independentTokens:true,playerSupportRollOnly:true,playerPermissionGuard:true,legacyEffectsPreserved:true,pendingEscape:true,noDialog:true};
            }""")
            print(result)
            assert not errors, errors
            print({'pageErrors': errors})
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
