from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gravewright_swade.combat import advance_effects


def event(**changes):
    return {'phase': 'end', 'roundBoundary': False, 'isCurrent': True,
            'periodic': True, 'tokenId': 'source-token', 'actorId': 'source-actor',
            'documentKey': ('actor', 'owner'), 'clockKeys': set(), **changes}


def effect(**changes):
    return {'id': 'user-effect', 'name': 'User text', 'data': {
        'active': True, 'remaining': 2, 'phase': 'end', 'owner': 'self',
        'duration': 'User-authored duration', 'description': 'Keep this text', **changes}}


class ClockTests(unittest.TestCase):
    def test_owner_clocks_expire_without_removing_authored_text(self):
        data = {'effects': [effect(remaining=1)], 'unknown': {'retained': True}}
        self.assertFalse(advance_effects(data, event(isCurrent=False)))
        self.assertTrue(advance_effects(data, event()))
        self.assertEqual(data['effects'][0]['data']['remaining'], 0)
        self.assertFalse(data['effects'][0]['data']['active'])
        self.assertEqual(data['effects'][0]['data']['duration'], 'User-authored duration')
        self.assertEqual(data['unknown'], {'retained': True})
        self.assertFalse(advance_effects(data, event()))

    def test_round_and_source_token_clocks_are_explicit(self):
        data = {'effects': [effect(phase='round'), effect(owner='source', sourceTokenId='caster')]}
        self.assertFalse(advance_effects(data, event(isCurrent=False)))
        self.assertTrue(advance_effects(data, event(isCurrent=False, tokenId='caster')))
        self.assertEqual(data['effects'][1]['data']['remaining'], 1)
        self.assertTrue(advance_effects(data, event(roundBoundary=True, isCurrent=False)))
        self.assertEqual(data['effects'][0]['data']['remaining'], 1)

    def test_same_actor_clock_ticks_once_in_a_shared_native_command(self):
        data = {'effects': [effect()], 'activePowers': [{'active': True, 'durationRounds': 3, 'remainingRounds': 3}]}
        first = event(); self.assertTrue(advance_effects(data, first))
        self.assertFalse(advance_effects(data, {**first, 'tokenId': 'other-linked-token'}))
        self.assertEqual(data['effects'][0]['data']['remaining'], 1)
        self.assertEqual(data['activePowers'][0]['remainingRounds'], 2)
        independent = deepcopy(data)
        self.assertTrue(advance_effects(independent, {**first, 'documentKey': ('token', 'independent')}))
        self.assertEqual(independent['activePowers'][0]['remainingRounds'], 1)

    def test_new_temporary_state_waits_for_the_next_owner_start_then_end(self):
        data = {'status': {'distracted': True, 'vulnerable': True, 'shaken': True},
                'statusClocks': {name: {'remaining': 1, 'phase': 'end', 'owner': 'self', 'awaitingStart': True}
                                 for name in ('distracted', 'vulnerable')}}
        self.assertFalse(advance_effects(data, event()))
        self.assertFalse(advance_effects(data, event(phase='start', isCurrent=False)))
        self.assertTrue(advance_effects(data, event(phase='start')))
        self.assertTrue(data['status']['distracted'])
        self.assertTrue(advance_effects(data, event()))
        self.assertEqual(data['statusClocks'], {})
        self.assertEqual(data['status'], {'distracted': False, 'vulnerable': False, 'shaken': True})

    def test_skipped_turns_advance_clocks_without_actions_or_random_rolls(self):
        data = {'effects': [effect()], 'status': {'vulnerable': True},
                'statusClocks': {'vulnerable': {'remaining': 1, 'phase': 'end', 'awaitingStart': False}}}
        self.assertTrue(advance_effects(data, event(periodic=False)))
        self.assertEqual(data['effects'][0]['data']['remaining'], 1)
        self.assertFalse(data['status']['vulnerable'])

    def test_maintained_powers_tick_and_manual_durations_remain_unchanged(self):
        data = {'activePowers': [
            {'active': True, 'maintained': True, 'durationRounds': 3, 'remainingRounds': 1},
            {'active': True, 'durationRounds': 0, 'remainingRounds': 0},
            {'active': True, 'maintained': True, 'durationRounds': 3, 'remainingRounds': None}],
            'resources': {'powerPoints': 9}}
        self.assertTrue(advance_effects(data, event()))
        self.assertFalse(data['activePowers'][0]['active'])
        self.assertTrue(data['activePowers'][1]['active'])
        self.assertIsNone(data['activePowers'][2]['remainingRounds'])
        self.assertEqual(data['resources']['powerPoints'], 9)

    def test_card_round_boundary_defers_the_old_first_actor_start_until_the_tracker_sorts(self):
        data = {'combat': {'cardInitiative': True}, 'effects': [effect(phase='start')],
                'status': {'distracted': True}, 'statusClocks': {'distracted': {'remaining': 1, 'phase': 'end', 'awaitingStart': True}}}
        before = deepcopy(data)
        self.assertFalse(advance_effects(data, event(phase='start', roundBoundary=True)))
        self.assertEqual(data, before)
        self.assertTrue(advance_effects(data, event(phase='start', roundBoundary=False)))
        self.assertFalse(data['statusClocks']['distracted']['awaitingStart'])
        self.assertEqual(data['effects'][0]['data']['remaining'], 1)

    def test_narrative_durations_and_malformed_clocks_have_no_side_effects(self):
        for remaining in [None, True, -1, 1.5, 'many', float('inf'), 10001]:
            with self.subTest(remaining=remaining):
                data = {'effects': [effect(remaining=remaining)]}; before = deepcopy(data)
                self.assertFalse(advance_effects(data, event())); self.assertEqual(data, before)
        data = {'effects': [{'data': {'active': True, 'duration': 'Until sunset'}}]}
        self.assertFalse(advance_effects(data, event()))
        self.assertFalse(advance_effects(data, event(phase='backward')))

    def test_manual_shaken_or_stunned_state_cancels_hold_even_at_a_card_boundary(self):
        for state in ('shaken', 'stunned', 'incapacitated'):
            data = {'combat': {'cardInitiative': True}, 'status': {'holding': True, state: True}}
            self.assertTrue(advance_effects(data, event(phase='start', roundBoundary=True)))
            self.assertFalse(data['status']['holding'])


if __name__ == '__main__':
    unittest.main()
