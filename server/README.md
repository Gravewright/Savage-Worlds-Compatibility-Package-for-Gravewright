# Historical server implementation

This directory is a development reference for the earlier Server Rules companion.
It is **not included** in the current 0.1.1 system ZIP and is not installed or
activated by the current system. The released Gravewright VTT **0.2.3** runs this
system's sheets, templates, settings, cards and duration rules from browser code.

`clocks.js` owns the current duration calculations. The GM's package tracker
persists operation plans and updates authorized sheet documents through native
revision checks. Recovery resumes unfinished steps; different documents do not
share one transaction, and no automation runs after every table client closes.

The archived Python source remains useful for deterministic clock comparisons
and synthetic migration fixtures. `tests/package_fixture.py --legacy-companion`
uses it only to reproduce an explicitly requested old installation in disposable
data. Native owner controls can deactivate that historical companion; the current
ZIP never activates it or includes its namespace.

Optional historical checks use `python server/tests/run_django_tests.py` with
`GRAVEWRIGHT_TEST_HOST_ROOT` pointing to the released host. These tests do not
validate the current browser automation. Release validation instead uses
`python tests/run_host_tests.py`, JavaScript suites and the native browser scenarios.

Original code and documentation use MIT; names, trademarks and the permitted
Fan Product logo remain outside that license. No rulebook text, catalogs or
proprietary content is distributed. See [NOTICE.md](../NOTICE.md).

This game references the Savage Worlds game system, available from Pinnacle Entertainment Group at www.peginc.com. Savage Worlds and all associated logos and trademarks are copyrights of Pinnacle Entertainment Group. Used with permission. Pinnacle makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.
