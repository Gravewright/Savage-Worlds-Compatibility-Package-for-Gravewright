"""Native baseline contracts: the released host needs no system-specific patch."""
from copy import deepcopy
import os
from pathlib import Path
import uuid
import zipfile

from django.conf import settings
from django.test import TestCase, override_settings

from gravewright.accounts.models import User
from gravewright.actors.models import Actor
from gravewright.campaigns.catalog import list_rulesets
from gravewright.campaigns.models import Campaign, Membership
from gravewright.combat.models import Encounter
from gravewright.maps.models import Scene
from gravewright.modules.frontend import invoke
from gravewright.modules.packages import ModuleFailure, host
from gravewright.tokens.models import Token


class ReleasedHostContractTests(TestCase):
    def setUp(self):
        self.directory = Path(settings.GRAVEWRIGHT_MODULES_ROOT) / uuid.uuid4().hex[:6]
        self.override = override_settings(GRAVEWRIGHT_MODULES_ROOT=self.directory)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.engine = host()
        self.archive = Path(os.environ['SWADE_TEST_ARCHIVE'])
        self.manifest = self.engine.install_local(self.archive.read_bytes(), expected_type='system')
        self.gm = User.objects.create_user('owner@swade.test', 'test-password', role='owner')
        self.player = User.objects.create_user('player@swade.test', 'test-password')
        self.campaign = Campaign.objects.create(owner=self.gm, name='Original host', system=self.manifest['id'])
        Membership.objects.create(campaign=self.campaign, user=self.gm, role='gm')
        Membership.objects.create(campaign=self.campaign, user=self.player, role='player')

    def test_one_system_installs_without_any_server_selection(self):
        from config.marketplace_apps import selections
        self.assertNotIn('django', self.manifest)
        self.assertFalse(self.manifest['system']['combat']['requiresProvider'])
        self.assertEqual(selections(self.directory), {})
        self.assertNotIn('gravewright_swade', __import__('sys').modules)
        with zipfile.ZipFile(self.archive) as archive:
            self.assertFalse(any(name.endswith(('.py', '.pyc', '.pyd')) for name in archive.namelist()))
        descriptor = next(row for row in list_rulesets() if row['systemId'] == self.manifest['id'])
        self.assertEqual(descriptor['title'], self.manifest['name'])

    def test_selected_system_exposes_browser_runtime_and_native_assets(self):
        state = self.engine.configure(self.campaign.pk,
            {self.manifest['id']: self.manifest['version']}, {}, '0')
        self.assertEqual(len(state['modules']), 1)
        descriptor = state['modules'][0]
        self.assertEqual(descriptor['entry'], self.manifest['entry'])
        self.client.force_login(self.gm)
        response = self.client.get(descriptor['baseUrl'] + descriptor['entry'])
        self.assertEqual(response.status_code, 200)
        raw = b''.join(response.streaming_content) if response.streaming else response.content
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(raw, archive.read(descriptor['entry']))
        denied = self.client.get(descriptor['baseUrl'] + 'gravewright_swade/combat.py')
        self.assertEqual(denied.status_code, 404)

    def test_native_combat_allows_gm_without_loading_system_python(self):
        scene = Scene.objects.create(campaign=self.campaign, name='Native encounter', width=100, height=100)
        original = {'effects': [{'id': 'authored', 'data': {'active': True, 'remaining': 3}}]}
        actor = Actor.objects.create(campaign=self.campaign, name='Authored actor', type='character', data=deepcopy(original))
        first = Token.objects.create(scene=scene, actor=actor, linked=True)
        second = Token.objects.create(scene=scene, actor=actor, linked=True)
        encounter = Encounter.objects.create(scene=scene, active=True, round=1,
            combatants=[{'tokenId': str(first.pk)}, {'tokenId': str(second.pk)}])
        payload = {'sceneId': str(scene.pk), 'version': encounter.version}
        result = invoke(self.campaign.pk, self.gm.pk, 'combat', 'nextTurn', payload, uuid.uuid4())
        self.assertEqual(result['turn'], 1)
        actor.refresh_from_db()
        self.assertEqual(actor.data, original, 'Duration changes belong to the package browser operation')
        encounter.refresh_from_db()
        with self.assertRaises(ModuleFailure) as denied:
            invoke(self.campaign.pk, self.player.pk, 'combat', 'nextTurn',
                   {'sceneId': str(scene.pk), 'version': encounter.version}, uuid.uuid4())
        # Native document authorization may mask unavailable actors as not_found.
        self.assertIn(denied.exception.code, {'permission_denied', 'not_found'})
        encounter.refresh_from_db()
        self.assertEqual(encounter.turn, 1)
        actor.refresh_from_db()
        self.assertEqual(actor.data, original)
