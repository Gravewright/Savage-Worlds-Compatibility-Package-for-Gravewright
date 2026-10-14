import test from 'node:test';
import assert from 'node:assert/strict';
import { powerCost, activatePower, maintainPower, endPower, advancePowers, rechargePowerPool, devicePools, transferDevicePower } from '../powers.js';

const actor = () => ({ resources: { powerPoints: 12, powerPointsMax: 15, fatigue: 0, bennies: 2 }, status: {}, arcanePools: [], activePowers: [] });
const power = values => ({ id: 'custom-power', name: 'User power', data: { powerPoints: 3, additionalCost: 0, limitations: 0, shorting: 0,
  targetCount: 1, durationRounds: 5, maintainable: true, ...values } });
const deviceActor = (values = {}) => ({ ...actor(), inventory: [{ id: 'owned-device', sourceId: 'library-device', type: 'arcane-device', name: 'User device',
  data: { powerIds: ['custom-power'], powerPoints: 0, powerPointsMax: 10, poolId: '', skillId: 'user-device-skill', allocatedPowerPoints: 0, ...values } }] });

test('manual modifier costs and limitations have a minimum and bounded bonus; targets do not multiply base cost', () => {
  const cost = powerCost(power({ additionalCost: 2, limitations: 5, targetCount: 3 }));
  assert.equal(cost.totalCost, 1); assert.equal(cost.limitationBonus, 1); assert.equal(cost.targetCount, 3);
  assert.equal(powerCost(power({ limitations: 9 })).limitationBonus, 2);
  assert.equal(powerCost(power({ additionalCost: 2, targetCount: 3 })).totalCost, 5);
  assert.equal(powerCost(power({ powerPoints: '' })).valid, false);
  assert.equal(powerCost(power({ shorting: 4 })).valid, false);
});

test('successful activation spends the declared cost and snapshots a caster-owned ledger', () => {
  const before = actor(), effects = [{ modifier: 2 }];
  const result = activatePower(before, power({ additionalCost: 2, targetCount: 3 }), { total: 8 }, { id: 'cast', targetIds: ['a', 'b', 'c'], effects });
  assert.equal(result.outcome, 'success'); assert.equal(result.raises, 1); assert.equal(result.spent, 5);
  assert.equal(result.sheet.resources.powerPoints, 7); assert.equal(before.resources.powerPoints, 12);
  assert.equal(result.activePower.remainingRounds, 5);
  result.activePower.effects[0].modifier = 9; assert.equal(effects[0].modifier, 2);
});

test('ordinary failures spend one point and critical failures terminate every pool and cause fatigue', () => {
  const before = actor(); before.activePowers = [{ id: 'a', poolId: 'one', active: true }, { id: 'b', poolId: 'two', active: true }];
  const failed = activatePower(before, power(), { total: 3 });
  assert.equal(failed.spent, 1); assert.equal(failed.sheet.activePowers[0].active, true);
  before.resources.fatigue = 2;
  const critical = activatePower(before, power(), { total: 12, criticalFailure: true });
  assert.equal(critical.outcome, 'criticalFailure'); assert.equal(critical.spent, 1);
  assert.deepEqual(critical.endedPowerIds, ['a', 'b']); assert.equal(critical.sheet.resources.fatigue, 2);
  assert.equal(critical.fatigueAdded, 1); assert.equal(critical.sheet.combat.incapacitationCause, 'fatigue');
  assert.equal(critical.sheet.status.incapacitated, true); assert.equal(before.activePowers[0].active, true);
});

test('shorting reduces allocation and adds a roll penalty; any shorted failure is critical even with zero available PP', () => {
  const before = actor(); before.resources.powerPoints = 0;
  const custom = power({ shorting: 3 }), cost = powerCost(custom);
  assert.equal(cost.allocatedCost, 0); assert.equal(cost.skillModifier, -3);
  const failed = activatePower(before, custom, { total: 3 });
  assert.equal(failed.outcome, 'criticalFailure'); assert.equal(failed.spent, 0); assert.equal(failed.fatigueAdded, 1);
  const success = activatePower(before, custom, { total: 4 });
  assert.equal(success.outcome, 'success'); assert.equal(success.spent, 0);
});

