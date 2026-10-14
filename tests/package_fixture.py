"""Install the browser system into isolated released-VTT fixtures.

Only an explicit migration scenario seeds the historical server-only companion.
That fixture is built from archived source, never from the current system ZIP.
The current system neither registers Python apps nor changes their activation.
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
    call_command('migrate', verbosity=0, interactive=False)
    engine = package_host()
    if legacy_companion:
        # Reproduce the published companion's shape with synthetic fixture
        # metadata. Nothing here becomes part of the distributed system ZIP.
        from gravewright.modules.server_apps import plan
        from config.marketplace_apps import registry_path
        from scripts.update_supervisor import write
        with zipfile.ZipFile(archive) as package:
            current = json.loads(package.read('manifest.json'))
        legacy = {key: current[key] for key in ('name', 'description', 'author', 'license', 'sdk')}
        legacy.update({'id': 'gravewright.savage-worlds.rules', 'version': '0.1.0',
                       'django': {'apps': ['gravewright_swade.apps.SwadeConfig']}})
        raw = io.BytesIO()
        historical = Path(__file__).resolve().parents[1] / 'server' / 'gravewright_swade'
        with zipfile.ZipFile(raw, 'w') as output:
            output.writestr('manifest.json', json.dumps(legacy))
            for source in sorted(historical.rglob('*.py')):
                if '__pycache__' in source.parts:
                    continue
                content = source.read_bytes()
                if source.name == '__init__.py':
                    content = content.replace(current['version'].encode(), b'0.1.0')
                output.writestr('gravewright_swade/' + source.relative_to(historical).as_posix(), content)
        previous = engine.install_local(raw.getvalue(), expected_type='module')
        write(registry_path(engine.directory), plan(previous['id'], previous['version'], True))
    installed = engine.install_local(archive.read_bytes(), expected_type='system')
    if 'django' in installed or not installed.get('entry'):
        raise RuntimeError('The current system fixture must contain only browser runtime')
    if legacy_companion:
        from gravewright.modules.models import Package
        if not Package.objects.filter(module_id=previous['id'], version=previous['version']).exists():
            raise RuntimeError('Legacy archive identity must remain available for rollback')
    print(json.dumps({'installedSystem': installed['id'], 'version': installed['version'],
                      'browserOnly': True, 'legacyCompanion': legacy_companion}), flush=True)


if __name__ == '__main__':
    main()
