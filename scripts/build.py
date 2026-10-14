"""Build one deterministic browser system ZIP for released Gravewright hosts."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile

from package_tools import ROOT, load_locales, validate_source


def build(root=ROOT):
    root = Path(root).resolve()
    catalogs = load_locales(root)
    (root / 'locales.json').write_text(json.dumps(catalogs, ensure_ascii=False, separators=(',', ':')) + '\n',
                                      encoding='utf-8', newline='\n')
    manifest, files, _ = validate_source(root)
    output = root / 'dist'
    output.mkdir(exist_ok=True)
    target = output / f'gravewright-savage-worlds-{manifest["version"]}.zip'
    moment = datetime.fromtimestamp(int(os.environ.get('SOURCE_DATE_EPOCH', '1791849600')), timezone.utc)
    if not 1980 <= moment.year <= 2107:
        raise ValueError('SOURCE_DATE_EPOCH is outside the ZIP timestamp range')
    descriptor, temporary_name = tempfile.mkstemp(prefix='.swade-package-', suffix='.zip', dir=output)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, path in sorted(files.items()):
                info = zipfile.ZipInfo(name, moment.timetuple()[:6])
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError('Package CRC verification failed')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n', encoding='utf-8', newline='\n')
    return {'archive': str(target), 'bytes': target.stat().st_size, 'sha256': digest, 'files': len(files)}


if __name__ == '__main__':
    print(json.dumps(build(), indent=2))
