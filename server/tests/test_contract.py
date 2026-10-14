from copy import deepcopy
from pathlib import Path
import json
import shutil
import tempfile
import uuid
import zipfile
import sys

from django.apps import apps
from django.test import TestCase

from gravewright.accounts.models import User
from gravewright.actors.models import Actor
from gravewright.campaigns.models import Campaign, Membership
from gravewright.combat import effects, providers
from gravewright.combat.models import Encounter
from gravewright.maps.models import Scene
from gravewright.maps.services import MapError
from gravewright.table import domain
from gravewright.tokens.models import Token
from gravewright_swade import SYSTEM_ID
from gravewright_swade.combat import advance_effects


def sheet(remaining=3):
    return {'effects': [{'id': 'authored', 'data': {'active': True, 'remaining': remaining,
            'phase': 'end', 'owner': 'self', 'duration': 'User duration'}}]}


class NativeContractTests(TestCase):
    def setUp(self):
        self.gm = User.objects.create_user(email='swade-owner@example.test', password='test-password', role='owner')
        self.player = User.objects.create_user(email='swade-player@example.test', password='test-password')
        self.campaign = Campaign.objects.create(owner=self.gm, name='Isolated clock test', system=SYSTEM_ID)
        Membership.objects.create(campaign=self.campaign, user=self.gm, role='gm')
        Membership.objects.create(campaign=self.campaign, user=self.player, role='player')
        self.scene = Scene.objects.create(campaign=self.campaign, name='Isolated encounter', width=100, height=100)
        self.actor = Actor.objects.create(campaign=self.campaign, name='Authored actor', type='character', data=sheet())
        self.first = Token.objects.create(scene=self.scene, actor=self.actor, linked=True)
        self.second = Token.objects.create(scene=self.scene, actor=self.actor, linked=True)
        self.independent = Token.objects.create(scene=self.scene, actor=self.actor, linked=False, snapshot=sheet(5))
        self.encounter = Encounter.objects.create(scene=self.scene, active=True, round=1, combatants=[
            {'tokenId': str(self.first.pk)}, {'tokenId': str(self.second.pk)}, {'tokenId': str(self.independent.pk)}])

    def test_ready_registers_only_the_package_provider(self):
        self.assertIs(providers.get(SYSTEM_ID).advance_effects, advance_effects)
        self.assertIsNone(providers.get(SYSTEM_ID).prepare_initiative)
        self.assertIsNone(providers.get('another.publisher'))
        apps.get_app_config('gravewright_swade').ready()
        self.assertIs(providers.get(SYSTEM_ID).advance_effects, advance_effects)

    def test_native_document_dispatch_deduplicates_linked_tokens_and_isolates_snapshots(self):
        keys = set()
        effects.advance(self.encounter, 'end', self.encounter.combatants[0], ticked=keys)
        effects.advance(self.encounter, 'end', self.encounter.combatants[1], ticked=keys)
        effects.advance(self.encounter, 'end', self.encounter.combatants[2], ticked=keys)
        self.actor.refresh_from_db(); self.independent.refresh_from_db()
        self.assertEqual(self.actor.data['effects'][0]['data']['remaining'], 2)
        self.assertEqual(self.independent.snapshot['effects'][0]['data']['remaining'], 4)
        self.assertEqual(self.actor.sheet_version, 2)
        self.assertEqual(self.independent.sheet_version, 2)

    def test_native_receipt_retries_do_not_tick_twice_and_permissions_still_apply(self):
        payload = {'sceneId': str(self.scene.pk), 'version': self.encounter.version}
        request = uuid.uuid4()
        first = domain.command(self.campaign.pk, self.gm.pk, 'combat', 'next', payload, request)
        second = domain.command(self.campaign.pk, self.gm.pk, 'combat', 'next', payload, request)
        self.assertEqual(first['encounterId'], second['encounterId'])
        self.actor.refresh_from_db()
        self.assertEqual(self.actor.data['effects'][0]['data']['remaining'], 2)
        self.encounter.refresh_from_db()
        with self.assertRaises(MapError):
            domain.command(self.campaign.pk, self.player.pk, 'combat', 'next',
                           {'sceneId': str(self.scene.pk), 'version': self.encounter.version}, uuid.uuid4())
        self.actor.refresh_from_db()
        self.assertEqual(self.actor.data['effects'][0]['data']['remaining'], 2)

    def test_other_systems_are_untouched(self):
        self.campaign.system = 'another.publisher'; self.campaign.save()
        before = deepcopy(self.actor.data)
        effects.advance(self.encounter, 'end', self.encounter.combatants[0], ticked=set())
        self.actor.refresh_from_db(); self.assertEqual(self.actor.data, before)

    def test_one_system_archive_installs_browser_and_server_without_extra_requirements(self):
        from gravewright.modules.packages import ModulePackages
        source = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(source / 'scripts'))
        from build import build
        with tempfile.TemporaryDirectory() as directory:
            isolated = Path(directory)
            fixture_source = isolated / 'source'
            shutil.copytree(source, fixture_source, ignore=shutil.ignore_patterns(
                '.git', 'dist', 'node_modules', '__pycache__', '*.pyc', '.env*'))
            result = build(fixture_source)
            with zipfile.ZipFile(result['archive']) as archive:
                self.assertTrue({'manifest.json', 'main.js', 'locales.json',
                    'gravewright_swade/__init__.py', 'gravewright_swade/apps.py',
                    'gravewright_swade/combat.py'} <= set(archive.namelist()))
                self.assertFalse(any(name.startswith(('scripts/', 'tests/', 'server/'))
                                     for name in archive.namelist()))
                notice = archive.read('NOTICE.md').decode('utf-8')
                required_notice = (
                    'This game references the Savage Worlds game system, available from '
                    'Pinnacle Entertainment Group at www.peginc.com. Savage Worlds and '
                    'all associated logos and trademarks are copyrights of Pinnacle '
                    'Entertainment Group. Used with permission. Pinnacle makes no '
                    'representation or warranty as to the quality, viability, or '
                    'suitability for purpose of this product.'
                )
                self.assertIn(required_notice, notice)
                self.assertIn(required_notice, archive.read('README.md').decode('utf-8'))
                self.assertEqual(json.loads(archive.read('manifest.json'))['version'], '0.1.1')
            store = ModulePackages(isolated / 'modules', keys={})
            installed = store.install_local(Path(result['archive']).read_bytes(), expected_type='system')
        self.assertEqual(installed['id'], SYSTEM_ID)
        self.assertEqual(installed['name'], 'Savage Worlds Compatibility Package for Gravewright')
        self.assertEqual(installed['django']['apps'], ['gravewright_swade.apps.SwadeConfig'])
        self.assertEqual(installed['entry'], 'main.js')
        self.assertIn('system', installed)
        self.assertNotIn('requirements', installed['django'])

    def test_clock_provider_is_loaded_from_the_installed_system_zip(self):
        import gravewright_swade
        from django.conf import settings
        from gravewright.modules.packages import package_type
        from config.marketplace_apps import selections
        module_root = Path(settings.GRAVEWRIGHT_MODULES_ROOT)
        self.assertTrue(Path(gravewright_swade.__file__).resolve().is_relative_to(module_root))
        self.assertEqual(package_type({'entry': 'main.js', 'system': {},
                        'django': {'apps': ['gravewright_swade.apps.SwadeConfig']}}), 'system')
        active = selections(module_root)
        self.assertEqual(set(active), {SYSTEM_ID})
        self.assertEqual(active[SYSTEM_ID]['version'], '0.1.1')