test('separate backgrounds never borrow from another pool or from legacy points', () => {
  const before = actor(); before.arcanePools = [{ id: 'one', current: 2, max: 10 }, { id: 'two', current: 8, max: 10 }];
  assert.equal(activatePower(before, power({ poolId: 'one' }), { total: 4 }).error, 'insufficient-power-points');
  assert.equal(activatePower(before, power({ poolId: 'missing' }), { total: 4 }).error, 'pool-not-found');
  const result = activatePower(before, power({ poolId: 'two' }), { total: 4 });
  assert.equal(result.sheet.arcanePools[1].current, 5); assert.equal(result.sheet.arcanePools[0].current, 2);
  assert.equal(result.sheet.resources.powerPoints, 12);
});

test('maintaining costs one per target and extends only base duration, then clocks continue to expire', () => {
  const before = activatePower(actor(), power({ additionalCost: 2, targetCount: 3 }), { total: 4 }, { id: 'cast' }).sheet;
  before.activePowers[0].remainingRounds = 1;
  const renewed = maintainPower(before, 'cast');
  assert.equal(renewed.spent, 3); assert.equal(renewed.activePower.remainingRounds, 6);
  assert.equal(renewed.activePower.maintained, true); assert.equal(before.activePowers[0].remainingRounds, 1);
  const expired = advancePowers(renewed.sheet, 6);
  assert.deepEqual(expired.endedPowerIds, ['cast']); assert.equal(expired.sheet.activePowers[0].active, false);
  assert.equal(maintainPower(expired.sheet, 'cast').error, 'power-not-active');
  assert.equal(endPower(before, 'cast').sheet.activePowers[0].active, false);
});

test('rest recovers five per hour up to maximum and is blocked while maintaining, while a Benny bypasses rest', () => {
  const before = actor(); before.resources.powerPoints = 7;
  assert.equal(rechargePowerPool(before, '', { hours: 1 }).sheet.resources.powerPoints, 12);
  assert.equal(rechargePowerPool(before, '', { hours: 2 }).sheet.resources.powerPoints, 15);
  before.activePowers = [{ id: 'cast', active: true, maintained: true }];
  assert.equal(rechargePowerPool(before, '').error, 'maintaining-powers');
  const restored = rechargePowerPool(before, '', { benny: true });
  assert.equal(restored.recovered, 5); assert.equal(restored.sheet.resources.bennies, 1);
  assert.equal(before.resources.bennies, 2);
});

test('No Power Points is optional: cost penalty, preparation, maintenance penalty, and different failure', () => {
  const before = actor(); before.activePowers = [{ id: 'a', active: true, maintained: true }];
  assert.equal(powerCost(power(), { noPowerPoints: true, maintainedCount: 1 }).skillModifier, -3);
  assert.equal(powerCost(power(), { noPowerPoints: true, maintainedCount: 1, prepared: true }).skillModifier, -1);
  const failure = activatePower(before, power(), { total: 3 }, { noPowerPoints: true });
  assert.equal(failure.spent, 0); assert.equal(failure.sheet.status.shaken, true); assert.deepEqual(failure.endedPowerIds, ['a']);
  const critical = activatePower(before, power(), { total: 1, criticalFailure: true }, { noPowerPoints: true });
  assert.equal(critical.sheet.status.shaken, true); assert.equal(critical.sheet.resources.fatigue, 1);
  const success = activatePower(before, power(), { total: 4 }, { noPowerPoints: true, id: 'b' });
  const maintained = maintainPower(success.sheet, 'b', { noPowerPoints: true });
  assert.equal(maintained.spent, 0); assert.equal(maintained.activePower.remainingRounds, null);
  assert.equal(advancePowers(maintained.sheet, 99).sheet.activePowers.find(entry => entry.id === 'b').active, true);
});

