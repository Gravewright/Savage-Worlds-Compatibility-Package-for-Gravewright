"""Use native contracts with a memory database and isolated temporary storage."""
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch


def main():
    tests = Path(__file__).resolve().parent
    server = tests.parent
    host = Path(os.environ.get('GRAVEWRIGHT_TEST_HOST_ROOT') or server.parents[2]).resolve()
    if not (host / 'manage.py').is_file():
        raise RuntimeError('Set GRAVEWRIGHT_TEST_HOST_ROOT to a Gravewright checkout.')
    source = server.parent
    sys.path[:0] = [str(host), str(tests), str(source / 'tests')]
    with tempfile.TemporaryDirectory(prefix='swade-server-contract-') as directory:
        isolated = Path(directory)
        # Process-local settings only: no local .env is read or changed.
        os.environ.update({
            'DJANGO_SETTINGS_MODULE': 'config.settings', 'DJANGO_DEBUG': 'true',
            'GRAVEWRIGHT_DATABASE': ':memory:', 'GRAVEWRIGHT_MEDIA_ROOT': str(isolated / 'media'),
            'GRAVEWRIGHT_MODULES_ROOT': str(isolated / 'modules'),
            'GRAVEWRIGHT_CONTENT_ROOT': str(isolated / 'content'),
            'GRAVEWRIGHT_MARKETPLACE_URL': '', 'GRAVEWRIGHT_MARKETPLACE_KEYS_FILE': '',
            'GRAVEWRIGHT_REDIS_URL': '', 'GRAVEWRIGHT_SERVER_APP_PATHS': '',
            'GRAVEWRIGHT_SERVER_APPS': '', 'PYTHON_DOTENV_DISABLED': '1',
            'GRAVEWRIGHT_DJANGO_REGISTRY': str(isolated / 'modules' / 'server-apps.json'),
        })
        import json
        version = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))['version']
        archive = source / 'dist' / f'gravewright-savage-worlds-{version}.zip'
        if not archive.is_file():
            raise RuntimeError('Build the unified system ZIP with python scripts/build.py first.')
        from package_fixture import prepare_installed_system
        prepare_installed_system(host, archive)
        import django
        with patch('config.environment.load_environment', lambda *args, **kwargs: None):
            django.setup()
        from django.conf import settings
        from django.test.runner import DiscoverRunner
        # Host defaults intentionally use a file-backed TEST database; override
        # both names before the test runner is allowed to create any database.
        settings.DATABASES['default']['TEST']['NAME'] = ':memory:'
        settings.ROOT_URLCONF = 'empty_urls'
        assert settings.DATABASES['default']['NAME'] == ':memory:'
        assert settings.DATABASES['default']['TEST']['NAME'] == ':memory:'
        assert Path(settings.MEDIA_ROOT).is_relative_to(isolated)
        assert Path(settings.GRAVEWRIGHT_MODULES_ROOT).is_relative_to(isolated)
        print('Installed system ZIP; isolated database: :memory:; TEST database: :memory:; temporary media/modules; .env loading disabled')
        return DiscoverRunner(verbosity=2).run_tests(['test_contract'])


if __name__ == '__main__':
    raise SystemExit(main())
