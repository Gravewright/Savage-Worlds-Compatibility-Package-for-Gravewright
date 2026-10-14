/** Editable numeric effects and clocks; no named ability or power content. */
import {el, bindTranslation} from './ui.js';

export function itemRulesEditor({doc,t,type,data,changed,canEdit,skills=[],pools=[],powers=[]}) {
  const root=el(doc,'section','gws-item-group gws-item-rules'),editable=()=>typeof canEdit==='function'?canEdit():canEdit===true;
  root.append(el(doc,'h3','', () => t('rules.itemAutomation')),el(doc,'p','gws-field-hint', () => t('rules.modifierHint')));
  const grid=el(doc,'div','gws-item-field-grid');root.append(grid);
  function field(path,key,{choices,boolean=false,number=false,min}={}) {
    const wrap=el(doc,'label','gws-field'),node=el(doc,choices?'select':'input');wrap.append(el(doc,'span','', () => t(key)),node);
    if(choices)for(const [value,label]of choices){const option=el(doc,'option','',label);option.value=value;node.append(option);}
    else node.type=boolean?'checkbox':number?'number':'text';
    if(number){node.step='any';if(min!==undefined)node.min=min;}
    const value=data()[path];if(boolean)node.checked=value===true;else node.value=value??'';
    bindTranslation(node, 'aria-label', () => t(key));node.dataset.gwsItemField=path;
    if(choices || boolean)node.disabled=!editable();else node.readOnly=!editable();
    node.addEventListener(choices || boolean?'change':'input',()=>{
      if(!editable() || number && !node.validity.valid)return;
      changed(path,boolean?node.checked:number?node.value===''?'':Number(node.value):node.value);
    });grid.append(wrap);return node;
  }
  if(type==='skill') {
    field('role','rules.skillRole',{choices:[['', () => t('item.emptyValue')],...['fighting','shooting','athletics','healing','notice','driving','piloting','arcane'].map(id=>[id, () => t(`rules.skillRole.${id}`)])]});
    field('untrained','rules.untrained',{boolean:true});
  }
  if(type==='weapon')field('attackType','rules.attackType',{choices:['melee','ranged','thrown'].map(id=>[id, () => t(`rules.attackType.${id}`)])});
  if(type==='armor') {
    field('kind','rules.armorKind',{choices:[['armor', () => t('item.type.armor')],['shield', () => t('rules.shield')]]});
    const body=el(doc,'div','gws-armor-locations');grid.append(body);
    body.append(el(doc,'span','', () => t('item.field.coverage')));
    for(const location of ['torso','head','arms','legs']){
      const wrap=el(doc,'label','gws-field gws-item-checkbox'),control=el(doc,'input');control.type='checkbox';control.checked=data().locations?.includes(location)===true;
      control.disabled=!editable();bindTranslation(control, 'aria-label', () => t(`rules.location.${location}`));wrap.append(el(doc,'span','', () => t(`rules.location.${location}`)),control);body.append(wrap);
      control.onchange=()=>{const current=new Set(data().locations || []);if(control.checked)current.add(location);else current.delete(location);changed('locations',[...current]);};
    }
  }
  if(type==='power' || type==='arcane-device') {
    if(pools.length)field('poolId','rules.pool',{choices:[['', () => t('rules.defaultPool')],...pools.map(p=>[p.id,p.name])]});
    if(skills.length)field('skillId','rules.arcaneSkill',{choices:[['', () => t('item.emptyValue')],...skills.map(row=>[row.id,row.name])]});
  }
  if(type==='arcane-device') {
    const group=el(doc,'div','gws-device-powers');group.append(el(doc,'h4','', () => t('rules.devicePowers')));root.append(group);
    if(!powers.length)group.append(el(doc,'p','gws-field-hint', () => t('rules.devicePowersHint')));
    for(const power of powers){const label=el(doc,'label','gws-field gws-item-checkbox'),control=el(doc,'input');control.type='checkbox';control.disabled=!editable();control.checked=(data().powerIds || []).includes(power.id);
      control.setAttribute('aria-label',power.name);label.append(el(doc,'span','',power.name),control);group.append(label);
      control.onchange=()=>{const current=new Set(data().powerIds || []);if(control.checked)current.add(power.id);else current.delete(power.id);changed('powerIds',[...current]);};
    }
  }
  if(type==='effect') {
    field('remaining','rules.clockRemaining',{number:true,min:0});
    field('phase','rules.clockPhase',{choices:['start','end','round'].map(id=>[id, () => t(`rules.clockPhase.${id}`)])});
    field('owner','rules.clockOwner',{choices:[['self', () => t('rules.clockSelf')],['source', () => t('rules.clockSource')]]});
    field('sourceActorId','rules.clockSourceActor');field('sourceTokenId','rules.clockSourceToken');
  }
  const list=el(doc,'div','gws-modifier-list');root.append(list);
  function draw(){
    list.replaceChildren();
    (Array.isArray(data().modifiers)?data().modifiers:[]).forEach((entry,index)=>{
      const row=el(doc,'div','gws-modifier-row');
      const enabled=el(doc,'input'),target=el(doc,'select'),mode=el(doc,'select'),value=el(doc,'input'),remove=el(doc,'button','gws-button', () => t('common.remove'));
      enabled.type='checkbox';enabled.checked=entry.enabled!==false;bindTranslation(enabled, 'aria-label', () => t('rules.modifierEnabled'));
      const targets=[['', () => t('rules.modifierTarget')],...['parry','toughness','armor','pace'].map(id=>[id, () => t(`stat.${id}`)]),['damage', () => t('rules.damage')],['running', () => t('rules.runningModifier')],['load', () => t('rules.loadLimit')],['wounds', () => t('resource.wounds')],['fatigue', () => t('resource.fatigue')],
        ...['agility','smarts','spirit','strength','vigor'].flatMap(id=>[[`attribute.${id}`, () => t(`attribute.${id}`)],[`attribute.${id}.steps`, () => t('rules.modifierDieSteps',{name:t(`attribute.${id}`)})]]),
        ...skills.flatMap(row=>[[`skill.${row.id}`,row.name],[`skill.${row.id}.steps`, () => t('rules.modifierDieSteps',{name:row.name})]])];
      if(entry.target && !targets.some(([id])=>id===entry.target))targets.push([entry.target,entry.target]);
      for(const [id,label]of targets){const option=el(doc,'option','',label);option.value=id;target.append(option);}target.value=entry.target || '';bindTranslation(target, 'aria-label', () => t('rules.modifierTarget'));target.disabled=!editable();
      for(const id of ['add','override']){const option=el(doc,'option','', () => t(`rules.modifierMode.${id}`));option.value=id;mode.append(option);}mode.value=entry.mode || 'add';bindTranslation(mode, 'aria-label', () => t('rules.modifierMode'));
      value.type='number';value.step='any';value.value=entry.value??0;bindTranslation(value, 'aria-label', () => t('rules.modifierValue'));
      enabled.disabled=mode.disabled=remove.disabled=!editable();target.readOnly=value.readOnly=!editable();remove.type='button';
      const update=()=>{if(!editable() || !value.validity.valid)return;const entries=structuredClone(data().modifiers || []);entries[index]={...entries[index],target:target.value.trim(),mode:mode.value,value:Number(value.value),enabled:enabled.checked};changed('modifiers',entries);};
      enabled.onchange=mode.onchange=target.onchange=update;value.oninput=update;
      remove.onclick=()=>{changed('modifiers',(data().modifiers || []).filter((entry,i)=>i!==index));draw();};
      row.append(enabled,target,mode,value,remove);list.append(row);
    });
  }
  draw();
  const add=el(doc,'button','gws-button', () => `+ ${t('rules.addModifier')}`);add.type='button';add.disabled=!editable();add.onclick=()=>{changed('modifiers',[...(data().modifiers || []),{target:'',mode:'add',value:0,enabled:true}]);draw();};root.append(add);
  return root;
}