test('manual durations stay manual and invalid rolls or bound casters change no resources', () => {
  const before = actor(); before.status.bound = true;
  assert.equal(activatePower(before, power(), { total: 4 }).error, 'bound');
  before.status.bound = false;
  assert.equal(activatePower(before, power(), { total: NaN }).error, 'invalid-roll');
  const result = activatePower(before, power({ durationRounds: 0 }), { total: 4 }, { id: 'manual' });
  assert.equal(result.activePower.remainingRounds, null);
  assert.equal(advancePowers(result.sheet, 100).sheet.activePowers[0].active, true);
  assert.equal(before.resources.powerPoints, 12);
});

test('stored No Power Points rules apply consistently and recharge never spends a Benny or changes saved reserves', () => {
  const before = actor(); before.rules = { noPowerPoints: true }; before.arcanePools = [{ id: 'own', current: 3, max: 20 }];
  const snapshot = structuredClone(before);
  const cast = activatePower(before, power(), { total: 4 }, { id: 'stored-rule' });
  assert.equal(cast.spent, 0); assert.equal(cast.cost.skillModifier, -2);
  assert.equal(cast.sheet.resources.powerPoints, 12); assert.deepEqual(cast.sheet.arcanePools, before.arcanePools);
  const maintained = maintainPower(cast.sheet, 'stored-rule');
  assert.equal(maintained.spent, 0); assert.equal(maintained.activePower.remainingRounds, null);
  for (const poolId of ['', 'own']) for (const benny of [false, true]) {
    const result = rechargePowerPool(before, poolId, { benny });
    assert.equal(result.error, 'no-power-points'); assert.deepEqual(result.sheet, snapshot);
  }
  assert.deepEqual(before, snapshot);
});

test('explicit false overrides stored No Power Points for activation, maintenance, recovery and devices', () => {
  const before = actor(); before.rules = { noPowerPoints: true };
  const cast = activatePower(before, power(), { total: 4 }, { noPowerPoints: false, id: 'normal' });
  assert.equal(cast.spent, 3); assert.equal(cast.cost.skillModifier, 0); assert.equal(cast.sheet.resources.powerPoints, 9);
  const maintained = maintainPower(cast.sheet, 'normal', { noPowerPoints: false });
  assert.equal(maintained.spent, 1); assert.equal(maintained.sheet.resources.powerPoints, 8);
  const restored = rechargePowerPool(before, '', { noPowerPoints: false, benny: true });
  assert.equal(restored.recovered, 3); assert.equal(restored.spentBennies, 1);
  const device = deviceActor(); device.rules = { noPowerPoints: true };
  const funded = transferDevicePower(device, 'owned-device', { amount: 5, noPowerPoints: false });
  assert.equal(funded.ok, true); assert.equal(funded.sheet.resources.powerPoints, 7);
  const deviceCast = activatePower(funded.sheet, power(), { total: 4 }, { poolId: 'device:owned-device', noPowerPoints: false, id: 'device-normal' });
  assert.equal(deviceCast.spent, 3); assert.equal(deviceCast.sheet.inventory[0].data.powerPoints, 2);
  assert.equal(maintainPower(deviceCast.sheet, 'device-normal', { noPowerPoints: false }).spent, 1);
});

test('device choices only expose explicitly bound owned powers and the device activation skill', () => {
  const before = deviceActor({ powerIds: ['owned-power'] });
  const selected = devicePools(before, 'owned-power');
  assert.equal(selected.length, 1); assert.equal(selected[0].id, 'device:owned-device');
  assert.equal(selected[0].label, 'User device'); assert.equal(selected[0].skillId, 'user-device-skill');
  assert.equal(devicePools(before, 'library-power').length, 0);
  assert.equal(devicePools(before).length, 1);
  assert.equal(activatePower(before, power(), { total: 4 }, { poolId: 'device:owned-device' }).error, 'power-not-in-device');
});

