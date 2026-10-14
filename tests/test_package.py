"""Meaningful package checks use a temporary fixture, never the real release ZIP."""
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build import build
from package_tools import load_locales, read_json
from validate_package import validate


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='swade-package-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('manifest.json', 'package.json', 'model.js', 'LICENSE.md', 'NOTICE.md'):
            shutil.copy2(ROOT / name, self.root / name)
        shutil.copytree(ROOT / 'locales', self.root / 'locales')
        for name in ('main.js', 'sheet.js', 'item-editor.js'):
            (self.root / name).write_text('export default {};\n', encoding='utf-8')
        (self.root / 'styles.css').write_text('.swade {}\n', encoding='utf-8')

    def test_release_is_deterministic_self_contained_and_content_free(self):
        (self.root / '.env').write_text('FAKE_TEST_VALUE=not-a-secret\n', encoding='utf-8')
        (self.root / 'private-notes.json').write_text('{}\n', encoding='utf-8')
        (self.root / 'content').mkdir()
        (self.root / 'content' / 'not-a-runtime-file.json').write_text('{}\n', encoding='utf-8')
        first = build(self.root)
        second = build(self.root)
        self.assertEqual(first['sha256'], second['sha256'])
        self.assertEqual(validate(self.root)['sha256'], first['sha256'])
        with zipfile.ZipFile(first['archive']) as archive:
            self.assertIn('manifest.json', archive.namelist())
            self.assertNotIn('.env', archive.namelist())
            self.assertNotIn('private-notes.json', archive.namelist())
            self.assertNotIn('content/not-a-runtime-file.json', archive.namelist())
            self.assertNotIn('package.json', archive.namelist())
            self.assertTrue(all(not name.endswith('.py') for name in archive.namelist()))

    def test_validator_detects_source_changes_after_packaging(self):
        build(self.root)
        (self.root / 'styles.css').write_text('.swade { color: white; }\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Packaged bytes differ'):
            validate(self.root)

    def test_validator_rejects_external_runtime_imports(self):
        (self.root / 'main.js').write_text("import thing from 'third-party-package';\n", encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'External runtime import'):
            build(self.root)

    def test_locale_keys_and_format_placeholders_match(self):
        catalogs = load_locales(self.root)
        self.assertEqual(set(catalogs), {'en', 'pt-BR', 'es'})
        self.assertIn('item.type.racial-feature', catalogs['en'])
        self.assertIn('sheet.addToSheet', catalogs['pt-BR'])
        self.assertEqual(read_json(self.root / 'manifest.json')['id'], 'gravewright.savage-worlds')


if __name__ == '__main__':
    unittest.main()
