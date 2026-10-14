"""Build the separate deterministic Django ZIP without importing Django."""
from datetime import datetime, timezone
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def build(root=ROOT):
    root = Path(root).resolve()
    server = root / 'server'
    manifest = json.loads((server / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('id') != 'gravewright.savage-worlds.rules' or not re.fullmatch(r'\d+\.\d+\.\d+', manifest.get('version', '')):
        raise ValueError('Invalid server package identity or version')
    if manifest.get('django') != {'apps': ['gravewright_swade.apps.SwadeConfig']} or any(key in manifest for key in ('entry', 'system', 'locales')):
        raise ValueError('The server package must declare only its isolated Django app')
    files = {name: server / name for name in ('manifest.json', 'README.md', 'LICENSE.md', 'NOTICE.md')}
    for path in (server / 'gravewright_swade').rglob('*.py'):
        files[path.relative_to(server).as_posix()] = path
    if 'gravewright_swade/__init__.py' not in files or 'gravewright_swade/apps.py' not in files:
        raise ValueError('The Django app is missing')
    package_tree = ast.parse(files['gravewright_swade/__init__.py'].read_text(encoding='utf-8'))
    package_versions = [
        node.value.value
        for node in package_tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == '__version__' for target in node.targets)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    ]
    if package_versions != [manifest['version']]:
        raise ValueError('The Django app version must match the server manifest')
    for path in files.values():
        if not path.resolve().is_relative_to(server.resolve()) or not path.is_file() or any(parent.is_symlink() for parent in (path, *path.parents) if parent != root):
            raise ValueError('Package files must remain inside the server source')
        if path.suffix == '.py':
            ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    output = root / 'dist'
    output.mkdir(exist_ok=True)
    target = output / f'gravewright-savage-worlds-rules-{manifest["version"]}.zip'
    moment = datetime.fromtimestamp(int(os.environ.get('SOURCE_DATE_EPOCH', '1791849600')), timezone.utc)
    if not 1980 <= moment.year <= 2107:
        raise ValueError('SOURCE_DATE_EPOCH is outside the ZIP timestamp range')
    descriptor, name = tempfile.mkstemp(prefix='.swade-server-', suffix='.zip', dir=output)
    os.close(descriptor)
    staged = Path(name)
    try:
        with zipfile.ZipFile(staged, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, path in sorted(files.items()):
                info = zipfile.ZipInfo(name, moment.timetuple()[:6]); info.create_system = 3; info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        with zipfile.ZipFile(staged) as archive:
            if archive.testzip() is not None:
                raise ValueError('Server package CRC verification failed')
        staged.replace(target)
    finally:
        staged.unlink(missing_ok=True)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n', encoding='utf-8', newline='\n')
    return {'archive': str(target), 'bytes': target.stat().st_size, 'sha256': digest, 'files': len(files)}


if __name__ == '__main__':
    print(json.dumps(build(), indent=2))