test('transferring and reclaiming points conserves both pools and the invested allocation without mutating input', () => {
  const before = deviceActor();
  const sent = transferDevicePower(before, 'owned-device', { amount: 5 });
  assert.equal(sent.ok, true); assert.equal(sent.sheet.resources.powerPoints, 7);
  assert.equal(sent.deviceCurrent, 5); assert.equal(sent.allocatedPowerPoints, 5);
  assert.equal(before.resources.powerPoints, 12); assert.equal(before.inventory[0].data.powerPoints, 0);
  const returned = transferDevicePower(sent.sheet, 'device:owned-device', { amount: 3, direction: 'from-device' });
  assert.equal(returned.sheet.resources.powerPoints, 10); assert.equal(returned.deviceCurrent, 2); assert.equal(returned.allocatedPowerPoints, 2);
  assert.equal(returned.sheet.resources.powerPoints + returned.deviceCurrent, 12);
});

test('rest cannot recover invested points; using a device releases only the points actually spent', () => {
  const funded = transferDevicePower(deviceActor(), 'owned-device', { amount: 5 }).sheet;
  const rested = rechargePowerPool(funded, '', { hours: 10 });
  assert.equal(rested.sheet.resources.powerPoints, 10); assert.equal(rested.availableMaximum, 10); assert.equal(rested.reserved, 5);
  const activated = activatePower(rested.sheet, power(), { total: 4 }, { poolId: 'device:owned-device', id: 'device-cast' });
  assert.equal(activated.spent, 3); assert.equal(activated.sheet.resources.powerPoints, 10);
  assert.equal(activated.sheet.inventory[0].data.powerPoints, 2); assert.equal(activated.sheet.inventory[0].data.allocatedPowerPoints, 2);
  assert.equal(activated.activationSkillId, 'user-device-skill'); assert.equal(activated.activePower.poolId, 'device:owned-device');
  const recovered = rechargePowerPool(activated.sheet, '', { hours: 10 });
  assert.equal(recovered.sheet.resources.powerPoints, 13);
  assert.equal(recovered.sheet.resources.powerPoints + recovered.sheet.inventory[0].data.powerPoints, 15);
  const reclaimed = transferDevicePower(recovered.sheet, 'owned-device', { amount: 2, direction: 'from-device' });
  assert.equal(reclaimed.sheet.resources.powerPoints, 15); assert.equal(reclaimed.deviceCurrent, 0);
});

test('a device never recharges from rest or Bennies; personal Benny recharge respects reserved capacity', () => {
  const funded = transferDevicePower(deviceActor(), 'owned-device', { amount: 5 }).sheet;
  assert.equal(rechargePowerPool(funded, 'device:owned-device').error, 'device-does-not-recharge');
  assert.equal(rechargePowerPool(funded, 'device:owned-device', { benny: true }).error, 'device-does-not-recharge');
  const recovered = rechargePowerPool(funded, '', { benny: true });
  assert.equal(recovered.recovered, 3); assert.equal(recovered.sheet.resources.powerPoints, 10);
  assert.equal(recovered.sheet.resources.bennies, 1); assert.equal(funded.resources.bennies, 2);
});

test('device failure spends one and critical failure causes Fatigue without ending personal active powers', () => {
  const funded = transferDevicePower(deviceActor(), 'owned-device', { amount: 5 }).sheet;
  funded.activePowers = [{ id: 'personal', active: true, poolId: '' }];
  const failed = activatePower(funded, power(), { total: 3 }, { poolId: 'device:owned-device' });
  assert.equal(failed.spent, 1); assert.equal(failed.sheet.inventory[0].data.powerPoints, 4);
  assert.equal(failed.sheet.inventory[0].data.allocatedPowerPoints, 4); assert.equal(failed.sheet.resources.fatigue, 0);
  const critical = activatePower(funded, power(), { total: 1, criticalFailure: true }, { poolId: 'device:owned-device' });
  assert.equal(critical.sheet.resources.fatigue, 1); assert.equal(critical.sheet.activePowers[0].active, true);
  assert.deepEqual(critical.endedPowerIds, []); assert.equal(critical.spent, 1);
});

