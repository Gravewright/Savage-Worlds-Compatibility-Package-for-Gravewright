/** Sheet actions coordinate native dice and package-owned rules, never host internals. */
import {ATTRIBUTES, normalizeSheet, cloneData} from './model.js';
import {derive, traitValue, traitPenalty,weaponAttackPenalty,applyModifiers,modifiersForSheet} from './mechanics.js';
import {el, icon, bindTranslation, bindNameOrder} from './ui.js';
import {alphabeticalRows} from './workflow.js';
import {traitExpression, interpretTrait, nativeResult, nativeRollWorkflow, keepReroll, actionModifiers, damageExpression, rollOutcome} from './rolls.js';
import {damageResult, applyDamage, soakAmount, spendBenny, applyFatigue, recoverShaken, recoverStunned,
  escapeRestraint, healingResult, incapacitationResult, supportBonus, testResult} from './combat.js';
import {powerCost, activatePower, maintainPower, endPower, rechargePowerPool,devicePools,transferDevicePower} from './powers.js';
import {targetActions} from './target-actions.js';

export function actorActions(env) {
  const {doc, api, context, signal, t, modal, button, canEdit, getSheet, getName, replaceSheet, flush} = env;
  const getRules = env.getRules ?? (() => getSheet().rules ?? {});
  const label = key => t(`rules.${key}`);
  const skillsByName = rows => alphabeticalRows(rows, api.i18n?.locale);
  const targets=targetActions({...env,trait});
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  function input(body, key, value, {choices, type = 'number', min, max, step = 'any'} = {}) {
    const wrap = el(doc, 'label', 'gws-field'), node = el(doc, choices ? 'select' : 'input');
    wrap.append(el(doc, 'span', '', () => label(key)), node); bindTranslation(node, 'aria-label', () => label(key)); node.dataset.gwsRule = key;
    if (choices) for (const [id, text] of choices) {const option = el(doc, 'option', '', text); option.value = id; node.append(option);}
    else {node.type = type; node.step = step; if (min !== undefined) node.min = min; if (max !== undefined) node.max = max;}
    if (type === 'checkbox') {node.checked = value === true; wrap.classList.add('gws-item-checkbox');} else node.value = value ?? '';
    if (choices && key === 'trait') {
      const skillIds = new Set(getSheet().skills.map(row => row.id));
      for (const option of node.options) {
        const value = option.value, attribute = ATTRIBUTES.some(({id}) => value === id || value === `attribute.${id}`);
        if (!attribute && (skillIds.has(value) || value.startsWith('skill.') && skillIds.has(value.slice(6)))) option.dataset.gwsSortName = option.textContent;
      }
      bindNameOrder(node, () => api.i18n?.locale);
    }
    if (choices || type === 'checkbox') node.disabled = !canEdit(); else node.readOnly = !canEdit();
    body.append(wrap); return node;
  }
  function pane(title) {
    const node = modal(title), body = el(doc, 'div', 'gws-modal-body'), form = el(doc, 'div', 'gws-rule-grid');
    node.classList.add('gws-rule-modal');
    const message = el(doc, 'p', 'gws-rule-result'), error = el(doc, 'p', 'gws-notice');
    message.setAttribute('role', 'status'); error.setAttribute('role', 'alert'); error.hidden = true;
    const actionBar = el(doc, 'div', 'gws-rule-actions');
    body.append(form, error, message, actionBar); node.append(body);
    let pending,failedAction;const controls=[];
    node.addEventListener('gravewright:sheet-flush', event => {if (pending) event.detail.waitUntil(pending);});
    function action(key, run, {disabled = false} = {}) {
      const control = button( () => label(key), async () => {
        if (pending) return pending;
        if(failedAction && failedAction!==control)throw ruleError('retryPending');
        error.hidden = true;
        node.dataset.gwsActionPending='true';
        for(const other of controls)if(other!==control){other.dataset.gwsTemporarilyDisabled='true';other.disabled=true;}
        pending = Promise.resolve().then(run);
        try {await pending;failedAction=undefined;} catch (failure) {
          failedAction=failure.code==='rules'?undefined:control;
          failure.gwsHandled=true;
          bindTranslation(error, 'textContent', () => failure.code === 'conflict' ? t('common.conflict') : failure.code === 'rules' && failure.ruleKey ? label(failure.ruleKey) : failure.message && failure.code === 'rules' ? failure.message : t('common.saveError'));
          error.hidden = false; throw failure;
        } finally {
          pending=undefined;
          delete node.dataset.gwsActionPending;
          for(const other of controls){other.dataset.gwsTemporarilyDisabled=String(!!failedAction && other!==failedAction);
            other.disabled=disabled || !canEdit() || other.dataset.gwsActionLocked==='true' || other.dataset.gwsTemporarilyDisabled==='true';}
          queueMicrotask(() => {
            if (!node.isConnected || node.closest('[inert]')) return;
            const focused = doc.activeElement;
            if (focused && focused !== doc.body && focused !== node && focused !== control) return;
            const available = candidate => !candidate.disabled && candidate.getClientRects().length;
            const next = available(control) ? control : [...actionBar.querySelectorAll('button'), ...footer.querySelectorAll('button')].find(available);
            next?.focus({preventScroll: true});
          });
        }
      }, disabled || !canEdit());controls.push(control);actionBar.append(control);return control;
    }
    const footer = el(doc, 'footer', 'gws-modal-footer'); footer.append(button( () => t('common.done'), () => node.close())); body.append(footer);
    return {node,body,form,message,error,action};
  }
  const ruleError = key => Object.assign(new Error(label(key)), {code:'rules',ruleKey:key});
  const lock=(control,value=true)=>{control.dataset.gwsActionLocked=String(value);control.disabled=value;};
  function summary(result) {
    return t(result.critical ? 'rules.criticalFailure' : result.success ? result.raises ? 'rules.raisedResult' : 'rules.successResult' : 'rules.failureResult', {total:result.total, raises:result.raises});
  }
  function freeze(form) {for (const control of form.querySelectorAll('input,select,textarea')) control.disabled = true;}
  async function performTrait(trait, config, previous, spend = false) {
    const sheet = getSheet(), value = traitValue(trait, {sheet, attribute:config.attribute, skillId:config.skillId, untrained:config.untrained});
    const modifier = value.modifier + traitPenalty(sheet, {rules:getRules(),attribute:config.attribute,role:config.role, actions:1, freeAction:true, context:config.context || 'trait'})
      + actionModifiers({...config, distracted:false, joker:sheet.combat?.joker === true}) + number(config.modifier);
    const wild = sheet.profile.kind !== 'extra' || config.group === true;
    const expression = value.fixedValue!=null?String(value.fixedValue)+(modifier?`${modifier>0?'+':''}${modifier}`:''):traitExpression({die:value.die, modifier, wild, wildDie:sheet.profile.wildDie, count:config.count || 1});
    const workflow = nativeRollWorkflow(api, expression, {label:`${getName()} · ${config.label}`, visibility:config.visibility || 'public',
      ...(context.sceneId ? {sceneId:context.sceneId} : {})}, {signal});
    let confirmation, result, charged = false, chargeSnapshot;
    return {expression, async run() {
      await flush();
      if (spend && !charged) {chargeSnapshot ??= spendBenny(getSheet());await replaceSheet(chargeSnapshot);charged = true;}
      const message = await workflow.run();
      result = value.fixedValue!=null?rollOutcome(nativeResult(message).value.value,{target:config.target,opposed:config.opposed}):interpretTrait(message, {wild, count:config.count || 1, modifier, target:config.target, opposed:config.opposed});
      if (result.needsConfirmation) {
        confirmation ??= nativeRollWorkflow(api,'1d6',{label:`${config.label} · ${label('criticalConfirmation')}`,visibility:config.visibility || 'public'},{signal});
        const face = nativeResult(await confirmation.run()).value.value;
        result = interpretTrait(message,{wild:false,count:config.count || 1,modifier,target:config.target,opposed:config.opposed,confirmation:face});
      }
      return previous ? keepReroll(previous,result) : result;
    }};
  }
  function trait(traitData, config = {}) {
    const paneUI = pane(() => config.labelText?.() || config.label || label('traitRoll'));
    const {form,message,action} = paneUI;
    const difficulty = input(form,'target',config.target ?? 4,{min:1,step:1}), modifier = input(form,'situational',0);
    const actions = input(form,'actions',1,{min:1,max:3,step:1}), running = input(form,'running',false,{type:'checkbox'});
    const opposed = input(form,'opposed',config.opposed===true,{type:'checkbox'}), group = input(form,'groupRoll',false,{type:'checkbox'});
    const combatControls={};
    if(config.attack){
      combatControls.count=input(form,'attackDice',1,{min:1,max:Math.max(1,number(config.weapon?.data.rateOfFire,1)),step:1});
      for(const key of ['range','cover','illumination','calledShot','gangUp','aim'])combatControls[key]=input(form,key,0);
      for(const key of ['targetVulnerable','drop','wildAttack','recoil','unstable'])combatControls[key]=input(form,key,false,{type:'checkbox'});
    }
    const attackConfig=()=>config.attack?{...Object.fromEntries(Object.entries(combatControls).map(([key,node])=>[key,node.type==='checkbox'?node.checked:number(node.value)])),
      count:Math.max(1,Math.trunc(number(combatControls.count.value,1))),vulnerable:combatControls.targetVulnerable.checked}:{};
    const visibility = input(form,'visibility','public',{choices:[['public', () => label('publicRoll')],['gm', () => label('gmRoll')]]});
    const select = config.options ? input(form,'trait',config.selected || config.options[0][0],{choices:config.options}) : null;
    let attempt,result,effectApplied=false,effectSheet;
    const resultText=()=>`${result.hits?.length>1?result.hits.map((hit,i)=>`${i+1}: ${summary(hit)}`).join('\n'):summary(result)}${effectApplied?` · ${label('applied')}`:''}`;
    const roll = action('roll',async()=>{
      if (!attempt) {
        if (getSheet().status.dead || getSheet().status.incapacitated && !config.recovery) throw ruleError('cannotAct');
        if (getSheet().status.stunned && !config.recovery) throw ruleError('cannotAct');
        if (getSheet().status.shaken && !config.recovery && !config.free)throw ruleError('cannotAct');
        const selected = select?.value, actual = config.resolve?.(selected) || {trait:traitData,attribute:config.attribute,skillId:config.skillId};
        if(getSheet().status.bound && !config.recovery && !['smarts','spirit'].includes(actual.attribute || config.attribute))throw ruleError('cannotAct');
        attempt = await performTrait(actual.trait,{...config,...actual,...attackConfig(),target:number(difficulty.value,4),modifier:number(modifier.value)+number(actual.modifier)+number(config.modifier),
          actions:number(actions.value,1),free:config.free,running:running.checked,opposed:opposed.checked,group:group.checked,visibility:visibility.value});
        freeze(form);
      }
      result=await attempt.run();bindTranslation(message, 'textContent', resultText);roll.hidden=true;reroll.hidden=false;
      lock(reroll,result.critical || getSheet().resources.bennies < 1);
      if (config.effect || config.applyResult) apply.hidden=false;
    });
    let rerollAttempt;
    const reroll=action('rerollBenny',async()=>{
      if (result.critical) throw ruleError('criticalNoReroll');
      if (!rerollAttempt) {
        const actual=config.resolve?.(select?.value) || {trait:traitData,attribute:config.attribute,skillId:config.skillId};
        rerollAttempt=await performTrait(actual.trait,{...config,...actual,...attackConfig(),target:number(difficulty.value,4),modifier:number(modifier.value)+number(actual.modifier)+number(config.modifier),
          actions:number(actions.value,1),free:config.free,running:running.checked,opposed:opposed.checked,group:group.checked,visibility:visibility.value},result,true);
      }
      result=await rerollAttempt.run();rerollAttempt=undefined;bindTranslation(message, 'textContent', resultText);
      lock(reroll,result.critical || getSheet().resources.bennies < 1);
    });reroll.hidden=true;
    const apply=action('apply',async()=>{
      if (!result || effectApplied) return;
      lock(reroll);
      if(config.applyResult)await config.applyResult(result);
      else {effectSheet ??= config.effect(getSheet(),result);await replaceSheet(effectSheet);}
      effectApplied=true;
      apply.hidden=true;bindTranslation(message,'textContent',resultText);
    });apply.hidden=true;
    return paneUI.node;
  }
  function attribute(id) {return trait(getSheet().attributes[id],{attribute:id,label:t(`attribute.${id}`),labelText:()=>t(`attribute.${id}`)});}
  function skill(row) {
    const current = getSheet().skills.find(entry => entry.id === row.id) || row;
    return trait(current.data,{attribute:current.data.attribute,role:current.data.role,skillId:current.id,untrained:current.data.untrained,label:current.name});
  }
  function recovery(kind) {
    const sheet=getSheet(), id=kind==='shaken'?'spirit':'vigor';
    const effect={shaken:recoverShaken,stunned:recoverStunned,natural:(s,r)=>healingResult(s,r,{natural:true}),
      incapacitation:incapacitationResult,bleeding:(s,r)=>incapacitationResult(s,r,{bleeding:true})}[kind];
    return trait(sheet.attributes[id],{attribute:id,label:label(`recover.${kind}`),labelText:()=>label(`recover.${kind}`),recovery:true,free:true,effect});
  }
  function running() {
    const ui=pane( () => label('runningRoll')),stats=derive(getSheet(),{rules:getRules()});let workflow;
    ui.action('roll',async()=>{
      workflow??=nativeRollWorkflow(api,`1d${stats.runningDie}${stats.runningModifier?`${stats.runningModifier>0?'+':''}${stats.runningModifier}`:''}`,
        {label:`${getName()} · ${label('runningRoll')}`},{signal});
      const total=stats.pace+Math.max(0,nativeResult(await workflow.run()).value.value);
      bindTranslation(ui.message,'textContent',()=>t('rules.movementTotal',{total}));
    });return ui.node;
  }
  function escape() {
    const sheet=getSheet(), athletics=skillsByName(sheet.skills.filter(row=>row.data.role==='athletics'));
    const options=[['strength', () => t('attribute.strength')],...athletics.map(row=>[row.id,row.name])];
    return trait(sheet.attributes.strength,{label:label('escape'),labelText:()=>label('escape'),recovery:true,options,
      resolve:id=>id==='strength'?{trait:getSheet().attributes.strength,attribute:'strength',modifier:-2}
        :{trait:getSheet().skills.find(row=>row.id===id)?.data || {die:4,modifier:-2},skillId:id,attribute:'agility'},
      effect:escapeRestraint});
  }
  function damage(weapon, defaults={}) {
    const ui=pane( () => label('damage')), {form,message,action}=ui;
    const expression=input(form,'damageExpression',weapon?.data.damage || 'Str',{type:'text'});
    const raises=input(form,'attackRaise',defaults.raise===true,{type:'checkbox'}), bonus=input(form,'situational',defaults.bonus || 0);
    const currentStrength=()=>traitValue(getSheet().attributes.strength,{sheet:getSheet(),attribute:'strength'});
    const additionalDamage=()=>number(bonus.value)+(getSheet().combat?.joker?2:0)+applyModifiers(0,'damage',modifiersForSheet(getSheet()));
    let workflow,result,retry,charge;
    const roll=action('rollDamage',async()=>{
      workflow ??= nativeRollWorkflow(api,damageExpression(expression.value,{strength:currentStrength(),raise:raises.checked,
        minimumStrength:weapon?.data.minStrength,weaponType:weapon?.data.attackType,bonus:additionalDamage()}),
        {label:`${getName()} · ${weapon?.name || label('damage')}`},{signal});
      freeze(form);result=nativeResult(await workflow.run()).value.value;bindTranslation(message, 'textContent', () => t('rules.damageTotal',{total:result}));roll.hidden=true;reroll.hidden=false;lock(reroll,getSheet().resources.bennies<1);
    });
    const reroll=action('rerollBenny',async()=>{
      if(!retry){charge=spendBenny(getSheet());retry=nativeRollWorkflow(api,damageExpression(expression.value,{strength:currentStrength(),raise:raises.checked,
        minimumStrength:weapon?.data.minStrength,weaponType:weapon?.data.attackType,bonus:additionalDamage()}),{label:`${getName()} · ${label('damage')}`},{signal});}
      await replaceSheet(charge);result=Math.max(result,nativeResult(await retry.run()).value.value);retry=undefined;charge=undefined;bindTranslation(message, 'textContent', () => t('rules.damageTotal',{total:result}));lock(reroll,getSheet().resources.bennies<1);
    });reroll.hidden=true;
    return ui.node;
  }
  function incomingDamage() {
    const ui=pane( () => label('receiveDamage')), {form,message,action}=ui,stats=derive(getSheet(),{rules:getRules()});
    const amount=input(form,'damage',0,{min:0}), toughness=input(form,'toughness',stats.toughness,{min:0}), armor=input(form,'armor',stats.armor,{min:0});
    const ap=input(form,'armorPiercing',0,{min:0}), heavy=input(form,'heavyWeapon',false,{type:'checkbox'}), armorHeavy=input(form,'heavyArmor',false,{type:'checkbox'});
    const nonlethal=input(form,'nonlethal',false,{type:'checkbox'});
    let preview,applied=false,snapshot,soaked=0,soakAttempt,soakResult,charged=false,chargeSnapshot;
    const calculate=()=>preview??=damageResult({damage:number(amount.value),toughness:number(toughness.value),armor:number(armor.value),armorPiercing:number(ap.value),
      shaken:getSheet().status.shaken,heavyArmor:armorHeavy.checked,heavyWeapon:heavy.checked});
    action('previewDamage',()=>{const result=calculate();freeze(form);bindTranslation(message, 'textContent', () => t('rules.damagePreview',{wounds:result.wounds,shaken:result.shaken?t('common.yes'):t('common.no')}));});
    const soak=action('soakBenny',async()=>{
      if(applied)return;
      const result=calculate();freeze(form);if(!result.wounds)throw ruleError('noWoundsToSoak');
      if(!charged){chargeSnapshot??=spendBenny(getSheet());await replaceSheet(chargeSnapshot);charged=true;}
      soakAttempt ??= await performTrait(getSheet().attributes.vigor,{attribute:'vigor',label:label('soak'),target:4,free:true});
      soakResult=await soakAttempt.run();soaked=soakAmount(soakResult,result.wounds);bindTranslation(message, 'textContent', () => `${summary(soakResult)} · ${t('rules.soaked',{count:soaked})}`);
      soak.hidden=true;retrySoak.hidden=false;lock(retrySoak,soakResult.critical || getSheet().resources.bennies<1);
    });
    let rerollAttempt;
    const retrySoak=action('rerollBenny',async()=>{
      if(applied || soakResult?.critical)return;
      rerollAttempt ??= await performTrait(getSheet().attributes.vigor,{attribute:'vigor',label:label('soak'),target:4,free:true},soakResult,true);
      soakResult=await rerollAttempt.run();rerollAttempt=undefined;soaked=soakAmount(soakResult,calculate().wounds);
      bindTranslation(message, 'textContent', () => `${summary(soakResult)} · ${t('rules.soaked',{count:soaked})}`);lock(retrySoak,soakResult.critical || getSheet().resources.bennies<1);
    });retrySoak.hidden=true;
    const apply=action('applyDamage',async()=>{
      if(applied)return;freeze(form);snapshot??=applyDamage(getSheet(),calculate(),{soaked,nonlethal:nonlethal.checked,woundCap:getRules().woundCap===true});
      lock(soak);lock(retrySoak);await replaceSheet(snapshot);applied=true;lock(apply);bindTranslation(message, 'textContent', () => label('applied'));
    });return ui.node;
  }
  function attack(weapon) {
    const sheet=getSheet(), melee=weapon.data.attackType==='melee';
    const skills=sheet.skills.filter(row=>row.data.role===(melee?'fighting':'shooting'));
    const options=[['', () => label('untrained')],...skillsByName(sheet.skills).map(row=>[row.id,row.name])];
    const node=trait(skills[0]?.data || {die:4,modifier:-2},{label:`${label('attack')} · ${weapon.name}`,labelText:()=>`${label('attack')} · ${weapon.name}`,attack:true,weapon,options,selected:skills[0]?.id || '',
      target:melee?2:4,modifier:weaponAttackPenalty(sheet,weapon),resolve:id=>{
        const row=getSheet().skills.find(item=>item.id===id);
        return {trait:row?.data || {die:4,modifier:0,untrained:true},skillId:row?.id,attribute:row?.data.attribute,role:row?.data.role,untrained:!row};
      }});
    node.classList.add('gws-rule-modal--attack');
    node.querySelector('.gws-rule-actions').append(button( () => label('rollDamage'),()=>damage(weapon),!canEdit()));return node;
  }
  function cast(power) {
    const ui=pane( () => `${label('activatePower')} · ${power.name}`), {form,message,action}=ui,sheet=getSheet();
    const noPowerPoints=getRules().noPowerPoints===true,pools=sheet.arcanePools || [],devices=noPowerPoints?[]:devicePools(sheet,power.id);
    const pool=input(form,'pool',power.data.poolId || '',{choices:[['', () => label('defaultPool')],...pools.map(p=>[p.id,p.name || label('pool')]),...devices.map(device=>[device.id, () => `${label('device')} · ${device.label}`])]});
    pool.closest('label').hidden=noPowerPoints;
    const skillSelect=input(form,'trait',power.data.skillId || '',{choices:[['', () => label('untrained')],...skillsByName(sheet.skills).map(row=>[row.id,row.name])]});
    const extra=input(form,'additionalCost',power.data.additionalCost || 0,{min:0}),targets=input(form,'targetCount',1,{min:1,max:100,step:1});
    const shorting=input(form,'shorting',0,{min:0,step:1}),modifier=input(form,'situational',0),actions=input(form,'actions',1,{min:1,max:3,step:1});
    shorting.closest('label').hidden=noPowerPoints;
    const prepared=input(form,'prepared',false,{type:'checkbox'});prepared.closest('label').hidden=!noPowerPoints;
    let attempt,result,snapshot,applied=false,activation,chosenTrait,costModifier,castOptions;
    const activationOptions=()=>castOptions ?? {poolId:getRules().noPowerPoints===true?'':pool.value,additionalCost:number(extra.value),targetCount:number(targets.value,1),
      shorting:getRules().noPowerPoints===true?0:number(shorting.value),prepared:prepared.checked,noPowerPoints:getRules().noPowerPoints===true};
    const displayActivation=()=>{
      activation=activatePower(getSheet(),power,{total:result.total,criticalFailure:result.critical},activationOptions());
      if(!activation.ok)throw ruleError('invalidPowerCost');
      const shown=activation.outcome==='criticalFailure'?{...result,critical:true,success:false}:result;
      bindTranslation(message, 'textContent', () => `${summary(shown)} · ${t('rules.ppSpent',{count:activation.spent})}${applied?` · ${label('applied')}`:''}`);
      return shown;
    };
    const roll=action('roll',async()=>{
      if(sheet.status.bound || sheet.status.shaken || sheet.status.stunned || sheet.status.incapacitated || sheet.status.dead)throw ruleError('cannotAct');
      if(!attempt){
        const options=activationOptions();
        const cost=powerCost(power,{...options,
          maintainedCount:getSheet().activePowers.filter(entry=>entry.active && entry.maintained).length});
        if(!cost.valid)throw ruleError('invalidPowerCost');
        const row=getSheet().skills.find(item=>item.id===skillSelect.value);
        const chosenPool=[...pools,...devices].find(p=>p.id===pool.value),selected=row || getSheet().skills.find(item=>item.id===chosenPool?.skillId);
        const preview=activatePower(getSheet(),power,{total:4},options);
        if(!preview.ok)throw ruleError('invalidPowerCost');
        castOptions=options;chosenTrait=selected;costModifier=cost.skillModifier;
        attempt=await performTrait(selected?.data || {die:4,modifier:0,untrained:true},{attribute:selected?.data.attribute,role:selected?.data.role,skillId:selected?.id,untrained:!selected,
          label:power.name,target:4,actions:number(actions.value,1),modifier:number(modifier.value)+cost.skillModifier});freeze(form);
      }
      result=await attempt.run();const shown=displayActivation();roll.hidden=true;apply.hidden=false;reroll.hidden=false;lock(reroll,shown.critical || getSheet().resources.bennies<1);
    });
    let rerollAttempt;
    const reroll=action('rerollBenny',async()=>{
      if(activation.outcome==='criticalFailure' || snapshot)throw ruleError('criticalNoReroll');
      rerollAttempt??=await performTrait(chosenTrait?.data || {die:4,modifier:0,untrained:true},{attribute:chosenTrait?.data.attribute,role:chosenTrait?.data.role,skillId:chosenTrait?.id,untrained:!chosenTrait,
        label:power.name,target:4,actions:number(actions.value,1),modifier:number(modifier.value)+costModifier},result,true);
      result=await rerollAttempt.run();rerollAttempt=undefined;const shown=displayActivation();lock(reroll,shown.critical || getSheet().resources.bennies<1);
    });reroll.hidden=true;
    const apply=action('apply',async()=>{if(applied)return;snapshot??=activation.sheet;lock(reroll);await replaceSheet(snapshot);applied=true;lock(apply);const shown=activation.outcome==='criticalFailure'?{...result,critical:true,success:false}:result;bindTranslation(message,'textContent',()=>`${summary(shown)} · ${t('rules.ppSpent',{count:activation.spent})} · ${label('applied')}`);});apply.hidden=true;
    return ui.node;
  }
  async function maintain(id) {const result=maintainPower(getSheet(),id,{noPowerPoints:getRules().noPowerPoints===true});if(!result.ok)throw ruleError('insufficientPP');await replaceSheet(result.sheet);}
  async function end(id) {const result=endPower(getSheet(),id);if(result.ok)await replaceSheet(result.sheet);}
  function rest() {
    const ui=pane( () => label('rest')), {form,message,action}=ui;
    const hours=input(form,'hours',1,{min:0}),pool=input(form,'pool','',{choices:[['', () => label('defaultPool')],...(getSheet().arcanePools || []).map(p=>[p.id,p.name])]});
    const noPowerPoints=getRules().noPowerPoints===true;pool.closest('label').hidden=noPowerPoints;
    let snapshot;
    const recoverPP=action('recoverPP',async()=>{if(!snapshot){const result=rechargePowerPool(getSheet(),pool.value,{hours:number(hours.value),noPowerPoints:getRules().noPowerPoints===true});if(!result.ok)throw ruleError('cannotRecharge');snapshot=result.sheet;freeze(form);}await replaceSheet(snapshot);lock(recoverPP);bindTranslation(message, 'textContent', () => label('applied'));});
    let bennySnapshot;
    const recoverBenny=action('recoverPPBenny',async()=>{if(!bennySnapshot){const result=rechargePowerPool(getSheet(),pool.value,{benny:true,noPowerPoints:getRules().noPowerPoints===true});if(!result.ok)throw ruleError('insufficientPP');bennySnapshot=result.sheet;}await replaceSheet(bennySnapshot);lock(recoverBenny);bindTranslation(message, 'textContent', () => label('applied'));});
    recoverPP.hidden=recoverBenny.hidden=noPowerPoints;if(noPowerPoints){lock(recoverPP);lock(recoverBenny);}
    let fatigueSnapshot;
    const recoverFatigue=action('recoverFatigue',async()=>{fatigueSnapshot??=applyFatigue(getSheet(),-Math.floor(number(hours.value)));await replaceSheet(fatigueSnapshot);lock(recoverFatigue);bindTranslation(message, 'textContent', () => label('applied'));});return ui.node;
  }
  function deviceAdjustments() {
    const ui=pane( () => label('deviceAdjustments')),{form,message,action}=ui;
    const devices=devicePools(getSheet());
    const device=input(form,'device',devices[0]?.id || '',{choices:devices.map(entry=>[entry.id,entry.label])});
    const pool=input(form,'pool','',{choices:[['', () => label('defaultPool')],...getSheet().arcanePools.map(entry=>[entry.id,entry.name])]});
    const amount=input(form,'transferAmount',5,{min:1,max:5,step:1});let snapshot;
    const contact=input(form,'physicalContact',false,{type:'checkbox'});
    const controls=[];
    for(const [key,direction]of [['transferToDevice','to-device'],['transferFromDevice','from-device']]){
      const control=action(key,async()=>{
        if(!snapshot && getRules().noPowerPoints===true)throw ruleError('deviceTransferError');
        if(!contact.checked)throw ruleError('physicalContactRequired');
        if(!snapshot){const result=transferDevicePower(getSheet(),device.value.replace(/^device:/,''),{poolId:pool.value,amount:number(amount.value),direction,physicalContact:contact.checked,noPowerPoints:getRules().noPowerPoints===true});
          if(!result.ok)throw ruleError('deviceTransferError');snapshot=result.sheet;freeze(form);}
        await replaceSheet(snapshot);for(const button of controls)lock(button);bindTranslation(message, 'textContent', () => label('applied'));
      });controls.push(control);
    }
    if(!devices.length){bindTranslation(ui.error, 'textContent', () => label('devicePowersHint'));ui.error.hidden=false;for(const button of controls)lock(button);}
    return ui.node;
  }
  function bar() {
    const node=el(doc,'div','gws-actionbar');
    const roll=button( () => label('traitRoll'),()=>trait({die:4,modifier:0,untrained:true},{label:label('untrained'),labelText:()=>label('untrained'),untrained:true}),!canEdit());
    roll.classList.add('gws-action-primary'); roll.prepend(icon(doc,'dice'));
    const damage=button( () => label('receiveDamage'),incomingDamage,!canEdit());
    damage.classList.add('gws-action-danger'); damage.prepend(icon(doc,'wound'));
    const more=button( () => t('common.actions'),()=>{
      const ui=pane( () => t('common.actions'));
      ui.form.classList.add('gws-action-options');
      const choice=(text,run)=>ui.form.append(button(text,async()=>{
        await ui.node.close(); if(!ui.node.isConnected && canEdit())await run();
      },!canEdit()));
      for(const [key,run] of [['runningRoll',running],['rest',rest],['fatigueGain',()=>replaceSheet(applyFatigue(getSheet()))]])choice( () => label(key),run);
      for(const key of ['support','test','heal','stabilize'])choice( () => t(`target.${key}`),()=>targets[key]());
      choice( () => t('rules.recover.natural'),()=>recovery('natural'));
      if(getRules().noPowerPoints!==true)choice( () => t('rules.deviceAdjustments'),()=>{if(getRules().noPowerPoints!==true)return deviceAdjustments();});
    },!canEdit());
    more.classList.add('gws-action-menu'); more.setAttribute('aria-haspopup','dialog');
    node.append(roll,damage,more);
    return node;
  }
  return {attribute,skill,trait,recovery,escape,damage,incomingDamage,attack,cast,maintain,end,rest,running,bar};
}
