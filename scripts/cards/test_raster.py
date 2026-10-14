"""Read-only checks of the actual WebP pixels and native upload constraints."""
import json
from pathlib import Path
import re
import unittest

from PIL import Image

PACKAGE = Path(__file__).resolve().parents[2]
CATALOGUE = json.loads((PACKAGE / 'assets/action-decks/catalogue.json').read_text(encoding='utf-8'))
COLORS = {'ivory': {'ink': (32, 33, 30), 'red': (142, 28, 41)},
          'gravewright': {'ink': (228, 205, 153), 'red': (206, 118, 107)},
          'adventure': {'ink': (37, 35, 31), 'red': (137, 47, 40)}}


def pip_components(image, color):
    """Count substantial connected ink shapes only within the central pip area.

    The small corner suit signs and borders are outside these bounds. WebP
    compression is allowed a channel tolerance; tiny artifacts are discarded.
    No pixels or source images are modified.
    """
    pixels, width = image.load(), image.width
    points = {y * width + x for y in range(175, 736) for x in range(130, 471)
              if all(abs(pixels[x, y][i] - color[i]) <= 24 for i in range(3))}
    components = []
    while points:
        todo, area = [points.pop()], 0
        while todo:
            point = todo.pop()
            area += 1
            for neighbour in (point - 1, point + 1, point - width, point + width):
                if neighbour in points:
                    points.remove(neighbour)
                    todo.append(neighbour)
        if area >= 400:
            components.append(area)
    return components


class RasterDeckTests(unittest.TestCase):
    def test_every_catalogue_image_decodes_within_native_upload_limits(self):
        count = 0
        for theme in CATALOGUE['themes']:
            paths = [(card['front'], (600, 900)) for card in theme['cards']]
            paths += [(theme['back'], (600, 900)), (theme['preview'], (1440, 1120))]
            for asset, dimensions in paths:
                with self.subTest(asset=asset):
                    file = (PACKAGE / asset).resolve()
                    self.assertTrue(file.is_relative_to(PACKAGE.resolve()))
                    self.assertLessEqual(file.stat().st_size, 10_485_760)
                    with Image.open(file) as image:
                        image.load()
                        self.assertEqual(image.format, 'WEBP')
                        self.assertEqual(image.size, dimensions)
                        self.assertLessEqual(image.width * image.height, 16_000_000)
                        self.assertIn(image.mode, ('RGB', 'RGBA'))
                    count += 1
        self.assertEqual(count, 168)

    def test_rendered_pixels_have_exact_pip_counts_for_all_numeric_cards(self):
        count = 0
        for theme in CATALOGUE['themes']:
            for card in theme['cards']:
                match = re.fullmatch(r'(2|3|4|5|6|7|8|9|10)([♠♥♦♣])', card['name'])
                if not match:
                    continue
                rank, suit = match.groups()
                color = COLORS[theme['id']]['red' if suit in '♥♦' else 'ink']
                with self.subTest(theme=theme['id'], card=card['name']):
                    with Image.open(PACKAGE / card['front']) as image:
                        self.assertEqual(len(pip_components(image, color)), int(rank))
                count += 1
        self.assertEqual(count, 108)


if __name__ == '__main__':
    unittest.main()
