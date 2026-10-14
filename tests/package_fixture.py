"""Prepare a real installed system for isolated tests before Django startup.

The short-lived bootstrap process writes the same verified activation plan used
by the managed Runner. The subsequent test process loads Python from the package
archive, never from this repository's server source directory. Native activation
authorization and managed restarts are covered by the host's own integration tests.
"""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile


def prepare_installed_system(host, archive, *, legacy_companion=False):
    environment = {**os.environ, 'PYTHON_DOTENV_DISABLED': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                   'GRAVEWRIGHT_SERVER_APPS': '', 'GRAVEWRIGHT_SERVER_APP_PATHS': ''}
    command = [sys.executable, '-B', '-X', 'utf8', str(Path(__file__).resolve()),
               str(Path(host).resolve()), str(Path(archive).resolve())]
    if legacy_companion:
        command.append('--legacy-companion')
    subprocess.run(command,
                   env=environment, cwd=host, check=True)


def main():
    host, archive = map(lambda value: Path(value).resolve(), sys.argv[1:3])
    legacy_companion = '--legacy-companion' in sys.argv[3:]
    sys.path.insert(0, str(host))
    import django
    django.setup()
    from django.core.management import call_command
    from gravewright.modules.packages import host as package_host
    from gravewright.modules.server_apps import plan
    from config.marketplace_apps import registry_path
    from scripts.update_supervisor import write
    call_command('migrate', verbosity=0, interactive=False)
    engine = package_host()
    if legacy_companion:
        # Reproduce the published companion's shape with synthetic fixture
        # metadata. Nothing here becomes part of the distributed system ZIP.
        with zipfile.ZipFile(archive) as package:
            unified = json.loads(package.read('manifest.json'))
            legacy = {key: unified[key] for key in
                      ('name', 'description', 'author', 'license', 'sdk')}
            legacy.update({'id': unified['django']['replaces'][0], 'version': '0.1.0',
                           'django': {'apps': unified['django']['apps']}})
            raw = io.BytesIO()
            with zipfile.ZipFile(raw, 'w') as output:
                output.writestr('manifest.json', json.dumps(legacy))
                for name in package.namelist():
                    if name.startswith('gravewright_swade/') and name.endswith('.py'):
                        content = package.read(name)
                        if name == 'gravewright_swade/__init__.py':
                            content = content.replace(unified['version'].encode(), b'0.1.0')
                        output.writestr(name, content)
        previous = engine.install_local(raw.getvalue(), expected_type='module')
        write(registry_path(engine.directory), plan(previous['id'], previous['version'], True))
    installed = engine.install_local(archive.read_bytes(), expected_type='system')
    selected = plan(installed['id'], installed['version'], True)
    if set(selected) != {installed['id']}:
        raise RuntimeError('The fixture must activate only its one system package')
    write(registry_path(engine.directory), selected)
    if legacy_companion:
        from gravewright.modules.models import Package
        if not Package.objects.filter(module_id=previous['id'], version=previous['version']).exists():
            raise RuntimeError('Legacy archive identity must remain available for rollback')
    print(json.dumps({'installedSystem': installed['id'], 'version': installed['version'],
                      'bundledServerApps': selected[installed['id']]['django']['apps']}), flush=True)


if __name__ == '__main__':
    main()
