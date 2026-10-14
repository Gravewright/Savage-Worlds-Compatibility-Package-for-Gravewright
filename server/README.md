# Savage Worlds Compatibility Package for Gravewright — Server Rules

Release: **0.1.0**. Requires **Gravewright VTT 0.2.3 or newer** and the
**Savage Worlds Compatibility Package for Gravewright 0.1.0** browser package.
This version identifies the separate Django companion; existing releases and
tags of other Savage Worlds compatibility packages keep their own numbering.

This free technical compatibility package has the identifier
`gravewright.savage-worlds.rules`. The browser package owns sheets, rolls and
user-authored content. This app registers only the
`gravewright.savage-worlds` combat provider; it has no models, migrations, routes,
catalogs, random rolls or additional dependencies.

The package does not redistribute rulebook text, official illustrations,
setting material, PDFs or compendiums. Its original code and documentation are
licensed under MIT. Savage Worlds names, trademarks and associated logos are
excluded from that license; see [NOTICE.md](NOTICE.md).

Install its ZIP in **Modules → Install from ZIP**, then activate the Django server
package through the native activation button. Activation requires the managed
Runner or `main.py` and restarts the host. Installing the browser system alone
does not execute Python or enable these clocks. No `.env` change is required.

Temporary states use `statusClocks.distracted` and `statusClocks.vulnerable` with
`remaining`, `phase`, `owner` and `awaitingStart`. A newly applied next-turn state
uses `{remaining: 1, phase: 'end', owner: 'self', awaitingStart: true}`. Its owner's
next start arms expiration; that turn's end clears the state and its clock.

Configured effects retain their descriptive `effects[].data.duration` text.
Their separate clock uses `active: true`, integer `remaining` from 0 to 10000,
`phase: 'start' | 'end' | 'round'`, and `owner: 'self' | 'source'`. Source clocks
identify `sourceTokenId` or `sourceActorId`; round clocks expire at the end of a
round. Expiration sets `active: false` and keeps the user-authored effect.

`activePowers[]` entries with positive `durationRounds` and integer
`remainingRounds` advance at their owner's turn end, including maintained powers.
Maintenance and resource costs remain UI actions. A null remaining value or
nonpositive duration has no automatic clock. Expiration deactivates the entry
without removing it.

Skipped turns advance explicit clocks. Linked actor documents tick once per
native command through `event.clockKeys`; independent token snapshots have their
own keys. The native host retains permissions, retries, revisions and rollback.

Build: `python scripts/build_server.py` from the browser source root. Pure tests:
`python -m unittest discover -s server/tests -p test_clocks.py`. The separate
`server/tests/run_django_tests.py` runner uses an in-memory database and temporary
media/module directories, without reading the production `.env`.

This game references the Savage Worlds game system, available from Pinnacle Entertainment Group at www.peginc.com. Savage Worlds and all associated logos and trademarks are copyrights of Pinnacle Entertainment Group. Used with permission. Pinnacle makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.
