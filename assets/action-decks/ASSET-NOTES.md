# Original action-card assets

Three complete decks follow the approved Gravewright design directions:

- `ivory` — Clássico marfim: ivory, burgundy and engraved royal figures.
- `gravewright` — Gravewright escuro: charcoal, pale gold and crimson.
- `adventure` — Gravura de aventura: parchment and adventure engravings.

Every theme contains 52 distinct ordinary fronts, two distinct Joker fronts, one
back, and an eight-card preview. Fronts and backs are 600 × 900 WebP images;
previews are 1440 × 1120, with gallery names and counts rendered outside the
bitmap through Translator. `catalogue.json` contains package-relative asset paths
and native-compatible card names, including `★ 1` and `★ 2`.

All illustrations are newly generated original royal/jester portraits. Indices,
suit signs, exact pip layouts, mirrored composition, borders, ornamental backs
and previews are rendered by the package's own Canvas builder. These playing-card
assets contain no official Savage Worlds or third-party deck assets, logos,
game text or content catalogues. These files are static art assets; runtime deck creation still
uses the host's native card APIs after the user selects an import.

Source illustrations and the approved boards are preserved separately under
`output/imagegen/swade-action-deck`. Reproduction scripts and validations live
in `scripts/cards` within the source package.
