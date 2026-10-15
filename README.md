# Savage Worlds Compatibility Package for Gravewright

![Savage Worlds Fan Product](assets/branding/savage-worlds-logo.png)

[Português](README.pt-BR.md)

**`gravewright.savage-worlds` 0.1.2** for Gravewright VTT 0.2.3,
reviewed against the revised 2026 Brazilian SWADE edition. The horizontal header, five tabs and VTT
palette remain. System models, UI and numerical rules live in this project;
the host supplies only generic document, dice, card, combat and modal contracts.

Collections and descriptions start empty. No reference PDF, rulebook descriptions,
setting, characters, catalogs or compendiums are distributed. The only official
image included is the unchanged logo supplied for use with permission.
Users author content and configure its mechanical effects.

This package remains free and provides technical compatibility. Pinnacle's names,
trademarks and logo are excluded from the MIT license for the original code.

This game references the Savage Worlds game system, available from Pinnacle Entertainment Group at www.peginc.com. Savage Worlds and all associated logos and trademarks are copyrights of Pinnacle Entertainment Group. Used with permission. Pinnacle makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.

## Installation

Works with the published [Gravewright **0.2.3**](https://github.com/Gravewright/gravewright/releases/tag/v0.2.3),
SDK **1.0.0** and its translation API. All runtime code belongs to this browser system.

Install from the signed Gravewright Marketplace under **Systems**, or download
the ZIP and SHA-256 sidecar from the
[0.1.2 release](https://github.com/Gravewright/Savage-Worlds-Compatibility-Package-for-Gravewright/releases/tag/v0.1.2).
Build this source with `python scripts/build.py`.

1. Install `dist/gravewright-savage-worlds-0.1.2.zip` under **Systems**.
2. Select **Savage Worlds Compatibility Package for Gravewright 0.1.2** for the
   table. Existing tables must explicitly select the new package version.
3. As GM, open **Extensions → Savage Worlds → Customize** and select or create
   the table's native action deck.

Unpublished local review builds are consolidated into this release. If another
local 0.1.2 is already installed, first switch affected tables to another
installed version, remove that local build with native package management, then
install the public 0.1.2. The host preserves immutable ID/version pairs and will
reject different bytes for an installed pair. Higher local review versions need
manual selection of 0.1.2 rather than an automatic update.

One system package contains sheets, item templates, settings, translations,
card artwork and duration automation. Package ID, sheet data and table settings
remain in their original namespace.

If the earlier Server Rules companion is installed, **Customize → About → Previous installation**
lets the installation owner review and deactivate it. This existing host operation
restarts the server; removal is a separate explicit choice with a table-usage preview.
The current system requires neither that companion nor a VTT update. Existing
sheet data, settings and authored content remain in their system namespace.

Builds do not install production packages or edit `.env`. The GM advances combat
through this package's tracker using the host's existing permissions.

## Sheet spacing and legibility

All character, NPC and thirteen item templates use the same fixed spacing scale
as the host: 0, 1, 2, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56 and 64px.
Radii use 4, 8, 12 and 16px, plus pill and circle shapes. These tokens are scoped
to the package so the published VTT 0.2.3 renders them independently of newer
host styles. Interface text is at least 12px; geometry specific to a component
keeps local dimensions.

Attribute cards and collection panels follow their content instead of stretching
to match a taller neighbour. Headers, empty collections and text editors use less
vertical space. Conditions occupy a separate strip. Textareas remain resizable and scroll long authored content;
item facts wrap inside narrow windows. No sheet data or numerical rules change.

The actor header gives the name its own space; system branding remains in the
footer. Pace uses a side-view boot icon. Wound and Fatigue controls display their
base penalties, with extra wound slots retaining the existing maximum penalty
of −3 and their individual accessible level labels. Attribute columns and empty
collections avoid nested frames. The action bar prioritizes a trait test and
keeps damage accessible, while running, rest, fatigue and the other actions open
through the existing native **Actions** modal. Permissions, saves and rule
calculations use their existing handlers.

### Roll windows and skills

Rule and roll windows start at the height their controls require and group fields
and action buttons more closely. They retain native movement, resizing, focus,
Escape and smaller-screen scrolling, with interface text of at least 12px.

Skill tables and skill choices sort alphabetically by their displayed name using
the active language. Authored names remain unchanged, and sorting does not
rearrange saved collections. Each skill row exposes its linked attribute selector.
Changing the link saves only that attribute: the skill keeps its own die and
modifier. Subsequent rolls use the current link for applicable attribute effects
and penalties, including when the skill was edited without reopening the sheet.
In narrow sections, each skill groups its labelled controls below its name and
actions. After a roll, focus follows the next available action when the original
button is hidden or disabled.

The Playwright density scenario opens every registered document type and every
tab with empty, populated and long synthetic content at desktop, intermediate
and narrow widths. It also checks embedded item editors and reading previews.
Run `python tests/e2e/sheet_density.py --help` for isolated host, browser,
archive and output options.

### Items and collections

All thirteen item types use compact headers and detail groups. Empty descriptions
and notes start small; long text and controls scroll within the viewport while
native closing, movement and resizing remain available. Embedded editors and
reading previews use the same fields without repeating header facts in the
summary. Interface text remains at least 12px.

Inventory, features, powers, equipment and library rows sort by their displayed
name in the active language. Named pool, skill, modifier and power choices follow
the same order, keeping current selections, drafts, focus and checked powers.
Presentation sorting never rearranges saved collections. Skill items retain
their linked attribute selector, independent die and modifier.

The native item directory and compendium browser belong to Gravewright. Their
source improvements are separate from this system ZIP; the package continues to
work on the published VTT 0.2.3 without a host upgrade. No catalog, rulebook text
or authored content is added or changed.

## Languages through the official Translator

Install and activate [Translator](https://github.com/Gravewright/translator)
in Installed modules. In a table, open **Settings → Preferences → Interface
language** and choose **English**, **Português (Brasil)** or **Español**.
The native flow saves each participant's account preference and reloads the
same table. Integration is verified with Translator 0.1.2.

SWADE registers its labels in all three languages using `context.i18n.register`, then uses
`api.i18n.t` and `api.i18n.onChange`. Private system catalogs stay isolated from
the host and other modules. Without an active language package the host uses
English. Owned UI has `translate="no"` to avoid a second legacy translation.

Sheets, items, combat, modals and Customize translate labels, hints and feedback.
Adapter-driven language updates keep existing controls, drafts, focus, selection
and pending actions. Authored names, descriptions and data retain their original
text. The public product name, Fan Product logo and exact Pinnacle notice retain
their permitted presentation. Deck preview images contain no baked interface
titles; Translator renders their names and counters in the surrounding UI.

## System features

**Extensions → Savage Worlds → Customize** opens package-owned sections:

- **Action decks**: Ivory Classic, Gravewright Dark and Adventure Engraving.
  Each includes 52 original card fronts, two Jokers and a matching back.
  **Create and use** imports actual images and creates a native table deck.
  Import progress is persistent; repeating a choice reuses the created deck.
- **Table settings**: currency name and visibility, Power Points, wound cap,
  Joker Benny awards, wound Pace reduction and encumbrance penalties. **Save**
  shares these options with the table.
- **About**: the permitted Fan Product logo, free compatibility scope and the
  exact English permission notice supplied by Pinnacle.

Players can inspect options and browse card artwork. Only GMs change settings
or create decks. Sheets inherit table rules, with explicit character overrides.
Hiding currency or disabling PP preserves existing balances and pools. Conflicts
preserve the local draft. All SWADE configuration belongs to this package.

Characters and NPCs can represent Wild Cards or Extras. Settings cover encounter
role, Wild Die, Size, wound capacity, running, load units and manual exceptions.
Fresh sheets calculate Parry, Toughness, armor, Pace, load and Rank. Explicit
overrides take precedence; older sheets preserve entered totals and stay manual
until calculation is enabled. Armor layers, protected areas and shields are
separate; quantities, units and the Carried flag affect load.

Features group Edges, Hindrances, ancestries, racial features and user-authored
effects. Numeric modifiers never identify abilities by item name. Powers have
separate Arcane Background pools and skills, activation costs, shorting,
maintenance, duration and resting. The advancement ledger checks Rank boundaries,
available advances and attribute frequency without a rulebook list.

Arcane devices bind owned powers and have their own pool. Investing and reclaiming
PP obeys the per-action limit and preserves allocation: personal recharging cannot
recreate points still invested in a device.

Thirteen templates: `weapon`, `armor`, `equipment`, `consumable`, `skill`, `edge`,
`hindrance`, `ancestry`, `racial-feature`, `power`, `effect`, `vehicle`,
`arcane-device`. Native library documents and independent owned copies follow
host permissions.

## Rolls and combat

The native dice engine publishes rolls. The package interprets Aces, Wild Dice,
untrained and opposed rolls, successes, raises, Critical Failures and Benny
rerolls. Wounds, Fatigue, conditions, load and multi-actions contribute penalties
according to context. Attack dialogs provide situational controls; damage never
adds a Wild Die.

Incoming damage previews Toughness and armor, offers Soak before applying wounds,
and respects Extras, Wild Cards and configurable capacity. Recovery, natural
healing, stabilization, Support and Tests use explicit results. Injury and power
details and narrative choices are user-authored; no content tables are bundled.

The tracker requires a deck created and selected through the native card system.
**Customize → Action decks** creates one of the three styles and selects the
table default. An encounter keeps its deck until combat ends. Explicit choices
in **Combat → Configure deck** override the table default. GMs can also supply
their own card names and images in **Your hand → Decks → Create deck**.
For standard Action Cards, configure 52 playing cards and two Jokers; use names
such as `A ♠`, `K ♥`, `★ 1` and `★ 2`. Deck creation requires an explicit choice
in Customize. Changing an encounter's selected deck requires stopping combat.
Card previews use only the native faces available to the current viewer.
When migrating from the internal 0.3.1 prototype, explicitly select a native deck; an older automatically
created deck ID is not adopted as configuration. Every drawn Action Card needs
its own native front image.

The tracker interprets rank/suit ordering, groups, holding, extra Benny draws
and Joker bonuses from that deck. The GM deals cards and confirms **Begin round**
after extra draws. Native combat owns turns and permissions. In the **Combat**
panel, the GM adds participants and chooses **Start combat**; starting requires
at least one participant and an available selected deck. **Pause** preserves the cards,
round and current turn; **Resume** continues from that saved position.
The paused state persists across reopening the panel. **Stop combat** concludes
the encounter. The panel shows whether combat is stopped, in progress or paused.
The GM can adjust the shared Benny pool and grant one to an NPC/Extra without one.
The GM advances configured clocks through the package tracker, including skipped
turns, without automatically rolling actions or damage. Durable operation plans
and native document revisions allow interrupted work to resume without repeating
completed ticks. These document writes are recoverable steps, rather than one
transaction across every sheet. Moving backward does not undo outcomes or resources
already resolved. Automation runs while the GM uses the table; it does not run in
the background after all participants close it.

## Modals and data

Auxiliary windows use `api.ui.openModal` with `section` elements, without HTML
`dialog` tags or browser alerts. Native contracts handle focus, Escape, text
selection, nested windows and closing. Close waits for work; retries retain the
same creation, copy, published roll or application.

Autosave uses native versions. Conflicts preserve drafts until explicit review.
Host permissions remain authoritative, including the GM requirement for generated
Support effects. Linked tokens share actors; independent tokens keep their own
snapshots. Data is stored directly in sheet `data` with `schemaVersion: 2`.
Data from earlier prototypes and unknown fields are preserved. Historical Python
code under `server/` is kept only as a development reference and migration fixture;
it is excluded from the current release and is not needed to run the system.

## Validation and build

```sh
npm test
node --test scripts/cards/test_decks.mjs
python -m unittest discover -s tests -p "test_package.py"
python tests/test_item_editor_browser.py
python tests/test_modal_browser.py
python tests/test_actions_browser.py
python tests/test_customization_browser.py
python tests/e2e/languages.py
python scripts/build.py
python scripts/validate_package.py
python tests/run_host_tests.py
```

Suites in `tests/e2e` install actual ZIPs into disposable databases, media and
tables without changing `.env` or live data. The single system ZIP contains the
browser runtime, assets, local translations and licensing notices. Python code,
tools, tests and private references are excluded. The ZIP has a SHA-256 sidecar.
Original code uses [MIT](LICENSE.md); see [NOTICE.md](NOTICE.md).
