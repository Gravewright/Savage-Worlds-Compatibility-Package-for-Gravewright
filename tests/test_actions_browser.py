"""Exercise actor actions with real SDK modals and deterministic native dice facts."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def find_host_root(source):
    override = os.environ.get('GRAVEWRIGHT_TEST_HOST_ROOT')
    candidates = [Path(override)] if override else source.parents
    for candidate in candidates:
        root = candidate.resolve()
        if (root / 'manage.py').is_file() and (root / 'gravewright').is_dir():
            return root
    raise RuntimeError('Set GRAVEWRIGHT_TEST_HOST_ROOT to a Gravewright checkout containing manage.py and gravewright/.')


def main():
    source = Path(__file__).resolve().parents[1]
    host = find_host_root(source)
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
        values = iter([0, 0] if scenario == 'critical' else [0.3, 0.3] if scenario == 'failure' else [0.6, 0.6])
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
              const {mountActorSheet}=await import('/sheet.js');
              const {createSheet,createItemSheet}=await import('/model.js');
              const {mountModal}=await import('/host/table-modal.js');
              const {createUiApi}=await import('/host/modules/modal-api.js');
              const {createDomainApi}=await import('/host/modules/domain-api.js');
              const locales=Object.fromEntries(await Promise.all(['en','pt-BR','es'].map(async locale=>[locale,await fetch('/locales/'+locale+'.json').then(r=>r.json())])));
              let language='en';const languageListeners=new Set();
              const t=(key,params={})=>Object.entries(params).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',v),locales[language][key]||key);
              const changeLanguage=locale=>{language=locale;for(const callback of languageListeners)callback();};
              const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
              const until=async(predicate,label)=>{for(let i=0;i<200;i++){if(predicate())return;await tick();}throw Error('Timeout '+label);};
              const find=(scope,key)=>[...scope.querySelectorAll('button')].find(button=>button.textContent===t(key));
              const click=async(scope,key)=>{const button=find(scope,key);if(!button)throw Error('No button '+key);button.click();await until(()=>!button.isConnected||button.getAttribute('aria-busy')!=='true',key);return button;};
              let abort,wrapper,view,stats,scenario,failRoll,failSave,loseSave,holdRoll,mounted,settings;
              const receipts=new Map(),saveReceipts=new Map();
              async function setup({shaken=false,power=false,healing=false,device=false,canEdit=true,tableSettings={},ruleOverrides,points=10,currency='',woundCapacity,arcanePools=[],skillRows,encumbered=false,restrained=false}={}){
                abort?.abort();wrapper?.remove();await tick();
                abort=new AbortController();const data=createSheet();data.status.shaken=shaken;data.resources.bennies=3;
                if(power || healing || device)data.skills=[{id:'owned-skill',type:'skill',name:'User authored skill',data:{...createItemSheet('skill'),die:healing?12:8,modifier:0,attribute:'smarts',role:healing?'healing':'arcane'}}];
                if(skillRows)data.skills=structuredClone(skillRows);data.load.encumbered=encumbered;data.status.entangled=restrained;
                if(power || device){data.resources.powerPoints=points;data.resources.powerPointsMax=10;data.powers=[{id:'owned-power',sourceId:'library-power',type:'power',name:'User authored power',data:{...createItemSheet('power'),powerPoints:2,durationRounds:3,skillId:device?'':'owned-skill'}}];}
                data.resources.currency=currency;data.arcanePools=structuredClone(arcanePools);
                if(ruleOverrides!==undefined)data.rules=structuredClone(ruleOverrides);
                if(woundCapacity!==undefined)data.profile.woundCapacity=woundCapacity;
                if(device)data.inventory=[{id:'owned-device',type:'arcane-device',name:'User authored device',data:{...createItemSheet('arcane-device'),powerPoints:0,powerPointsMax:10,allocatedPowerPoints:0}}];
                if(healing)data.resources.wounds=3;
                view={id:'actor',name:'A'.repeat(120),actorType:'character',type:'character',canEdit,version:1,sheetVersion:1,data};
                stats={rollCalls:0,published:0,saves:0,successfulSaves:0,requestIds:[],saveIds:[],rollExpressions:[],reads:0,payloads:[]};receipts.clear();saveReceipts.clear();scenario='success';failRoll=false;failSave=false;loseSave=false;holdRoll=null;
                const linked=new Set(),life={signal:abort.signal,check(){if(abort.signal.aborted)throw Error('stale_context');},link(fn){linked.add(fn);return()=>linked.delete(fn);}};
                const ui=createUiApi(life,{}, {mountModal,document});
                const call=async(domain,method,payload,options={})=>{
                  life.check();
                  if(domain==='actors'&&method==='sheet'){stats.reads++;return structuredClone(view);}
                  if(domain==='actors'&&method==='state')return {actors:[{id:view.id,name:view.name,canOpen:true,canEdit:view.canEdit,version:view.version,sheetVersion:view.sheetVersion}]};
                  if(domain==='actors'&&method==='saveSheet'){
                    stats.saves++;stats.payloads.push(structuredClone(payload));stats.saveIds.push(options.requestId);
                    if(!options.requestId)throw Error('Actor autosave omitted native receipt');
                    if(saveReceipts.has(options.requestId))return structuredClone(saveReceipts.get(options.requestId));
                    if(failSave){failSave=false;throw Object.assign(Error('Offline'),{code:'network_error'});}
                    if(payload.version!==view.version||payload.sheetVersion!==view.sheetVersion)throw Object.assign(Error('Stale'),{code:'conflict'});
                    view={...view,name:payload.name,data:structuredClone(payload.data),version:view.version+1,sheetVersion:view.sheetVersion+1};stats.successfulSaves++;
                    const saved={version:view.version,sheetVersion:view.sheetVersion};saveReceipts.set(options.requestId,saved);
                    if(loseSave){loseSave=false;throw Object.assign(Error('Response lost after commit'),{code:'network_error'});}return saved;
                  }
                  if(domain==='dice'&&method==='roll'){
                    stats.rollCalls++;stats.requestIds.push(options.requestId);stats.rollExpressions.push(payload.expression);
                    if(payload.label.length>48)throw Error('Native label limit exceeded');
                    if(holdRoll)await holdRoll.promise;
                    let message=receipts.get(options.requestId);
                    if(!message){message={id:'message-'+(++stats.published),roll:{result:await nativeDiceFacts(payload.expression,scenario)}};receipts.set(options.requestId,message);}
                    if(failRoll){failRoll=false;throw Object.assign(Error('Response lost after publication'),{code:'network_error'});}
                    return structuredClone(message);
                  }
                  if(domain==='items'&&method==='state')return {items:[]};
                  throw Error('Unexpected SDK operation '+domain+'.'+method);
                };
                const api=createDomainApi(call,{ui,events:{on:()=>()=>{}},i18n:{t,get locale(){return language;}}});
                wrapper=document.createElement('section');wrapper.className='gw-window';const root=document.createElement('div');wrapper.append(root);document.body.append(wrapper);
                const listeners=new Set();settings={current:{schemaVersion:1,currency:{enabled:true,label:''},rules:{noPowerPoints:false,woundCap:false},...structuredClone(tableSettings)},listeners,
                  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},update(value){settings.current=structuredClone(value);for(const fn of listeners)fn(settings.current);}};
                mounted=await mountActorSheet({root,context:{actorId:'actor',actorType:'character',role:'gm',systemId:'gravewright.savage-worlds',tableId:'table'},api,signal:abort.signal},{listeners:new Set(),settings,
                  subscribeLanguage(callback){languageListeners.add(callback);return()=>languageListeners.delete(callback);}});
                return root;
              }
              async function openCast(root){
                await click(root,'sheet.powers');const row=root.querySelector('[data-entry-id=owned-power]');
                const control=[...row.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===t('rules.roll'));
                if(!control)throw Error('Missing native power activation action');control.click();await until(()=>document.querySelector('.gws-modal'),'power modal');return document.querySelector('.gws-modal');
              }
              async function openAction(root,key){
                await click(root.querySelector('.gws-actionbar'),'common.actions');
                const menu=document.querySelector('.gws-modal');
                if(!menu)throw Error('Actions did not open a native modal');
                await click(menu,key);
                if(key!=='rules.fatigueGain')await until(()=>document.querySelector('.gws-modal')&&document.querySelector('.gws-modal')!==menu,'open '+key);
                return document.querySelector('.gws-modal');
              }
              let root=await setup({woundCapacity:5});
              const authoredSkills=['Zebra','Ñandú','Nube','Águia 10','Águia 2','Nandú'].map((name,index)=>({id:'skill-'+index,type:'skill',name,data:{...createItemSheet('skill'),die:8,modifier:1,attribute:'smarts'}}));
              root=await setup({skillRows:authoredSkills,encumbered:true});
              const visibleSkills=()=>[...root.querySelectorAll('.gws-table-skills tbody [data-entry-id]')].map(row=>row.querySelector('.gws-link').textContent);
              if(visibleSkills().join('|')!=='Águia 2|Águia 10|Ñandú|Nandú|Nube|Zebra'||stats.saves)throw Error('Skill display is not alphabetical or sorting saved actor data');
              for(const locale of ['en','pt-BR']){changeLanguage(locale);for(const width of [390,320]){
                wrapper.style.width=width+'px';await tick();const skillsTable=root.querySelector('.gws-table-skills'),tableBox=skillsTable.getBoundingClientRect();
                if(skillsTable.scrollWidth>skillsTable.clientWidth+1)throw Error('Narrow skill list requires horizontal scrolling at '+width);
                for(const row of skillsTable.querySelectorAll('[data-entry-id]')){if(row.querySelector('.gws-entry-actions').getBoundingClientRect().height>40)throw Error('Narrow skill row stacks its three actions vertically');for(const control of row.querySelectorAll('input,select,button')){
                  const box=control.getBoundingClientRect();if(box.width<1||box.left<tableBox.left-1||box.right>tableBox.right+1)throw Error('Narrow skill control is clipped at '+width+': '+control.getAttribute('aria-label'));
                }}
                if([...skillsTable.querySelectorAll('.gws-skill-field-label')].some(label=>!label.getClientRects().length||label.scrollWidth>label.clientWidth+1))throw Error('Narrow skill list has unlabeled or clipped fields at '+width+' in '+locale);
              }}wrapper.style.width='';changeLanguage('en');
              const linkedAttribute=root.querySelector('[data-gws-skill-attribute="skill-0"]');linkedAttribute.value='agility';linkedAttribute.focus();linkedAttribute.dispatchEvent(new Event('change',{bubbles:true}));await mounted.flush();
              if(view.data.skills.map(row=>row.name).join('|')!==authoredSkills.map(row=>row.name).join('|')||view.data.skills[0].data.attribute!=='agility'||view.data.skills[0].data.die!==8||view.data.skills[0].data.modifier!==1||document.activeElement!==linkedAttribute)throw Error('Linked attribute edit changed the die, modifier, stored order or keyboard focus');
              const sortSaveCount=stats.saves;changeLanguage('es');
              if(visibleSkills().join('|')!=='Águia 2|Águia 10|Nandú|Nube|Ñandú|Zebra'||stats.saves!==sortSaveCount||document.activeElement!==linkedAttribute||linkedAttribute.value!=='agility'||linkedAttribute.options[1].textContent!==t('attribute.agility'))throw Error('Locale sorting lost focus/linked attribute or wrote actor data');
              const skillRow=root.querySelector('[data-entry-id="skill-0"]');skillRow.querySelector('[aria-label="'+t('rules.roll')+'"]').click();await until(()=>document.querySelector('.gws-rule-modal'),'linked skill roll');
              let skillModal=document.querySelector('.gws-rule-modal');find(skillModal,'rules.roll').focus();await click(skillModal,'rules.roll');
              if(document.activeElement!==find(skillModal,'rules.rerollBenny'))throw Error('Completed skill roll did not move focus from hidden Roll to its enabled reroll action');
              if(!stats.rollExpressions[0].includes('d8')||!stats.rollExpressions[0].endsWith('-1')||view.data.skills[0].data.die!==8)throw Error('Skill roll used its stale attribute or replaced its independent skill die');await skillModal.close();
              const relinkedAttribute=root.querySelector('[data-gws-skill-attribute="skill-0"]');relinkedAttribute.value='smarts';relinkedAttribute.dispatchEvent(new Event('change',{bubbles:true}));await mounted.flush();
              root.querySelector('[data-entry-id="skill-0"] [aria-label="'+t('rules.roll')+'"]').click();await until(()=>document.querySelector('.gws-rule-modal'),'relinked skill roll');skillModal=document.querySelector('.gws-rule-modal');await click(skillModal,'rules.roll');
              if(!stats.rollExpressions.at(-1).endsWith('+1'))throw Error('Changing linked attribute did not remove the existing Agility encumbrance penalty');await skillModal.close();changeLanguage('en');
              root=await setup({skillRows:authoredSkills,canEdit:false});
              if([...root.querySelectorAll('[data-gws-skill-attribute]')].some(control=>!control.disabled))throw Error('Read-only sheet exposes an editable skill attribute selector');
              const athleticsSkills=authoredSkills.map(row=>({...row,data:{...row.data,role:'athletics'}}));
              root=await setup({skillRows:athleticsSkills,restrained:true});await click(root,'rules.escape');
              const escapeModal=document.querySelector('.gws-rule-modal'),escapeTrait=escapeModal.querySelector('[data-gws-rule=trait]');
              if(escapeTrait.options[0].value!=='strength'||escapeTrait.options[0].hasAttribute('data-gws-sort-name'))throw Error('Escape attribute is mixed into the skill ordering');
              escapeTrait.value='skill-2';escapeTrait.focus();const escapeSaves=stats.saves;changeLanguage('es');
              if(escapeTrait.options[0].value!=='strength'||escapeTrait.options[0].textContent!==t('attribute.strength')||[...escapeTrait.options].slice(1).map(option=>option.textContent).join('|')!=='Águia 2|Águia 10|Nandú|Nube|Ñandú|Zebra'||escapeTrait.value!=='skill-2'||document.activeElement!==escapeTrait||stats.saves!==escapeSaves)throw Error('Translated Escape did not keep Strength fixed and alphabetize only skills while preserving focus');
              await click(escapeModal,'rules.roll');if(!stats.rollExpressions[0].includes('d8')||!stats.rollExpressions[0].endsWith('+1'))throw Error('Translated Escape rolled another trait after sorting');await escapeModal.close();changeLanguage('en');
              root=await setup({woundCapacity:5});
              const pips=key=>[...root.querySelectorAll('[data-resource='+key+'] .gws-pip')];
              if(root.querySelector('.gws-brand')||!root.querySelector('.gws-name input'))throw Error('Actor identity still includes the system brand or lacks its editable name');
              if(pips('wounds').map(control=>control.textContent).join()!=='−1,−2,−3,−3,−3'||pips('fatigue').map(control=>control.textContent).join()!=='−1,−2')throw Error('Resource controls do not show their penalty levels');
              if(pips('wounds').some((control,index)=>control.getAttribute('aria-label')!==t('resource.wounds')+' '+(index+1)||control.getAttribute('aria-pressed')!=='false'))throw Error('Wound controls lost their actual level or initial state');
              pips('wounds')[3].click();await mounted.flush();
              if(view.data.resources.wounds!==4||pips('wounds').filter(control=>control.getAttribute('aria-pressed')==='true').length!==4||pips('wounds')[3].textContent!=='−3')throw Error('Capped wound penalty label changed the selected wound level');
              pips('wounds')[3].click();await mounted.flush();
              if(view.data.resources.wounds!==3||pips('wounds').filter(control=>control.getAttribute('aria-pressed')==='true').length!==3)throw Error('Clicking the active wound level did not remove its last wound');
              pips('fatigue')[1].click();await mounted.flush();
              if(view.data.resources.fatigue!==2||pips('fatigue').filter(control=>control.getAttribute('aria-pressed')==='true').length!==2)throw Error('Fatigue penalty control did not persist level two');
              pips('fatigue')[1].click();await mounted.flush();
              if(view.data.resources.fatigue!==1||pips('fatigue').filter(control=>control.getAttribute('aria-pressed')==='true').length!==1)throw Error('Clicking active fatigue did not remove its last level');
              root=await setup({device:true});
              const toolbar=root.querySelector('.gws-actionbar'),toolbarButtons=[...toolbar.querySelectorAll('button')];
              const toolbarKeys=['rules.traitRoll','rules.receiveDamage','common.actions'];
              if(toolbarButtons.length!==3||toolbarButtons.some((button,index)=>button.textContent!==t(toolbarKeys[index])))throw Error('Toolbar does not prioritize trait, damage and the secondary actions entry');
              if(toolbarButtons[2].getAttribute('aria-haspopup')!=='dialog')throw Error('Actions does not announce its native modal');
              const traitStyle=getComputedStyle(toolbarButtons[0]),damageStyle=getComputedStyle(toolbarButtons[1]),menuStyle=getComputedStyle(toolbarButtons[2]);
              if(traitStyle.backgroundColor===menuStyle.backgroundColor||damageStyle.color===menuStyle.color)throw Error('Toolbar actions have no visible primary or damage distinction');
              toolbarButtons[2].focus();await click(toolbar,'common.actions');
              let menu=document.querySelector('.gws-modal');
              const menuKeys=['rules.runningRoll','rules.rest','rules.fatigueGain','target.support','target.test','target.heal','target.stabilize','rules.recover.natural','rules.deviceAdjustments'];
              if(menuKeys.some(key=>!find(menu,key)||find(menu,key).disabled))throw Error('An existing action is missing or inaccessible in the secondary actions modal');
              const actionSaveCount=stats.saves;
              changeLanguage('pt-BR');
              if(menu.querySelector('h2').textContent!==t('common.actions')||toolbarButtons.some((button,index)=>button.textContent!==t(toolbarKeys[index]))||menuKeys.some(key=>!find(menu,key))||stats.saves!==actionSaveCount)throw Error('Open action menu did not translate without changing actor data');
              window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
              await until(()=>!menu.isConnected,'actions Escape close');
              if(document.activeElement!==find(root.querySelector('.gws-actionbar'),'common.actions'))throw Error('Closing actions did not return keyboard focus to its entry: '+document.activeElement?.outerHTML);
              changeLanguage('en');
              for(const [key,target]of [['target.support','support'],['target.test','test'],['target.heal','heal'],['target.stabilize','stabilize']]){
                const opened=await openAction(root,key);
                await until(()=>document.querySelector('[data-gws-target-action="'+target+'"]'),'secondary '+target);
                if(document.querySelectorAll('.gws-modal').length!==1||opened?.dataset.gwsTargetAction!==target)throw Error('Secondary target action retained its actions modal');
                await opened.close();await until(()=>!opened.isConnected,'close secondary '+target);
                if(document.activeElement!==find(root.querySelector('.gws-actionbar'),'common.actions'))throw Error('Closing secondary '+target+' did not return focus to Actions');
              }
              for(const key of ['rules.runningRoll','rules.rest','rules.recover.natural','rules.deviceAdjustments']){
                const opened=await openAction(root,key);
                if(!opened||document.querySelectorAll('.gws-modal').length!==1||opened.querySelector('h2').textContent!==t(key))throw Error('Secondary action did not replace the actions modal: '+key);
                await opened.close();await until(()=>!opened.isConnected,'close '+key);
                if(document.activeElement!==find(root.querySelector('.gws-actionbar'),'common.actions'))throw Error('Closing secondary '+key+' did not return focus to Actions');
              }
              if(stats.saves||stats.rollCalls)throw Error('Opening secondary actions performed a rule action');
              await openAction(root,'rules.fatigueGain');
              await until(()=>view.data.resources.fatigue===1,'fatigue from secondary actions');
              if(stats.successfulSaves!==1||document.querySelector('.gws-modal'))throw Error('Secondary fatigue action did not close and persist exactly once');
              root=await setup({canEdit:false});
              const readOnlyActions=[...root.querySelectorAll('.gws-actionbar button')];
              if(readOnlyActions.length!==3||readOnlyActions.some(control=>!control.disabled))throw Error('Read-only actors expose an enabled toolbar action');
              for(const control of readOnlyActions)control.click();
              for(const control of [...pips('wounds'),...pips('fatigue')]){if(!control.disabled)throw Error('Read-only actor exposes enabled resource controls');control.click();}
              root.querySelector('[data-attribute=agility] .gws-die').click();await tick();
              if(document.querySelector('.gws-modal')||stats.saves||stats.rollCalls||view.data.resources.fatigue)throw Error('Read-only toolbar changed actor data or opened an action');
              root=await setup();
              root.querySelector('[data-attribute=agility] .gws-die').click();await until(()=>document.querySelector('.gws-rule-grid'),'trait modal');
              let modal=document.querySelector('.gws-modal');failRoll=true;await click(modal,'rules.roll');
              if(modal.querySelector('.gws-rule-result').textContent)throw Error('Failed transport reported a completed roll');
              await click(modal,'rules.roll');if(stats.published!==1||stats.rollCalls!==2||new Set(stats.requestIds).size!==1)throw Error('Retry published another roll');
              await modal.close();await tick();
              root=await setup();scenario='critical';root.querySelector('[data-attribute=agility] .gws-die').click();await until(()=>document.querySelector('.gws-rule-grid'),'critical modal');
              modal=document.querySelector('.gws-modal');find(modal,'rules.roll').focus();await click(modal,'rules.roll');
              if(!find(modal,'rules.rerollBenny').disabled||view.data.resources.bennies!==3)throw Error('Critical failure reroll is enabled');
              if(document.activeElement!==find(modal,'common.done'))throw Error('Critical result did not focus Done when reroll is unavailable');
              await modal.close();await tick();
              root=await setup();root.querySelector('[data-attribute=agility] .gws-die').click();await until(()=>document.querySelector('.gws-rule-grid'),'pending modal');
              modal=document.querySelector('.gws-modal');let release;holdRoll={promise:new Promise(resolve=>release=resolve)};
              find(modal,'rules.roll').click();await until(()=>stats.rollCalls===1,'pending native roll');
              window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();if(!modal.isConnected)throw Error('Escape closed before pending roll completed');
              release();await until(()=>!modal.isConnected,'pending close');
              root=await setup({shaken:true});await click(root,'rules.receiveDamage');modal=document.querySelector('.gws-modal');
              modal.querySelector('[data-gws-rule=damage]').value='8';failSave=true;await click(modal,'rules.soakBenny');
              if(stats.published!==0)throw Error('Soak rolled before its Benny was persisted');
              await click(modal,'rules.soakBenny');if(view.data.resources.bennies!==2||stats.published!==1)throw Error('Retry charged or rolled soak twice');
              failSave=true;await click(modal,'rules.applyDamage');await click(modal,'rules.applyDamage');
              if(view.data.status.shaken||view.data.resources.wounds!==0||view.data.resources.bennies!==2)throw Error('Soak apply/retry corrupted state');
              if(!find(modal,'rules.applyDamage').disabled||!find(modal,'rules.soakBenny').disabled)throw Error('Applied damage actions remain enabled');
              await modal.close();
              root=await setup({power:true});modal=await openCast(root);await click(modal,'rules.roll');
              if(view.data.resources.powerPoints!==10||stats.successfulSaves)throw Error('Power points spent before Apply');
              failSave=true;await click(modal,'rules.rerollBenny');
              if(stats.published!==1||view.data.resources.bennies!==3||view.data.resources.powerPoints!==10)throw Error('Power reroll occurred before persisted Benny');
              await click(modal,'rules.rerollBenny');
              if(stats.published!==2||view.data.resources.bennies!==2||view.data.resources.powerPoints!==10)throw Error('Power reroll retry spent twice or spent PP');
              failSave=true;await click(modal,'rules.apply');
              if(!find(modal,'rules.rerollBenny').disabled)throw Error('Power activation snapshot permits another reroll');
              await click(modal,'rules.apply');
              if(view.data.resources.bennies!==2||view.data.resources.powerPoints!==8||view.data.activePowers.length!==1||!find(modal,'rules.apply').disabled)throw Error('Power apply/retry corrupted resources or duplicated active entry');
              await modal.close();
              root=await setup({power:true});modal=await openCast(root);modal.querySelector('[data-gws-rule=shorting]').value='1';scenario='failure';await click(modal,'rules.roll');
              if(!find(modal,'rules.rerollBenny').disabled||view.data.resources.bennies!==3||view.data.resources.powerPoints!==10||view.data.resources.fatigue!==0)throw Error('Shorting failure permits reroll or mutates before Apply');
              await click(modal,'rules.apply');
              if(view.data.resources.powerPoints!==9||view.data.resources.fatigue!==1||view.data.resources.bennies!==3)throw Error('Shorting failure did not apply exact critical activation cost');
              await modal.close();
              root=await setup({healing:true});await click(root,'common.actions');modal=document.querySelector('.gws-modal');await click(modal,'target.heal');
              await until(()=>document.querySelector('[data-gws-target-action=heal] [data-gws-target-key]'),'own healing picker');modal=document.querySelector('[data-gws-target-action=heal]');
              for(const key of ['goldenHourConfirm','healingAttemptConfirm','kitAvailable'])modal.querySelector('[data-gws-target-option='+key+']').checked=true;
              await click(modal.querySelector('[data-gws-target-key="actor:actor"]'),'target.select');
              await until(()=>document.querySelector('.gws-modal:not([data-gws-target-action])'),'own healing roll');modal=document.querySelector('.gws-modal');
              await click(modal,'rules.roll');await click(modal,'rules.apply');
              if(view.data.resources.wounds!==2||root.querySelectorAll('[data-resource=wounds] [aria-pressed=true]').length!==2||stats.successfulSaves!==1)throw Error('Targeting own actor did not hydrate the displayed sheet without another save: '+JSON.stringify({wounds:view.data.resources.wounds,pips:root.querySelectorAll('[data-resource=wounds] [aria-pressed=true]').length,saves:stats.successfulSaves,result:modal.querySelector('.gws-rule-result')?.textContent,error:modal.querySelector('.gws-notice:not([hidden])')?.textContent}));
              await modal.close();const concept=root.querySelector('[data-gws-path="identity.concept"]');concept.value='After directed healing';concept.dispatchEvent(new Event('input',{bubbles:true}));
              await click(root,'sheet.notes');
              if(view.data.resources.wounds!==2||view.data.identity.concept!=='After directed healing'||stats.successfulSaves!==2||stats.payloads.at(-1).version!==2)throw Error('Own target rehydration retained a stale revision or restored old wounds');
              root=await setup({device:true});await click(root,'common.actions');modal=document.querySelector('.gws-modal');await click(modal,'rules.deviceAdjustments');
              await until(()=>document.querySelector('[data-gws-rule=physicalContact]'),'device transfer modal');modal=document.querySelector('.gws-modal');
              modal.querySelector('[data-gws-rule=transferAmount]').value='2';await click(modal,'rules.transferToDevice');
              if(stats.saves||view.data.resources.powerPoints!==10||modal.querySelector('.gws-notice:not([hidden])')?.textContent!==t('rules.physicalContactRequired'))throw Error('Device transfer bypassed physical contact');
              modal.querySelector('[data-gws-rule=physicalContact]').checked=true;loseSave=true;await click(modal,'rules.transferToDevice');await click(modal,'rules.transferToDevice');
              let ownedDevice=view.data.inventory[0];
              if(view.data.resources.powerPoints!==8||ownedDevice.data.powerPoints!==2||ownedDevice.data.allocatedPowerPoints!==2)throw Error('Device save-response retry repeated transfer');
              if(stats.saveIds[0]!==stats.saveIds[1]||JSON.stringify(stats.payloads[0])!==JSON.stringify(stats.payloads[1]))throw Error('Device retry changed committed receipt or snapshot');
              if(!find(modal,'rules.transferToDevice').disabled||!find(modal,'rules.transferFromDevice').disabled||!modal.querySelector('[data-gws-rule=transferAmount]').disabled)throw Error('Completed device transfer remains editable');
              await modal.close();await click(root,'sheet.equipment');
              const deviceRow=root.querySelector('[data-entry-id=owned-device]'),edit=[...deviceRow.querySelectorAll('button')].find(control=>control.getAttribute('aria-label')===t('common.edit'));edit.click();
              await until(()=>document.querySelector('.gws-item-editor'),'owned device editor');modal=document.querySelector('.gws-modal');await click(modal,'item.details');
              const bind=modal.querySelector('.gws-device-powers input[type=checkbox]'),deviceSkill=modal.querySelector('.gws-item-rules select[data-gws-item-field=skillId]');
              if(!bind||!deviceSkill||![...deviceSkill.options].some(option=>option.value==='owned-skill'))throw Error('Owned device lacks actual power/skill bindings');
              bind.checked=true;bind.dispatchEvent(new Event('change',{bubbles:true}));deviceSkill.value='owned-skill';deviceSkill.dispatchEvent(new Event('change',{bubbles:true}));await modal.close();
              ownedDevice=view.data.inventory[0];
              if(ownedDevice.data.powerIds.join()!=='owned-power'||ownedDevice.data.skillId!=='owned-skill')throw Error('Device bindings used source IDs or failed persistence');
              modal=await openCast(root);const devicePool=modal.querySelector('[data-gws-rule=pool]');
              if(![...devicePool.options].some(option=>option.value==='device:owned-device'))throw Error('Bound device not available to its owned power');devicePool.value='device:owned-device';
              await click(modal,'rules.roll');await click(modal,'rules.apply');
              if(!stats.rollExpressions.at(-1).includes('d8')||view.data.resources.powerPoints!==8||view.data.inventory[0].data.powerPoints!==0||view.data.activePowers.at(-1).poolId!=='device:owned-device')throw Error('Owned device binding did not resolve activation skill or its separate PP');await modal.close();
              root=await setup();let draftConcept=root.querySelector('[data-gws-path="identity.concept"]');draftConcept.value='First committed snapshot';draftConcept.dispatchEvent(new Event('input',{bubbles:true}));
              loseSave=true;await mounted.flush().catch(()=>{});
              if(view.data.identity.concept!=='First committed snapshot'||stats.successfulSaves!==1)throw Error('Lost-response fixture did not commit its initial save');
              draftConcept=root.querySelector('[data-gws-path="identity.concept"]');draftConcept.value='New local edit after lost response';draftConcept.dispatchEvent(new Event('input',{bubbles:true}));await mounted.flush();
              if(stats.saveIds[0]!==stats.saveIds[1]||JSON.stringify(stats.payloads[0])!==JSON.stringify(stats.payloads[1])||stats.successfulSaves!==2||stats.saves!==3)throw Error('Autosave retry repeated a native commit or changed original snapshot');
              if(view.data.identity.concept!=='New local edit after lost response'||view.version!==3||stats.payloads.at(-1).version!==2||stats.saveIds[2]===stats.saveIds[1])throw Error('Autosave retry lost a later edit or used stale revision');
              root=await setup({power:true,device:true,currency:'17.5',arcanePools:[{id:'alternate',name:'User reserve',current:3,max:8,skillId:'owned-skill'}],
                tableSettings:{currency:{enabled:true,label:'Credits'},rules:{noPowerPoints:true,woundCap:false}}});
              await click(root,'sheet.equipment');
              let money=root.querySelector('[data-gws-path="resources.currency"]');
              if(money.value!=='17.5'||money.getAttribute('aria-label')!=='Credits')throw Error('Table currency label changed its actor balance');
              settings.update({...settings.current,currency:{enabled:false,label:'Credits'}});
              await until(()=>!root.querySelector('[data-gws-path="resources.currency"]'),'hide currency');
              if(view.data.resources.currency!=='17.5'||stats.saves)throw Error('Hiding currency erased its balance or wrote actor settings');
              settings.update({...settings.current,currency:{enabled:true,label:'Coins'}});
              await until(()=>root.querySelector('[data-gws-path="resources.currency"]')?.getAttribute('aria-label')==='Coins','rename currency');
              if(root.querySelector('[data-gws-path="resources.currency"]').value!=='17.5'||stats.saves)throw Error('Re-enabling currency changed saved balance');
              await click(root,'sheet.overview');
              let pendingConcept=root.querySelector('[data-gws-path="identity.concept"]');pendingConcept.value='Unsaved local edit';pendingConcept.focus();pendingConcept.setSelectionRange(4,9);pendingConcept.dispatchEvent(new Event('input',{bubbles:true}));
              settings.update({...settings.current,currency:{enabled:false,label:'Coins'}});
              await until(()=>stats.successfulSaves===1&&!root.querySelector('.gws-save-status[data-state=waiting]'),'settings refresh preserves dirty draft');
              await tick();
              pendingConcept=root.querySelector('[data-gws-path="identity.concept"]');
              if(view.data.identity.concept!=='Unsaved local edit'||pendingConcept.value!=='Unsaved local edit'||document.activeElement!==pendingConcept||pendingConcept.selectionStart!==4||pendingConcept.selectionEnd!==9)throw Error('Settings refresh lost draft, focus or text selection');
              if(Object.hasOwn(view.data.rules||{},'noPowerPoints')||Object.hasOwn(view.data.rules||{},'woundCap'))throw Error('Inherited rules were materialized in the saved actor');
              modal=await openAction(root,'rules.rest');
              if(!find(modal,'rules.recoverPP').hidden||!find(modal,'rules.recoverPP').disabled||!find(modal,'rules.recoverPPBenny').hidden||!find(modal,'rules.recoverPPBenny').disabled||!modal.querySelector('[data-gws-rule=pool]').closest('label').hidden)throw Error('No PP rest exposes spending or recovery controls');
              const noPPSaves=stats.saves;find(modal,'rules.recoverPPBenny').click();await tick();
              if(stats.saves!==noPPSaves||view.data.resources.bennies!==3||view.data.resources.powerPoints!==10)throw Error('No PP rest spent a Benny or altered the saved reserve');await modal.close();
              await click(root,'common.actions');modal=document.querySelector('.gws-modal');if(find(modal,'rules.deviceAdjustments'))throw Error('No PP exposes device transfers');await modal.close();
              modal=await openCast(root);
              if(!root.querySelector('[data-gws-path="resources.powerPoints"]').closest('section').hidden||!root.querySelector('.gws-pool-list').closest('section').hidden||!find(root.querySelector('.gws-powers'),'rules.rest').hidden)throw Error('No PP exposes personal reserve controls');
              if(!modal.querySelector('[data-gws-rule=pool]').closest('label').hidden||!modal.querySelector('[data-gws-rule=shorting]').closest('label').hidden||modal.querySelector('[data-gws-rule=prepared]').closest('label').hidden)throw Error('No PP cast has incorrect contextual fields');
              modal.querySelector('[data-gws-rule=trait]').value='owned-skill';modal.querySelector('[data-gws-rule=prepared]').checked=true;
              await click(modal,'rules.roll');await click(modal,'rules.apply');await modal.close();
              await click(root,'rules.maintain');
              if(view.data.resources.powerPoints!==10||view.data.resources.bennies!==3||view.data.arcanePools[0].current!==3||view.data.activePowers[0].remainingRounds!==null||Object.hasOwn(view.data.rules||{},'noPowerPoints'))throw Error('Inherited No PP casting or maintenance corrupted saved reserves or overrides');
              await click(root.querySelector('.gws-footer'),'rules.characterSettings');modal=document.querySelector('.gws-modal');
              let noPPChoice=modal.querySelector('[data-gws-path="rules.noPowerPoints"]');
              if(noPPChoice.tagName!=='SELECT'||noPPChoice.value!=='inherit')throw Error('Missing tri-state inheritance selector');
              noPPChoice.value='false';noPPChoice.dispatchEvent(new Event('change',{bubbles:true}));await modal.close();
              if(view.data.rules.noPowerPoints!==false||root.querySelector('[data-gws-path="resources.powerPoints"]').closest('section').hidden)throw Error('Explicit false override was coerced or ignored');
              modal=await openCast(root);modal.querySelector('[data-gws-rule=trait]').value='owned-skill';await click(modal,'rules.roll');await click(modal,'rules.apply');await modal.close();
              if(view.data.resources.powerPoints!==8)throw Error('False override did not restore normal power costs');
              await click(root.querySelector('.gws-footer'),'rules.characterSettings');modal=document.querySelector('.gws-modal');noPPChoice=modal.querySelector('[data-gws-path="rules.noPowerPoints"]');
              noPPChoice.value='true';noPPChoice.dispatchEvent(new Event('change',{bubbles:true}));await modal.close();if(view.data.rules.noPowerPoints!==true)throw Error('True rule override was serialized as a string');
              await click(root.querySelector('.gws-footer'),'rules.characterSettings');modal=document.querySelector('.gws-modal');noPPChoice=modal.querySelector('[data-gws-path="rules.noPowerPoints"]');
              noPPChoice.value='inherit';noPPChoice.dispatchEvent(new Event('change',{bubbles:true}));await modal.close();
              if(Object.hasOwn(view.data.rules,'noPowerPoints')||!root.querySelector('[data-gws-path="resources.powerPoints"]').closest('section').hidden||view.data.powers[0].data.powerPoints!==2)throw Error('Returning to inheritance kept a local override or erased the power cost');
              const beforeSettingsSaves=stats.saves;settings.update({...settings.current,rules:{noPowerPoints:false,woundCap:false}});
              await until(()=>!root.querySelector('[data-gws-path="resources.powerPoints"]').closest('section').hidden,'live rule refresh');
              if(stats.saves!==beforeSettingsSaves||view.data.resources.powerPoints!==8||view.data.resources.currency!=='17.5'||view.data.arcanePools[0].current!==3)throw Error('Live rule refresh rewrote actor resources');
              abort.abort();if(settings.listeners.size)throw Error('Sheet retained its settings subscription after disposal');
              root=await setup({power:true,points:4});modal=await openAction(root,'rules.rest');
              settings.update({...settings.current,rules:{noPowerPoints:true,woundCap:false}});
              await click(modal,'rules.recoverPPBenny');await click(modal,'rules.recoverPP');
              if(stats.saves||view.data.resources.bennies!==3||view.data.resources.powerPoints!==4)throw Error('Open rest modal spent resources after table switched to No PP');await modal.close();
              root=await setup({woundCapacity:10,tableSettings:{currency:{enabled:true,label:''},rules:{noPowerPoints:false,woundCap:true}}});
              await click(root,'rules.receiveDamage');modal=document.querySelector('.gws-modal');modal.querySelector('[data-gws-rule=damage]').value='28';modal.querySelector('[data-gws-rule=toughness]').value='0';modal.querySelector('[data-gws-rule=armor]').value='0';
              await click(modal,'rules.applyDamage');
              if(view.data.resources.wounds!==4||Object.hasOwn(view.data.rules||{},'woundCap'))throw Error('Table wound cap did not apply without an actor override');await modal.close();
              root=await setup();
              const localizedConcept=root.querySelector('[data-gws-path="identity.concept"]');localizedConcept.value='Spirit';localizedConcept.dispatchEvent(new Event('input',{bubbles:true}));localizedConcept.focus();localizedConcept.setSelectionRange(1,4);
              const resourceIcon=root.querySelector('.gws-resource-label svg'),languageSaveCount=stats.saves;
              changeLanguage('pt-BR');
              if(root.querySelector('[data-gws-tab=overview]').textContent!==t('sheet.overview')||root.querySelector('[data-gws-path="identity.concept"]')!==localizedConcept||localizedConcept.value!=='Spirit'||document.activeElement!==localizedConcept||localizedConcept.selectionStart!==1||localizedConcept.selectionEnd!==4||!resourceIcon.isConnected||stats.saves!==languageSaveCount)throw Error('Language change lost actor draft, input focus, icon or caused a write');
              await mounted.flush();root.querySelector('[data-attribute=agility] .gws-die').click();await until(()=>document.querySelector('.gws-rule-grid'),'translated pending modal');modal=document.querySelector('.gws-modal');
              const difficulty=modal.querySelector('[data-gws-rule=target]');difficulty.value='7';difficulty.focus();holdRoll={promise:new Promise(resolve=>release=resolve)};
              find(modal,'rules.roll').click();await until(()=>stats.rollCalls===1,'language roll pending');const rollBefore=stats.rollCalls,saveBefore=stats.saves,pendingFocus=document.activeElement;
              changeLanguage('es');
              if(modal.querySelector('h2').textContent!==t('attribute.agility')||find(modal,'rules.roll').getAttribute('aria-busy')!=='true'||modal.querySelector('[data-gws-rule=target]')!==difficulty||difficulty.value!=='7'||document.activeElement!==pendingFocus||stats.rollCalls!==rollBefore||stats.saves!==saveBefore)throw Error('Language change recreated or restarted a pending actor action');
              find(modal,'common.done').focus();
              release();await until(()=>!find(modal,'rules.roll').getAttribute('aria-busy'),'translated pending completion');
              if(document.activeElement!==find(modal,'common.done'))throw Error('Completed action stole focus from another control already chosen while the roll was pending');
              const completedSpanish=modal.querySelector('.gws-rule-result').textContent;changeLanguage('en');if(modal.querySelector('.gws-rule-result').textContent===completedSpanish)throw Error('Completed outcome did not translate');await modal.close();
              root=await setup({device:true});await click(root,'sheet.equipment');
              root.querySelector('[data-entry-id=owned-device] [aria-label="'+t('common.edit')+'"]').click();await until(()=>document.querySelector('.gws-item-editor'),'translated owned item');modal=document.querySelector('.gws-modal');
              const ownedDescription=modal.querySelector('[data-gws-item-field=description]');ownedDescription.value='Power Points';ownedDescription.dispatchEvent(new Event('input',{bubbles:true}));ownedDescription.focus();ownedDescription.setSelectionRange(0,5);const ownedTab=modal.querySelector('[data-gws-item-tab=description]');
              changeLanguage('pt-BR');if(ownedTab.textContent!==t('item.description')||modal.querySelector('[data-gws-item-field=description]')!==ownedDescription||ownedDescription.value!=='Power Points'||document.activeElement!==ownedDescription||ownedDescription.selectionEnd!==5)throw Error('Owned item translation replaced draft or selected input');
              await modal.close();changeLanguage('en');
              abort.abort();await tick();
              if(languageListeners.size)throw Error('Actor retained language subscriptions after disposal');
              if(document.querySelector('dialog'))throw Error('A browser dialog was created');
              return {nativeSDK:true,nativeDiceFacts:true,receiptRetry:true,criticalLock:true,pendingEscape:true,soakBennyRetry:true,applyRetry:true,
                castBennyRetry:true,powerPointsOnlyApply:true,castApplyRetry:true,shortingCriticalLock:true,ownTargetHydration:true,
                deviceContactRetry:true,ownedDeviceBindings:true,autosaveLostResponse:true,tableCurrency:true,inheritedRules:true,triStateOverrides:true,
                noPPReservePreservation:true,noPPRestChargeGuard:true,settingsDirtyDraftFocus:true,settingsUnsubscribe:true,tableWoundCap:true,
                languageDraftFocus:true,languagePendingRoll:true,languageOwnedItem:true,languageUnsubscribe:true,
                toolbarHierarchy:true,secondaryActionsReachable:true,secondaryModalReplacement:true,secondaryFatigueOnce:true,
                actionMenuTranslation:true,actionMenuEscapeFocus:true,readOnlyActions:true,
                alphabeticalSkillRows:true,localeSkillOrder:true,linkedSkillAttribute:true,linkedSkillPenalty:true,independentSkillDie:true,skillFocus:true,storedSkillOrder:true,escapeAttributeOrder:true,narrowSkillControls:true,resultActionFocus:true,resultDoneFocus:true,pendingFocusPreserved:true,
                penaltyLabels:true,extendedWoundLevels:true,resourceTogglePersistence:true,actorIdentity:true,noDialog:true};
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
