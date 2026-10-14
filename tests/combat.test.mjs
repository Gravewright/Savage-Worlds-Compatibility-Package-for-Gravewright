import test from 'node:test';
import assert from 'node:assert/strict';
import {createSheet} from '../model.js';
import {damageResult,applyDamage,woundCapacity,soakAmount,spendBenny,applyFatigue,recoverShaken,recoverStunned,applyState,escapeRestraint,healingResult,incapacitationResult,supportBonus,testResult} from '../combat.js';
const success={success:true,critical:false,raises:0};
const raise={...success,raises:1};
test('damage differentiates a second Shaken from a raise without adding an extra wound',()=>{
  assert.equal(damageResult({damage:5,toughness:6}).shaken,false);
  assert.equal(damageResult({damage:6,toughness:6}).wounds,0);
  assert.equal(damageResult({damage:7,toughness:6,shaken:true}).wounds,1);
  assert.equal(damageResult({damage:10,toughness:6,shaken:true}).wounds,1);
  assert.equal(damageResult({damage:14,toughness:6}).wounds,2);
});
test('becoming Shaken or Stunned cancels Hold without clearing unrelated combat state',()=>{
  const sheet=createSheet();sheet.status.holding=true;sheet.combat={roundNote:'Keep'};
  assert.equal(applyState(sheet,'shaken').status.holding,false);assert.equal(applyState(sheet,'stunned').status.holding,false);
  assert.equal(applyDamage(sheet,{wounds:0,shaken:true}).status.holding,false);
  assert.equal(testResult(sheet,raise).status.holding,false);
  assert.equal(applyState(sheet,'shaken').combat.roundNote,'Keep');
});
test('AP only cancels armor and heavy armor requires a heavy weapon',()=>{
  assert.equal(damageResult({damage:8,toughness:8,armor:2,armorPiercing:20}).toughness,6);
  assert.equal(damageResult({damage:100,toughness:8,heavyArmor:true}).wounds,0);
  assert.equal(damageResult({damage:12,toughness:8,heavyArmor:true,heavyWeapon:true}).wounds,1);
});
test('three wounds remain playable for a Wild Card, the next incapacitates; Extras tolerate none',()=>{
  let sheet=createSheet();sheet=applyDamage(sheet,{wounds:3,shaken:true});
  assert.equal(sheet.resources.wounds,3);assert.equal(sheet.status.incapacitated,false);
  sheet=applyDamage(sheet,{wounds:1,shaken:true});assert.equal(sheet.status.incapacitated,true);assert.equal(sheet.resources.wounds,3);
  const extra=createSheet();extra.profile={kind:'extra'};
  assert.equal(applyDamage(extra,{wounds:1,shaken:true}).status.incapacitated,true);
});
test('damage capacity uses the same Size, bonuses and explicit override as derived sheet stats',()=>{
  const giant=createSheet();giant.stats.size=4;giant.bonuses.woundCapacity=1;
  assert.equal(woundCapacity(giant),5);assert.equal(applyDamage(giant,{wounds:5,shaken:true}).status.incapacitated,false);
  assert.equal(applyDamage(giant,{wounds:6,shaken:true}).status.incapacitated,true);
  const extra=createSheet('npc');extra.stats.size=8;assert.equal(woundCapacity(extra),2);
  giant.profile.woundCapacity=2;assert.equal(woundCapacity(giant),2);
});
test('soaking all incoming wounds removes even previous Shaken, without absorbing old wounds',()=>{
  const sheet=createSheet();sheet.resources.wounds=2;sheet.status.shaken=true;
  assert.equal(soakAmount(raise,4),2);
  const next=applyDamage(sheet,{wounds:2,shaken:true},{soaked:2});
  assert.equal(next.resources.wounds,2);assert.equal(next.status.shaken,false);assert.equal(sheet.status.shaken,true);
});
test('Fatigue has two penalty levels, the third incapacitates and fatigue recovery clears that cause only',()=>{
  let sheet=applyFatigue(createSheet(),3);assert.equal(sheet.resources.fatigue,2);assert.equal(sheet.status.incapacitated,true);
  sheet=applyFatigue(sheet,-1);assert.equal(sheet.status.incapacitated,false);
  sheet.status.incapacitated=true;sheet.combat.incapacitationCause='wounds';
  assert.equal(applyFatigue(sheet,-1).status.incapacitated,true);
});
test('Bennies and recovery states obey success and clocks remain package owned',()=>{
  const sheet=createSheet();sheet.resources.bennies=1;sheet.status.shaken=true;
  assert.equal(spendBenny(sheet,'unshake').status.shaken,false);assert.equal(sheet.resources.bennies,1);
  const exhausted=createSheet();exhausted.resources.bennies=0;assert.throws(()=>spendBenny(exhausted),RangeError);
  assert.equal(recoverShaken(sheet,success).status.shaken,false);
  const stunned=applyState(sheet,'stunned');assert.equal(stunned.status.prone,true);
  assert.equal(recoverStunned(stunned,success).statusClocks.vulnerable.awaitingStart,true);
  assert.equal(recoverStunned(stunned,raise).statusClocks.vulnerable.awaitingStart,false);
});
test('restraint escape uses success to downgrade Bound, and a raise to release entirely',()=>{
  const sheet=createSheet();sheet.status.bound=true;
  assert.equal(escapeRestraint(sheet,success).status.entangled,true);
  assert.equal(escapeRestraint(sheet,raise).status.entangled,false);
  assert.equal(escapeRestraint(sheet,raise).status.bound,false);
});
test('healing raises remove two wounds; critical failure adds one, stabilization is separate',()=>{
  const sheet=createSheet();sheet.resources.wounds=3;sheet.status.incapacitated=true;sheet.status.bleedingOut=true;
  const healed=healingResult(sheet,raise);assert.equal(healed.resources.wounds,1);assert.equal(healed.status.incapacitated,false);
  assert.equal(healingResult(sheet,{critical:true}).status.incapacitated,true);
  assert.equal(healingResult(sheet,success,{stabilization:true}).resources.wounds,3);
  assert.equal(healingResult(sheet,success,{stabilization:true}).status.bleedingOut,false);
});
test('a successful healing roll cannot clear incapacitation when it removes no wound',()=>{
  const sheet=createSheet();sheet.resources.wounds=0;sheet.status.incapacitated=true;sheet.combat={incapacitationCause:'fatigue'};
  const next=healingResult(sheet,success);
  assert.equal(next.resources.wounds,0);assert.equal(next.status.incapacitated,true);assert.equal(next.combat.incapacitationCause,'fatigue');
});
test('incapacitation and bleeding handle critical failure and stabilization without a content table',()=>{
  assert.equal(incapacitationResult(createSheet(),{critical:true}).status.dead,true);
  assert.equal(incapacitationResult(createSheet(),{success:false}).status.bleedingOut,true);
  assert.equal(incapacitationResult(createSheet(),raise,{bleeding:true}).status.bleedingOut,false);
});
test('support bonuses cap at four except Strength; Tests may Shaken but never cause a damage wound',()=>{
  assert.equal(supportBonus(raise,3),4);assert.equal(supportBonus(raise,3,{strength:true}),5);
  assert.equal(supportBonus({critical:true},1),-1);
  const tested=testResult(createSheet(),raise);assert.equal(tested.status.shaken,true);assert.equal(tested.resources.wounds,0);
});
