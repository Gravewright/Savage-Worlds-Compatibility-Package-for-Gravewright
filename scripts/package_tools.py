"""Shared, standard-library-only checks for the original blank-sheet package."""
import ast
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ID = 'gravewright.savage-worlds'
RUNTIME_DIRECTORIES = {'assets', 'locales'}
RUNTIME_SUFFIXES = {'.js', '.css', '.json', '.md', '.txt', '.svg', '.png', '.webp'}
EXCLUDED_ROOT_FILES = {'package.json', 'package-lock.json'}
RUNTIME_ROOT_DATA = {'manifest.json', 'locales.json', 'LICENSE.md', 'NOTICE.md', 'README.md', 'README.pt-BR.md'}
ITEM_TYPES = {'weapon', 'armor', 'equipment', 'consumable', 'skill', 'edge',
              'hindrance', 'ancestry', 'racial-feature', 'power', 'effect','vehicle','arcane-device'}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def checked_file(path, root):
    root = root.resolve()
    if not path.resolve().is_relative_to(root) or not path.is_file():
        raise ValueError(f'Package file is missing or outside its source: {path}')
    for candidate in (path, *path.parents):
        if candidate == root:
            break
        if candidate.is_symlink() or (hasattr(candidate, 'is_junction') and candidate.is_junction()):
            raise ValueError(f'Package files cannot be links: {path}')
    return path


def runtime_files(root=ROOT):
    root = root.resolve()
    selected = []
    for path in root.iterdir():
        if path.name in RUNTIME_DIRECTORIES:
            if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
                raise ValueError(f'Package directories cannot be links: {path.name}')
            selected.extend(p for p in path.rglob('*') if p.is_file())
        elif path.is_file() and (path.suffix in {'.js', '.css'} or path.name in RUNTIME_ROOT_DATA):
            selected.append(path)
    files = {}
    for path in sorted(selected):
        relative = path.relative_to(root)
        if (path.suffix not in RUNTIME_SUFFIXES or path.name in EXCLUDED_ROOT_FILES
                or any(part.startswith('.') for part in relative.parts)):
            continue
        files[relative.as_posix()] = checked_file(path, root)
    server = root / 'server' / 'gravewright_swade'
    checked_file(server / '__init__.py', root)
    for path in sorted(server.rglob('*.py')):
        relative = path.relative_to(server)
        if any(part.startswith('.') or part == '__pycache__' for part in relative.parts):
            continue
        files[(Path('gravewright_swade') / relative).as_posix()] = checked_file(path, root)
    if len(files) != len({name.casefold() for name in files}):
        raise ValueError('Package has paths that differ only in case')
    return files


def load_locales(root=ROOT):
    catalogs = {locale: read_json(root / 'locales' / f'{locale}.json')
                for locale in ('en', 'pt-BR', 'es')}
    keys = set(catalogs['en'])
    placeholder = re.compile(r'\{([A-Za-z_][A-Za-z0-9_.]*|\d+)\}')
    for locale, messages in catalogs.items():
        if set(messages) != keys:
            raise ValueError(f'Translation keys differ in {locale}')
        for key, value in messages.items():
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f'Empty or invalid translation: {locale}/{key}')
            if sorted(placeholder.findall(value)) != sorted(placeholder.findall(catalogs['en'][key])):
                raise ValueError(f'Translation placeholders differ: {locale}/{key}')
    return catalogs


def validate_source(root=ROOT, *, require_runtime=True):
    root = root.resolve()
    manifest = read_json(root / 'manifest.json')
    package = read_json(root / 'package.json')
    if manifest['id'] != PACKAGE_ID or manifest['version'] != package['version']:
        raise ValueError('Package identity or version mismatch')
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', manifest['version']):
        raise ValueError('Use a three-component numeric version')
    if manifest['sdk'] != {'requires': '>=1.0.0 <2.0.0', 'tested': '1.0.0'}:
        raise ValueError('Unexpected SDK contract')
    system = manifest['system']
    if [row['id'] for row in system['actorTypes']] != ['character', 'npc']:
        raise ValueError('This package declares character and npc actor types')
    ids = [row['id'] for row in system['itemTypes']]
    if set(ids) != ITEM_TYPES or len(ids) != len(ITEM_TYPES):
        raise ValueError('Item templates do not match the package contract')
    if 'content' in manifest:
        raise ValueError('The system contains structures and automation, never compendiums')
    if manifest.get('django') != {'apps': ['gravewright_swade.apps.SwadeConfig'],
                                  'replaces': ['gravewright.savage-worlds.rules']}:
        raise ValueError('The system must contain its own dependency-free server automation')
    if system.get('combat') != {'formula':'0','manualInput':'number','showRoll':False,'requiresProvider':True}:
        raise ValueError('SWADE owns card initiative and requires its bundled server provider')
    catalogs = load_locales(root)
    for descriptor in [*system['actorTypes'], *system['itemTypes']]:
        if not re.fullmatch(r'[a-z][a-z0-9_-]*', descriptor['id']):
            raise ValueError('Native type IDs must be lowercase')
        if descriptor.get('labelKey') not in catalogs['en']:
            raise ValueError(f'Missing document type translation: {descriptor["id"]}')
    files = runtime_files(root)
    required = {'manifest.json', 'model.js', 'LICENSE.md', 'NOTICE.md',
                'gravewright_swade/__init__.py', 'gravewright_swade/apps.py',
                'gravewright_swade/combat.py'}
    if require_runtime:
        required |= {'main.js', 'sheet.js', 'item-editor.js', 'styles.css', 'locales.json'}
    if not required <= files.keys():
        raise ValueError(f'Missing package files: {sorted(required - files.keys())}')
    if require_runtime and read_json(root / 'locales.json') != catalogs:
        raise ValueError('Rebuild locales.json after editing translations')
    for name, path in files.items():
        if path.suffix == '.py':
            ast.parse(path.read_text(encoding='utf-8'), filename=name)
    package_tree = ast.parse(files['gravewright_swade/__init__.py'].read_text(encoding='utf-8'))
    versions = [node.value.value for node in package_tree.body
                if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == '__version__' for target in node.targets)
                and isinstance(node.value, ast.Constant)]
    if versions != [manifest['version']]:
        raise ValueError('Bundled server automation and system versions must match')
    for name, path in files.items():
        if path.suffix != '.js':
            continue
        javascript = path.read_text(encoding='utf-8-sig')
        for key in re.findall(r'\bt\(\s*[\'\"]([^\'\"]+)[\'\"]', javascript):
            if key not in catalogs['en']:
                raise ValueError(f'Missing interface translation in {name}: {key}')
        # The package must remain self-contained and dependency-free at runtime.
        imports = re.findall(r'(?:\bfrom\s*|\bimport\s*\(?\s*)[\'\"]([^\'\"]+)[\'\"]', javascript)
        for imported in imports:
            if not imported.startswith('./') and not imported.startswith('../'):
                raise ValueError(f'External runtime import in {name}: {imported}')
            resolved = (path.parent / imported).resolve()
            checked_file(resolved, root)
            if resolved.relative_to(root).as_posix() not in files:
                raise ValueError(f'Runtime import is not packaged: {name} -> {imported}')
    return manifest, files, catalogs
