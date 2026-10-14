"""Validate source contracts, translations, packaged bytes and archive paths."""
import hashlib
import json
import zipfile

from package_tools import ROOT, validate_source


def validate(root=ROOT):
    manifest, files, _ = validate_source(root)
    path = root / 'dist' / f'gravewright-savage-worlds-{manifest["version"]}.zip'
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if path.with_suffix('.zip.sha256').read_text(encoding='utf-8').strip() != f'{digest}  {path.name}':
        raise ValueError('ZIP SHA-256 sidecar does not match')
    with zipfile.ZipFile(path) as archive:
        if archive.namelist() != sorted(files) or archive.testzip() is not None:
            raise ValueError('ZIP file list or CRC differs from source')
        for name, source in files.items():
            if archive.read(name) != source.read_bytes():
                raise ValueError(f'Packaged bytes differ from source: {name}')
        if any(name.startswith(('.', '/')) or '..' in name.split('/') or '\\' in name
               for name in archive.namelist()):
            raise ValueError('Invalid ZIP entry path')
    return {'archive': str(path), 'bytes': path.stat().st_size, 'sha256': digest, 'files': len(files)}


if __name__ == '__main__':
    print(json.dumps(validate(), indent=2))