test('devices reject shorting and the incompatible No Power Points rule without spending or changing anything', () => {
  const funded = transferDevicePower(deviceActor(), 'owned-device', { amount: 5 }).sheet;
  assert.equal(activatePower(funded, power({ shorting: 1 }), { total: 4 }, { poolId: 'device:owned-device' }).error, 'device-cannot-short');
  assert.equal(activatePower(funded, power(), { total: 4 }, { poolId: 'device:owned-device', noPowerPoints: true }).error, 'device-incompatible-no-power-points');
  funded.rules = { noPowerPoints: true };
  assert.equal(activatePower(funded, power(), { total: 4 }, { poolId: 'device:owned-device' }).error, 'device-incompatible-no-power-points');
  assert.equal(transferDevicePower(funded, 'owned-device', { amount: 1 }).error, 'device-incompatible-no-power-points');
});

test('maintenance draws from the original device, costs per target, and releases spent allocation', () => {
  const funded = transferDevicePower(deviceActor(), 'owned-device', { amount: 5 }).sheet;
  const activated = activatePower(funded, power({ targetCount: 2 }), { total: 4 }, { poolId: 'device:owned-device', id: 'device-cast' });
  const maintained = maintainPower(activated.sheet, 'device-cast');
  assert.equal(maintained.spent, 2); assert.equal(maintained.sheet.inventory[0].data.powerPoints, 0);
  assert.equal(maintained.sheet.inventory[0].data.allocatedPowerPoints, 0); assert.equal(maintained.sheet.resources.powerPoints, 7);
  assert.equal(maintained.activePower.remainingRounds, 10);
  assert.equal(maintainPower(maintained.sheet, 'device-cast').error, 'insufficient-power-points');
});

test('transfers reject more than five, fractions, missing contact, insufficient funds and capacities, and external credits', () => {
  const before = deviceActor();
  for (const amount of [-1, 0, 6, 1.5]) assert.equal(transferDevicePower(before, 'owned-device', { amount }).error, 'invalid-transfer-amount');
  assert.equal(transferDevicePower(before, 'owned-device', { amount: 1, physicalContact: false }).error, 'physical-contact-required');
  assert.equal(transferDevicePower(deviceActor({ powerPointsMax: 2 }), 'owned-device', { amount: 3 }).error, 'device-capacity-exceeded');
  const empty = deviceActor(); empty.resources.powerPoints = 0;
  assert.equal(transferDevicePower(empty, 'owned-device', { amount: 1 }).error, 'insufficient-power-points');
  assert.equal(transferDevicePower(deviceActor({ powerPoints: 5, allocatedPowerPoints: 0 }), 'owned-device', { amount: 1, direction: 'from-device' }).error, 'insufficient-device-allocation');
  assert.equal(transferDevicePower(before, 'owned-device', { amount: 1, poolId: 'device:owned-device' }).error, 'personal-pool-required');
  assert.equal(transferDevicePower(before, 'owned-device', { amount: 1, direction: 'elsewhere' }).error, 'invalid-transfer-direction');
});

test('allocation stays attached to its personal background and never blocks or borrows from an unrelated pool', () => {
  const before = deviceActor(); before.arcanePools = [{ id: 'one', current: 8, max: 10 }, { id: 'two', current: 8, max: 10 }];
  const funded = transferDevicePower(before, 'owned-device', { amount: 5, poolId: 'one' });
  assert.equal(funded.sheet.arcanePools[0].current, 3); assert.equal(funded.sheet.arcanePools[1].current, 8);
  assert.equal(rechargePowerPool(funded.sheet, 'one', { hours: 10 }).sheet.arcanePools[0].current, 5);
  assert.equal(rechargePowerPool(funded.sheet, 'two', { hours: 10 }).sheet.arcanePools[1].current, 10);
  assert.equal(transferDevicePower(funded.sheet, 'owned-device', { amount: 1, poolId: 'two' }).error, 'device-allocation-pool-mismatch');
  assert.equal(transferDevicePower(funded.sheet, 'owned-device', { amount: 1, poolId: 'two', direction: 'from-device' }).error, 'device-allocation-pool-mismatch');
  const returned = transferDevicePower(funded.sheet, 'owned-device', { amount: 5, poolId: 'one', direction: 'from-device' });
  assert.equal(returned.sheet.arcanePools[0].current, 8); assert.equal(returned.deviceCurrent, 0);
});
