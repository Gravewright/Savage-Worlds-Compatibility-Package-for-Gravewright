"""Exercise identical clock events through the Python and JavaScript providers."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gravewright_swade.combat import advance_effects


class ClockParityTests(unittest.TestCase):
    def test_python_and_javascript_providers_follow_the_same_event_sequence(self):
        source = Path(__file__).resolve().parents[2]
        host = source.parents[1]
        embedded = host / '.venv/Lib/site-packages/playwright/driver/node.exe'
        node = str(embedded) if embedded.is_file() else shutil.which('node')
        if not node:
            self.skipTest('Node is required for cross-runtime parity checks')
        cases = []
        for phase, boundary, current, skip in [('start', True, True, False), ('start', False, True, False), ('end', False, True, True), ('end', True, False, False), ('start', False, False, False)]:
            cases.append({'sheet': {
                'combat': {'cardInitiative': True}, 'status': {'distracted': True, 'vulnerable': True, 'holding': True, 'shaken': True},
                'statusClocks': {'distracted': {'remaining': 1, 'phase': 'end', 'owner': 'self', 'awaitingStart': True},
                                 'vulnerable': {'remaining': 1, 'phase': 'end', 'owner': 'self', 'awaitingStart': False}},
                'effects': [{'data': {'active': True, 'remaining': 2, 'phase': 'start', 'owner': 'source', 'sourceActorId': 'caster', 'duration': 'Authored'}},
                            {'data': {'active': True, 'remaining': 2, 'phase': 'round'}},
                            {'data': {'active': True, 'remaining': '0x10', 'phase': 'end'}}],
                'activePowers': [{'active': True, 'durationRounds': 3, 'remainingRounds': 1, 'maintained': True},
                                 {'active': True, 'durationRounds': 0, 'remainingRounds': None}]},
                'event': {'phase': phase, 'roundBoundary': boundary, 'isCurrent': current, 'periodic': not skip,
                          'actorId': 'caster', 'tokenId': 'caster-token', 'documentKey': ['actor', 'owner']}})
        expected = []
        for case in cases:
            sheet, event = deepcopy(case['sheet']), deepcopy(case['event'])
            event['documentKey'] = tuple(event['documentKey']); event['clockKeys'] = set()
            changed = advance_effects(sheet, event)
            second = advance_effects(sheet, event)
            expected.append({'sheet': sheet, 'changed': changed, 'secondChanged': second})
        javascript = """import {advanceClocks} from './clocks.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const output=JSON.parse(input).map(({sheet,event})=>{event.clockKeys=new Set();const first=advanceClocks(sheet,event);
return {...first,secondChanged:advanceClocks(first.sheet,event).changed};});console.log(JSON.stringify(output));"""
        result = subprocess.run([node, '--input-type=module', '-e', javascript], input=json.dumps(cases),
                                text=True, encoding='utf-8', cwd=source, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), expected)


if __name__ == '__main__':
    unittest.main()
