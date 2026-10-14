import test from 'node:test';
import assert from 'node:assert/strict';
import {traitExpression, interpretTrait, rollOutcome, keepReroll, damageExpression, actionModifiers, nativeRollWorkflow} from '../rolls.js';

function native(...terms) {
  return {roll:{result:{schema:'gravewright-dice-result',value:{kind:'number',value:0},rolls:terms.map((faces,index)=>({
    facts:faces.map((face,i)=>({id:`${index}-${i}`,face,cause:{kind:i?'explode':'initial'}})),
    selection:Object.fromEntries(faces.map((face,i)=>[`${index}-${i}`,'active']))
  }))}}};
}
test('trait rolls ace independently and apply modifiers after keeping the best complete die',()=>{
  assert.equal(traitExpression({die:8,modifier:-3}),'max(1d8!,1d6!)-3');
  const result=interpretTrait(native([8,8,2],[6,1]),{modifier:-3});
  assert.equal(result.total,15);assert.equal(result.raises,2);assert.equal(result.critical,false);
  assert.throws(()=>traitExpression({die:3}),RangeError);
});
test('wild cards and automatic fire detect critical failures from original dice, not summed aces',()=>{
  assert.equal(interpretTrait(native([1],[1])).critical,true);
  assert.equal(interpretTrait(native([1],[5])).critical,false);
  assert.equal(interpretTrait(native([1],[1],[4],[1]),{count:3}).critical,true);
  const result=interpretTrait(native([2],[7],[8,2],[6,3]),{count:3});
  assert.deepEqual(result.hits.map(hit=>hit.total),[10,9,7]);
  assert.equal(result.hits.length,3);
});
test('multiple-die critical majorities include the Wild Die for even trait counts',()=>{
  assert.equal(interpretTrait(native([1],[4],[1]),{count:2}).critical,true);
  assert.equal(interpretTrait(native([1],[1],[4],[4],[1]),{count:4}).critical,true);
  assert.equal(interpretTrait(native([1],[1],[4],[4],[3]),{count:4}).critical,false);
  const extra=interpretTrait(native([1],[1],[4]),{count:3,wild:false});
  assert.equal(extra.critical,true);assert.equal(extra.needsConfirmation,false);
});
test('Extras confirm a relevant natural one and untrained penalty affects both dice',()=>{
  assert.equal(interpretTrait(native([1]),{wild:false}).needsConfirmation,true);
  assert.equal(interpretTrait(native([1]),{wild:false,confirmation:1}).critical,true);
  assert.equal(interpretTrait(native([1]),{wild:false,confirmation:2}).critical,false);
  assert.equal(interpretTrait(native([1]),{wild:false,confirmation:2,modifier:8}).success,false);
  assert.equal(interpretTrait(native([1]),{wild:false,confirmation:2,modifier:8}).raises,0);
  assert.equal(interpretTrait(native([3],[6,2]),{modifier:-2}).total,6);
});
test('opposed ties favor defender and rerolls keep a complete outcome unless critically failed',()=>{
  assert.equal(rollOutcome(5,{target:5,opposed:true}).success,false);
  assert.equal(rollOutcome(3,{target:2,opposed:true}).success,false);
  assert.equal(rollOutcome(9,{target:5,opposed:true}).raises,1);
  const best=rollOutcome(10);assert.equal(keepReroll(best,rollOutcome(4)),best);
  assert.equal(keepReroll(best,rollOutcome(1,{critical:true})).critical,true);
  assert.throws(()=>keepReroll(rollOutcome(1,{critical:true}),best));
});
test('damage includes Strength and one raise die, aces every die, and never uses a Wild Die',()=>{
  assert.equal(damageExpression('For+d8',{strength:{die:6,modifier:0},raise:true}),'(1d6!)+1d6!+1d6!');
  assert.equal(damageExpression('2d6+1',{bonus:2}),'2d6!+1+2');
  assert.equal(damageExpression('Str+d8',{strength:{die:4,modifier:0},minimumStrength:6}),'(1d4!)+1d4!');
  assert.throws(()=>damageExpression('window.alert(1)'));
  assert.throws(()=>damageExpression('1000d6'));
});
test('Strength caps melee and thrown weapon dice without lowering firearms or the raise die',()=>{
  assert.equal(damageExpression('Str+d10',{strength:{die:4,modifier:0},raise:true}),'(1d4!)+1d4!+1d6!');
  assert.equal(damageExpression('1d8',{strength:{die:4,modifier:0},weaponType:'thrown'}),'1d4!');
  assert.equal(damageExpression('2d10',{strength:{die:4,modifier:0},minimumStrength:10,weaponType:'ranged'}),'2d10!');
});
test('tiny creatures use fixed Strength one without inventing a d1 roll or weapon permission',()=>{
  assert.equal(damageExpression('Str',{strength:{die:4,fixedValue:1,modifier:0}}),'(1)');
  assert.equal(damageExpression('Str+d8',{strength:{die:4,fixedValue:1,modifier:0}}),'(1)+1d8!');
});
test('contextual modifiers stack multi-actions and use only the larger Vulnerable/Drop bonus',()=>{
  assert.equal(actionModifiers({actions:3,running:true,distracted:true,vulnerable:true,drop:true,joker:true}),-2);
  assert.equal(actionModifiers({actions:3,free:true}),0);
});
test('native roll retries keep the request identity and reuse a successfully published result',async()=>{
  let attempts=0;const identities=[];
  const workflow=nativeRollWorkflow({dice:{roll:async(expression,payload,options)=>{
    identities.push(options.requestId);if(++attempts===1)throw new Error('transport');return native([4],[2]);
  }}},'max(1d8!,1d6!)',{label:'Trait'});
  await assert.rejects(workflow.run());await workflow.run();await workflow.run();
  assert.equal(attempts,2);assert.equal(new Set(identities).size,1);
});
test('transport retries retain the exact original native roll payload',async()=>{
  const attempts=[],payload={label:'Original',visibility:'gm'};
  const workflow=nativeRollWorkflow({dice:{roll:async(expression,input,options)=>{
    attempts.push({input,requestId:options.requestId});if(attempts.length===1)throw Error('response lost');return native([4],[2]);
  }}},'max(1d8!,1d6!)',payload);
  await assert.rejects(workflow.run());payload.label='Changed outside workflow';await workflow.run();
  assert.deepEqual(attempts[0],attempts[1]);
});
test('native roll labels fit the host 48 character limit while retaining a stable payload',async()=>{
  let saved;
  const workflow=nativeRollWorkflow({dice:{roll:async(expression,payload)=>{saved=payload;return native([4],[2]);}}},'max(1d8!,1d6!)',{label:'A'.repeat(120)});
  await workflow.run();assert.equal(saved.label.length,48);
});
