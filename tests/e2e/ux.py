"""Focused SWADE UX regression checks, using only a disposable installed package.

The suite checks authoring, library pickers, equip and modal keyboard behavior.
It intentionally does not repeat the full actor/token and eleven-template E2E.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import secrets
import subprocess

from playwright.sync_api import expect, sync_playwright

from review_server import MODULE, default_archive, host_root
from swade import close_actor, close_item, fingerprint, open_actor, open_item, read_actor, start_fixture


LABELS = json.loads((MODULE / "locales" / "pt-BR.json").read_text(encoding="utf-8"))
SCOPED_API = "**/api/tables/*/modules/gravewright.savage-worlds/api"


def modal(page, title):
    return page.locator(".gws-modal").filter(has=page.get_by_role("heading", name=title, exact=True))


def finish_modals(page):
    while page.locator(".gws-modal").count():
        count = page.locator(".gws-modal").count()
        panel = page.locator(".gws-modal").last
        done = panel.get_by_role("button", name=LABELS["common.done"], exact=True)
        if done.count() and done.is_visible():
            done.click()
        else:
            panel.locator(".gws-modal-close").click()
        page.wait_for_function("count=>document.querySelectorAll('.gws-modal').length<count", arg=count)


def assert_sheet_focus(page):
    focused = page.evaluate("!!document.activeElement?.closest('.gws-sheet')")
    diagnostic = page.evaluate("()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.tagName==='BODY'?'':document.activeElement?.textContent?.slice(0,100),modalCount:document.querySelectorAll('.gws-modal').length,saveState:document.querySelector('.gws-save-status')?.dataset.state})")
    assert focused, diagnostic


def create_form(page):
    panel = page.locator(".gws-modal").filter(has=page.locator('[data-gws-item-field="core.name"]'))
    expect(panel).to_be_visible()
    assert panel.evaluate("element=>element.tagName") == "SECTION"
    return panel


def test_ux(seed, output):
    dialogs, errors = [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        pages = {}
        for role in ("gm", "editor"):
            context = browser.new_context(viewport={"width": 1440, "height": 1050}, locale="pt-BR")
            context.add_cookies([{**seed["sessions"][role], "url": seed["base"]}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("dialog", lambda dialog: (dialogs.append({"type": dialog.type, "message": dialog.message}), dialog.dismiss()))
            page.goto(seed["base"] + "/game/" + seed["campaign"])
            page.wait_for_function("!!window.gravewrightActors && !!window.gravewrightItems")
            expect(page.locator(".game-menubar__presence")).to_have_attribute("data-presence", "seated", timeout=15000)
            pages[role] = page

        # A player who owns the actor can author a local template with an empty
        # library. The module must preserve the host's GM-only library creation.
        owner = pages["editor"]
        owner_window = open_actor(owner, seed["actor"])
        native_before = owner.evaluate("async()=>await gravewright.items.list()")
        owner_window.locator(".gws-skills > button").click()
        picker = modal(owner, LABELS["sheet.itemLibrary"])
        expect(picker.get_by_role("button", name=LABELS["sheet.createOwned"], exact=True)).to_be_visible()
        picker.get_by_role("button", name=LABELS["sheet.createOwned"], exact=True).click()
        creation = create_form(owner)
        expect(creation.locator('[data-gws-item-field="core.name"]')).to_be_focused()
        creation.locator('[data-gws-item-field="core.name"]').fill("Perícia pessoal do jogador")
        creation.locator('[data-gws-item-field="description"]').fill("Anotação pessoal local.")
        creation.locator('[data-gws-item-tab="details"]').click()
        creation.locator('[data-gws-item-field="die"]').select_option("6")
        creation.get_by_role("button", name=LABELS["sheet.createOwned"], exact=True).click()
        expect(creation).to_have_count(0)
        finish_modals(owner)
        assert_sheet_focus(owner)
        close_actor(owner_window)
        local = read_actor(owner, seed["actor"])["data"]["skills"]
        assert len(local) == 1 and local[0]["name"] == "Perícia pessoal do jogador" and local[0]["data"]["die"] == 6
        assert owner.evaluate("async()=>await gravewright.items.list()") == native_before
        assert pages["gm"].evaluate("async()=>await gravewright.items.list()") == []

        gm = pages["gm"]
        window = open_actor(gm, seed["actor"])
        sheet = window.locator(".gws-sheet")

        # Error/retry belongs inside the modal. A failed authorized read must not
        # leave an empty-looking picker or open a browser alert.
        failed_read = {"done": False}
        held_reads = []
        def fail_first_read(route):
            payload = route.request.post_data_json
            if payload.get("domain") == "items" and payload.get("method") == "state" and not failed_read["done"]:
                failed_read["done"] = True
                held_reads.append(route)
            else:
                route.continue_()
        gm.route(SCOPED_API, fail_first_read)
        sheet.locator(".gws-skills > button").click()
        picker = modal(gm, LABELS["sheet.itemLibrary"])
        expect(picker.get_by_text(LABELS["sheet.libraryLoading"], exact=True)).to_be_visible()
        assert len(held_reads) == 1
        held_reads[0].fulfill(status=503, json={"error": "unavailable"})
        expect(picker.get_by_text(LABELS["sheet.libraryError"], exact=True)).to_be_visible()
        picker.get_by_role("button", name=LABELS["common.retry"], exact=True).click()
        expect(picker.get_by_text(LABELS["sheet.noNativeItems"], exact=True)).to_be_visible()
        gm.unroute(SCOPED_API, fail_first_read)
        picker.press("Escape")
        expect(picker).to_have_count(0)
        assert_sheet_focus(gm)

        # The template type can change without losing shared authored fields.
        sheet.locator('[data-gws-tab="equipment"]').click()
        sheet.locator(".gws-body > .gws-section > button").click()
        picker = modal(gm, LABELS["sheet.itemLibrary"])
        picker.get_by_role("button", name=LABELS["sheet.createItem"], exact=True).click()
        creation = create_form(gm)
        creation.locator('[data-gws-item-field="core.name"]').fill("Equipamento pessoal de teste")
        creation.locator('[data-gws-item-field="description"]').fill("Descrição a preservar ao trocar o tipo.")
        creation.locator(".gws-modal-body > .gws-field > select").select_option("armor")
        expect(creation.locator('[data-gws-item-field="core.name"]')).to_have_value("Equipamento pessoal de teste")
        expect(creation.locator('[data-gws-item-field="description"]')).to_have_value("Descrição a preservar ao trocar o tipo.")

        # Fail saving the owned copy after the native library item has already
        # been created. Retrying must reuse both documents instead of duplicating.
        write_probe = {"failed": False, "creates": 0}
        def fail_first_actor_save(route):
            payload = route.request.post_data_json
            if payload.get("domain") == "items" and payload.get("method") == "create":
                write_probe["creates"] += 1
                route.continue_()
            elif payload.get("domain") == "actors" and payload.get("method") == "saveSheet" and not write_probe["failed"]:
                write_probe["failed"] = True
                route.fulfill(status=503, json={"error": "unavailable"})
            else:
                route.continue_()
        gm.route(SCOPED_API, fail_first_actor_save)
        creation.get_by_role("button", name=LABELS["sheet.createAndAdd"], exact=True).click()
        expect(creation.get_by_text(LABELS["sheet.createError"], exact=True)).to_be_visible()
        assert len(gm.evaluate("async()=>await gravewright.items.list()")) == 1
        creation.get_by_role("button", name=LABELS["common.retry"], exact=True).click()
        expect(creation).to_have_count(0)
        finish_modals(gm)
        gm.unroute(SCOPED_API, fail_first_actor_save)
        assert write_probe == {"failed": True, "creates": 1}, write_probe
        assert len(gm.evaluate("async()=>await gravewright.items.list()")) == 1
        assert len(read_actor(gm, seed["actor"])["data"]["inventory"]) == 1

        native = gm.evaluate("async()=>await gravewright.items.create({name:'Árvore pessoal de teste',type:'weapon',data:{description:'Texto pessoal'}})")
        sheet.locator(".gws-body > .gws-section > button").click()
        picker = modal(gm, LABELS["sheet.itemLibrary"])
        search = picker.locator('input[type="search"]')
        expect(search).to_be_focused()
        search.fill("arvore")
        row = picker.locator(".gws-picker-row").filter(has_text="Árvore pessoal de teste")
        expect(row).to_have_count(1)
        type_filter = picker.locator(".gws-toolbar select")
        type_filter.select_option("armor")
        expect(picker.get_by_text(LABELS["sheet.noSearchResults"], exact=True)).to_be_visible()
        type_filter.select_option("weapon")
        expect(row).to_have_count(1)
        row.get_by_role("button", name=LABELS["sheet.addToSheet"], exact=True).click()
        expect(picker).to_be_visible()
        expect(row.get_by_role("button", name=LABELS["sheet.addCopy"], exact=True)).to_be_visible()
        first = [entry for entry in read_actor(gm, seed["actor"])["data"]["inventory"] if entry["sourceId"] == native["id"]]
        assert len(first) == 1
        row.get_by_role("button", name=LABELS["sheet.addCopy"], exact=True).click()
        picker.get_by_role("button", name=LABELS["common.done"], exact=True).click()
        expect(picker).to_have_count(0)
        assert_sheet_focus(gm)
        copies = [entry for entry in read_actor(gm, seed["actor"])["data"]["inventory"] if entry["sourceId"] == native["id"]]
        assert len(copies) == 2 and copies[0]["id"] != copies[1]["id"]

        sheet.locator('[data-gws-tab="overview"]').click()
        sheet.locator(".gws-equipped .gws-section-actions button").first.click()
        equip = modal(gm, LABELS["sheet.equip"])
        expect(equip).to_be_visible()
        expect(sheet.locator('[data-gws-panel="overview"]')).to_be_visible()
        equip.get_by_role("button", name=LABELS["sheet.equip"], exact=True).first.click()
        finish_modals(gm)
        assert any(entry["equipped"] for entry in read_actor(gm, seed["actor"])["data"]["inventory"])
        assert_sheet_focus(gm)

        # Closing a copied item returns keyboard focus to its replacement row.
        sheet.locator(".gws-skills [data-entry-id] .gws-link").click()
        embedded = gm.locator(".gws-modal").last
        embedded.locator('[data-gws-item-field="description"]').fill("Nova anotação somente na cópia.")
        embedded.locator(".gws-modal-close").click()
        expect(embedded).to_have_count(0)
        assert_sheet_focus(gm)
        focused_row = gm.evaluate("()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.slice(0,100),tab:document.activeElement?.dataset.gwsTab,entry:document.activeElement?.closest('[data-entry-id]')?.dataset.entryId})")
        assert "Perícia pessoal do jogador" in (focused_row["text"] or ""), focused_row
        gm.screenshot(path=str(output / "ux-desktop.png"))

        # The native item template supports readable prose and inline validation
        # without opening a browser dialog or persisting an invalid image URL.
        native_armor = next(item for item in gm.evaluate("async()=>await gravewright.items.list()") if item["type"] == "armor")
        item_window = open_item(gm, native_armor["id"])
        item_window.get_by_role("button", name=LABELS["item.preview"], exact=True).click()
        expect(item_window.locator(".gws-item-prose").first).to_have_text("Descrição a preservar ao trocar o tipo.")
        item_window.get_by_role("button", name=LABELS["item.editText"], exact=True).click()
        item_window.locator('[data-gws-item-tab="details"]').click()
        image = item_window.locator('[data-gws-item-field="img"]')
        image.fill("ftp://example.invalid/test.png")
        image.blur()
        expect(image).to_have_attribute("aria-invalid", "true")
        expect(item_window.get_by_text(LABELS["item.imageInvalid"], exact=True)).to_be_visible()
        image.fill("")
        image.blur()
        expect(image).to_have_attribute("aria-invalid", "false")
        item_window.locator('[data-gws-item-field="quantity"]').fill("2")
        item_window.locator('[data-gws-item-tab="description"]').click()
        item_window.screenshot(path=str(output / "ux-native-template.png"))
        close_item(item_window)
        assert gm.evaluate("async id=>(await gravewright.items.get(id)).data.quantity", native_armor["id"]) == 2

        gm.set_viewport_size({"width": 390, "height": 1000})
        window.evaluate("element=>Object.assign(element.style,{left:'8px',right:'auto',width:'374px',maxWidth:'calc(100vw - 16px)',minWidth:'0'})")
        sheet.locator(".gws-skills > button").click()
        picker = modal(gm, LABELS["sheet.itemLibrary"])
        expect(picker).to_be_visible()
        expect(picker.get_by_text(LABELS["sheet.noNativeItems"], exact=True)).to_be_visible()
        bounds = picker.evaluate("element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth,client:element.clientWidth,scroll:element.scrollWidth};}")
        assert bounds["left"] >= 0 and bounds["right"] <= bounds["viewport"] + 1 and bounds["scroll"] <= bounds["client"] + 1, bounds
        gm.screenshot(path=str(output / "ux-mobile-picker.png"))
        finish_modals(gm)
        close_actor(window)
        assert gm.locator("dialog").count() == 0
        assert not dialogs, dialogs
        assert not errors, errors
        browser.close()
    return {"passed": True, "ownedCreation": True, "preserveDraft": True, "retryWithoutDuplicates": True,
        "pickerRetrySearchCopies": True, "equipModal": True, "keyboardFocus": True, "nativeTemplate": True, "nativeDialogs": 0,
        "mobile": bounds, "output": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-root")
    parser.add_argument("--archive", type=Path, default=default_archive())
    args = parser.parse_args()
    root = host_root(args.host_root)
    output = root / "test-results" / "swade-ux-regression" / secrets.token_hex(8)
    output.mkdir(parents=True)
    original_env = fingerprint(root / ".env")
    server = log = None
    try:
        server, log, seed = start_fixture(root, output, args.archive.resolve(), 30019)
        result = test_ux(seed, output)
        result["archiveSha256"] = fingerprint(args.archive.resolve())
        (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False), flush=True)
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
        assert fingerprint(root / ".env") == original_env


if __name__ == "__main__":
    main()
