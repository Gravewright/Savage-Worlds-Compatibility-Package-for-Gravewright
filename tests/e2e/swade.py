"""End-to-end SWADE sheets using the actual installed ZIP and native host APIs.

Run from the host checkout after building the module::

    uv run --locked python data/swade-source/tests/e2e/swade.py

The test starts its own disposable localhost fixture. Pass --seed to reuse an
explicitly started review_server.py instance. No .env or existing table is edited.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from urllib.request import ProxyHandler, build_opener
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright

from review_server import MODULE, default_archive, host_root


COLLECTIONS = {
    "weapon": "inventory", "armor": "inventory", "equipment": "inventory", "consumable": "inventory",
    "skill": "skills", "edge": "edges", "hindrance": "hindrances", "ancestry": "ancestries",
    "racial-feature": "racialFeatures", "power": "powers", "effect": "effects",
}


def fingerprint(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def start_fixture(root: Path, output: Path, archive: Path, port: int, *, with_card_deck: bool = False,
                  translator_zip: Path | None = None):
    seed_path = output / "seed.json"
    log = (output / "server.log").open("w", encoding="utf-8")
    fixture = output / "fixture"
    if os.name == 'nt':
        # Deep host checkouts can push extracted package assets past Windows'
        # ordinary 260-character file API limit. Keep review reports where the
        # caller requested them, but select a short isolated data directory.
        with ZipFile(archive) as package:
            manifest = json.loads(package.read('manifest.json'))
            package_root = fixture.resolve() / 'modules/packages' / manifest['id'] / manifest['version'] / fingerprint(archive)
            if any(len(str(package_root / name)) >= 260 for name in package.namelist()):
                fixture = Path(tempfile.gettempdir()) / f'gw-swade-{secrets.token_hex(8)}'
    command = [sys.executable, "-X", "utf8", str(Path(__file__).with_name("review_server.py")),
        "--host-root", str(root), "--archive", str(archive), "--fixture", str(fixture),
        "--seed", str(seed_path), "--port", str(port)]
    if with_card_deck:
        command.append('--with-card-deck')
    if translator_zip:
        command.extend(['--translator-zip', str(translator_zip.resolve())])
    server = subprocess.Popen(command, cwd=root, stdout=log, stderr=log)
    localhost = build_opener(ProxyHandler({}))
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError(f"Review server exited; inspect {output / 'server.log'}")
            if seed_path.exists():
                seed = json.loads(seed_path.read_text(encoding="utf-8"))
                try:
                    with localhost.open(seed["base"] + "/api/auth/status", timeout=1) as response:
                        if response.status == 200:
                            return server, log, seed
                except OSError:
                    pass
            time.sleep(0.1)
        raise RuntimeError(f"Review server did not become ready; inspect {output / 'server.log'}")
    except BaseException:
        server.terminate()
        server.wait(timeout=10)
        log.close()
        raise


def read_actor(page, actor_id: str, token_id: str | None = None):
    return page.evaluate("async ({id,token}) => await gravewright.actors.sheet(id,token ? {tokenId:token} : {})", {"id": actor_id, "token": token_id})


def open_actor(page, actor_id: str):
    page.evaluate("id => window.gravewrightActors.open(id)", actor_id)
    window = page.locator(f'.actor-directory__sheet[data-actor-id="{actor_id}"]')
    expect(window.locator(".gws-sheet")).to_be_visible()
    return window


def close_actor(window):
    window.locator('[data-window="close"]').click()
    expect(window).to_have_count(0)


def open_item(page, item_id: str):
    page.evaluate("async id => await window.gravewrightItems.open(id)", item_id)
    window = page.locator(f'.item-sheet[data-item-id="{item_id}"]')
    expect(window.locator(".gws-sheet")).to_be_visible()
    return window


def close_item(window):
    # Call the actual modal's normal close method. This triggers and awaits the
    # same gravewright:sheet-flush event as Escape or its native close button.
    window.evaluate("element => element.close()")
    expect(window).to_have_count(0)


def drop_item(page, window, item_id: str, table_id: str):
    transfer = page.evaluate_handle("({id,tableId})=>{const transfer=new DataTransfer();transfer.setData('application/x-gravewright-item',JSON.stringify({id,tableId}));return transfer;}", {"id": item_id, "tableId": table_id})
    target = window.locator(".gws-sheet")
    target.dispatch_event("dragover", {"dataTransfer": transfer})
    target.dispatch_event("drop", {"dataTransfer": transfer})
    transfer.dispose()


def test_sheets(seed: dict, output: Path) -> dict:
    actor_id = seed["actor"]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        errors = []
        contexts = {}
        pages = {}
        for role in ("gm", "reader"):
            context = browser.new_context(viewport={"width": 1500, "height": 1080}, locale="pt-BR")
            context.add_cookies([{**seed["sessions"][role], "url": seed["base"]}])
            # Select the host's private module catalog locale without installing
            # remote translators or replacing any host UI catalog.
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(seed["base"] + "/game/" + seed["campaign"])
            page.wait_for_function("!!window.gravewrightActors && !!window.gravewrightItems && !!window.gravewright")
            expect(page.locator(".game-menubar__presence")).to_have_attribute("data-presence", "seated", timeout=15000)
            contexts[role] = context
            pages[role] = page
        page = pages["gm"]

        # Both creation paths use the authenticated public host API and registered types.
        created = page.evaluate("async()=>await gravewright.actors.create({name:'Outro personagem de teste',type:'character',data:{notes:'Anotação pessoal de teste'}})")
        assert read_actor(page, created["id"])["data"]["notes"] == "Anotação pessoal de teste"
        npc = page.evaluate("async()=>await gravewright.actors.create({name:'NPC de teste',type:'npc',data:{}})")
        expect(page.locator("#actors-panel").get_by_text("NPC de teste", exact=True)).to_have_count(1)
        npc_window = open_actor(page, npc["id"])
        expect(npc_window.locator(".gws-attribute")).to_have_count(5)
        close_actor(npc_window)
        window = open_actor(page, actor_id)
        sheet = window.locator(".gws-sheet")
        expect(sheet.locator(".gws-attribute")).to_have_count(5)
        expect(sheet.locator('[data-resource="wounds"] .gws-pip')).to_have_count(3)
        expect(sheet.locator('[data-resource="fatigue"] .gws-pip')).to_have_count(2)
        expect(window.locator(".pdf-sheet__tabs")).to_have_count(0)
        sheet.locator('[data-gws-path="identity.concept"]').fill("Conceito pessoal de teste")
        sheet.locator('[data-resource="wounds"] .gws-pip').nth(1).click()
        sheet.locator('[data-resource="fatigue"] .gws-pip').first.click()
        # Close immediately: persistence must include debounced edits and counters.
        close_actor(window)
        saved = read_actor(page, actor_id)
        assert saved["data"]["identity"]["concept"] == "Conceito pessoal de teste"
        assert saved["data"]["resources"]["wounds"] == 2
        assert saved["data"]["resources"]["fatigue"] == 1

        window = open_actor(page, actor_id)
        sheet = window.locator(".gws-sheet")
        expect(sheet.locator('[data-gws-path="identity.concept"]')).to_have_value("Conceito pessoal de teste")
        for tab in ("equipment", "features", "powers", "notes", "overview"):
            sheet.locator(f'[data-gws-tab="{tab}"]').click()
            expect(sheet.locator(f'[data-gws-panel="{tab}"]')).to_be_visible()
        sheet.locator('[data-gws-tab="notes"]').click()
        sheet.locator('[data-gws-path="notes"]').fill("Nota escrita para verificar a persistência.")
        close_actor(window)
        assert read_actor(page, actor_id)["data"]["notes"] == "Nota escrita para verificar a persistência."

        item_ids = {}
        for item_type in COLLECTIONS:
            document = page.evaluate("""async ({type,reader})=>await gravewright.items.create({
                name:'Item de teste · '+type,type,
                data:{description:'Texto pessoal de teste',probe:{nested:{value:'original'}}},
                permissions:{[reader]:'read'}
            })""", {"type": item_type, "reader": seed["users"]["reader"]})
            item_ids[item_type] = document["id"]
            item_window = open_item(page, document["id"])
            item_window.locator('[data-gws-item-field="description"]').fill("Anotação pessoal de teste · " + item_type)
            item_window.locator('[data-gws-item-tab="details"]').click()
            expect(item_window.locator('[data-gws-item-tab="details"]')).to_have_attribute("aria-selected", "true")
            if item_type == "weapon":
                item_window.locator('[data-gws-item-field="damage"]').fill("Expressão pessoal de teste")
            item_window.locator('[data-gws-item-tab="description"]').click()
            expect(item_window.locator('[data-gws-item-tab="description"]')).to_have_attribute("aria-selected", "true")
            close_item(item_window)
            persisted = page.evaluate("async id=>await gravewright.items.get(id)", document["id"])
            assert persisted["data"]["description"] == "Anotação pessoal de teste · " + item_type
            assert persisted["data"]["probe"]["nested"]["value"] == "original"
            if item_type == "weapon":
                assert persisted["data"]["damage"] == "Expressão pessoal de teste"

        window = open_actor(page, actor_id)
        for item_id in item_ids.values():
            drop_item(page, window, item_id, seed["campaign"])
        # The close lifecycle must drain asynchronous authenticated reads and the
        # drop queue before releasing its module context.
        close_actor(window)
        owned = read_actor(page, actor_id)["data"]
        for item_type, collection in COLLECTIONS.items():
            matches = [entry for entry in owned[collection] if entry["type"] == item_type]
            assert len(matches) == 1, (item_type, matches)
            assert matches[0]["sourceId"] == item_ids[item_type]
            assert matches[0]["id"] != item_ids[item_type]
            assert matches[0]["data"]["probe"]["nested"]["value"] == "original"

        # A later source edit must not mutate the independently embedded copy.
        page.evaluate("""async id=>{
            const item=await gravewright.items.get(id);
            item.data.probe.nested.value='source changed';
            await gravewright.items.update({id,version:item.version,name:item.name,data:item.data});
        }""", item_ids["weapon"])
        assert read_actor(page, actor_id)["data"]["inventory"][0]["data"]["probe"]["nested"]["value"] == "original"
        assert len(page.evaluate("async()=>await gravewright.items.list()")) == len(COLLECTIONS)

        window = open_actor(page, actor_id)
        sheet = window.locator(".gws-sheet")
        sheet.locator('[data-gws-tab="equipment"]').click()
        weapon = next(entry for entry in owned["inventory"] if entry["type"] == "weapon")
        row = sheet.locator(f'[data-entry-id="{weapon["id"]}"]')
        row.locator('input[type="checkbox"]').first.check()
        close_actor(window)
        equipped = next(entry for entry in read_actor(page, actor_id)["data"]["inventory"] if entry["id"] == weapon["id"])
        assert equipped["equipped"] is True

        # Exercise the player's actual empty-library authoring flow: create a
        # personal skill template and immediately add an owned copy to the sheet.
        window = open_actor(page, actor_id)
        sheet = window.locator(".gws-sheet")
        sheet.locator(".gws-skills > button").click()
        library = page.locator(".gws-modal").last
        library.get_by_role("button", name="Criar item", exact=True).click()
        creation = page.locator('.gws-modal').filter(has=page.locator('[data-gws-item-field="core.name"]'))
        expect(creation).to_be_visible()
        creation.locator('[data-gws-item-field="core.name"]').fill("Perícia pessoal de teste")
        creation.locator('[data-gws-item-field="description"]').fill("Descrição pessoal criada no teste.")
        creation.locator('[data-gws-item-tab="details"]').click()
        creation.locator('[data-gws-item-field="die"]').select_option("6")
        creation.get_by_role("button", name="Criar e adicionar à ficha", exact=True).click()
        expect(creation).to_have_count(0)
        if page.locator(".gws-modal").count():
            page.locator(".gws-modal").last.get_by_role("button", name="Concluir", exact=True).click()
        expect(page.locator(".gws-modal")).to_have_count(0)
        personal = next(item for item in page.evaluate("async()=>await gravewright.items.list()") if item["name"] == "Perícia pessoal de teste")
        assert personal["data"]["die"] == 6
        personal_copy = next(entry for entry in read_actor(page, actor_id)["data"]["skills"] if entry["sourceId"] == personal["id"])
        personal_row = sheet.locator(f'[data-entry-id="{personal_copy["id"]}"]')
        personal_row.locator(".gws-link").click()
        embedded = page.locator(".gws-modal").last
        embedded.locator('[data-gws-item-field="description"]').fill("Descrição alterada somente na cópia.")
        embedded.locator(".gws-modal-close").click()
        expect(page.locator(".gws-modal")).to_have_count(0)
        close_actor(window)
        edited_copy = next(entry for entry in read_actor(page, actor_id)["data"]["skills"] if entry["id"] == personal_copy["id"])
        assert edited_copy["data"]["description"] == "Descrição alterada somente na cópia."
        original = page.evaluate("async id=>await gravewright.items.get(id)", personal["id"])
        assert original["data"]["description"] == "Descrição pessoal criada no teste."
        assert len(page.evaluate("async()=>await gravewright.items.list()")) == len(COLLECTIONS) + 1

        # Independent tokens reuse the system sheet while keeping their own data.
        page.get_by_role("button", name="Token: Cópia independente de teste", exact=True).press("Enter")
        token_window = page.locator(f'.token-sheet[data-token-id="{seed["snapshotToken"]}"]')
        expect(token_window.locator(".gws-sheet")).to_be_visible()
        token_window.locator('[data-gws-path="identity.concept"]').fill("Mudança somente na cópia")
        close_actor(token_window)
        assert read_actor(page, actor_id, seed["snapshotToken"])["data"]["identity"]["concept"] == "Mudança somente na cópia"
        assert read_actor(page, actor_id)["data"]["identity"]["concept"] == "Conceito pessoal de teste"
        assert read_actor(page, actor_id, seed["linkedToken"])["data"]["identity"]["concept"] == "Conceito pessoal de teste"

        reader = pages["reader"]
        reader_window = open_actor(reader, actor_id)
        expect(reader_window.locator('[data-gws-path="identity.concept"]')).to_have_value("Conceito pessoal de teste")
        assert reader_window.locator('[data-gws-path]').evaluate_all("elements=>elements.every(element=>element.disabled || element.readOnly)")
        assert reader_window.locator('.gws-pip').evaluate_all("elements=>elements.every(element=>element.disabled)")
        before = read_actor(reader, actor_id)
        drop_item(reader, reader_window, item_ids["weapon"], seed["campaign"])
        close_actor(reader_window)
        assert read_actor(reader, actor_id)["data"] == before["data"]
        denied = reader.evaluate("""async id=>{
            const view=await gravewright.actors.sheet(id);
            try {await gravewright.actors.saveSheet({actorId:id,name:view.name,version:view.version,sheetVersion:view.sheetVersion,data:{...view.data,notes:'Tentativa de teste'}});return null;}
            catch(error){return error.code;}
        }""", actor_id)
        # The native actor service deliberately masks an edit-denied document
        # as not_found; both codes reject the write under the public contract.
        assert denied in {"permission_denied", "not_found"}, denied
        assert read_actor(reader, actor_id)["data"] == before["data"]
        item_window = open_item(reader, item_ids["weapon"])
        assert item_window.locator('[data-gws-item-field="description"]').evaluate("element=>element.readOnly || element.disabled")
        close_item(item_window)

        window = open_actor(page, actor_id)
        window.locator('[data-gws-tab="overview"]').click()
        page.screenshot(path=str(output / "swade-sheet-overview.png"))
        window.locator('[data-gws-tab="equipment"]').click()
        page.screenshot(path=str(output / "swade-sheet-equipment.png"))
        close_actor(window)
        item_window = open_item(page, item_ids["weapon"])
        page.screenshot(path=str(output / "swade-item-template.png"))
        close_item(item_window)
        assert not errors, errors
        browser.close()
    return {"passed": True, "itemTypes": len(COLLECTIONS), "persistence": True, "dropCopies": True,
        "libraryCreation": True, "ownedEditing": True,
        "readonly": True, "independentTokens": True, "screenshots": str(output)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-root")
    parser.add_argument("--archive", type=Path, default=default_archive())
    parser.add_argument("--seed", type=Path)
    parser.add_argument("--port", type=int, default=30019)
    args = parser.parse_args()
    root = host_root(args.host_root)
    output = root / "test-results" / "swade" / secrets.token_hex(8)
    output.mkdir(parents=True)
    env_before = fingerprint(root / ".env")
    server = log = None
    try:
        if args.seed:
            seed = json.loads(args.seed.read_text(encoding="utf-8"))
            assert seed.get("kind") == "swade-isolated-review", "Use a disposable review_server.py fixture."
            assert seed["package"]["id"] == "gravewright.savage-worlds", "The supplied fixture must use SWADE."
            assert Path(seed["fixture"]).resolve() != (root / "data").resolve()
        else:
            server, log, seed = start_fixture(root, output, args.archive.resolve(), args.port)
        print(json.dumps(test_sheets(seed, output), ensure_ascii=False), flush=True)
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        if log is not None:
            log.close()
        assert fingerprint(root / ".env") == env_before, "The host .env changed during the test."


if __name__ == "__main__":
    main()
