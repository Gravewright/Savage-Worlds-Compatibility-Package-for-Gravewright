"""Record actual package UX in an isolated table; never start the real Runner."""

from __future__ import annotations

import json
from pathlib import Path
import secrets
import subprocess

from playwright.sync_api import expect, sync_playwright

from review_server import MODULE, host_root
from swade import close_actor, close_item, drop_item, fingerprint, open_actor, open_item, start_fixture


FOCUS = """()=>{const e=document.activeElement;return {tag:e?.tagName,label:e?.getAttribute('aria-label'),
  text:e?.textContent?.slice(0,100),inSheet:!!e?.closest('.gws-sheet'),inModal:!!e?.closest('.gws-modal'),
  itemField:e?.dataset?.gwsItemField||null};}"""


def main():
    root = host_root()
    output = root / "test-results" / "swade-ux" / secrets.token_hex(8)
    output.mkdir(parents=True)
    archive = MODULE / "dist" / "gravewright-savage-worlds-0.2.0.zip"
    before_env = fingerprint(root / ".env")
    report = {"archiveSha256": fingerprint(archive), "dialogs": []}
    server = log = None
    try:
        server, log, seed = start_fixture(root, output, archive, 30019)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            pages = {}
            for role in ("gm", "editor"):
                context = browser.new_context(viewport={"width": 1440, "height": 1050}, locale="pt-BR")
                context.add_cookies([{**seed["sessions"][role], "url": seed["base"]}])
                context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
                page = context.new_page()
                page.on("dialog", lambda dialog: (report["dialogs"].append({"type": dialog.type, "message": dialog.message}), dialog.dismiss()))
                page.goto(seed["base"] + "/game/" + seed["campaign"])
                page.wait_for_function("!!window.gravewrightActors && !!window.gravewrightItems")
                expect(page.locator(".game-menubar__presence")).to_have_attribute("data-presence", "seated", timeout=15000)
                pages[role] = page

            gm = pages["gm"]
            window = open_actor(gm, seed["actor"])
            sheet = window.locator(".gws-sheet")
            sheet.locator(".gws-skills > button").click()
            picker = gm.locator(".gws-modal").last
            expect(picker.locator(".gws-empty")).to_be_visible()
            report["emptyGmPicker"] = {"text": picker.inner_text(), "initialFocus": gm.evaluate(FOCUS)}
            picker.screenshot(path=str(output / "empty-gm-picker.png"))
            picker.locator(".gws-modal-close").click()
            expect(gm.locator(".gws-modal")).to_have_count(0)
            report["afterPickerClose"] = gm.evaluate(FOCUS)

            owner = pages["editor"]
            owner_window = open_actor(owner, seed["actor"])
            owner_window.locator(".gws-skills > button").click()
            owner_picker = owner.locator(".gws-modal").last
            expect(owner_picker.locator(".gws-empty")).to_be_visible()
            report["emptyOwnerPicker"] = {"text": owner_picker.inner_text(), "buttons": owner_picker.locator("button").all_text_contents()}
            owner_picker.screenshot(path=str(output / "empty-owner-picker.png"))
            owner_picker.locator(".gws-modal-close").click()
            close_actor(owner_window)

            sheet.locator(".gws-equipped .gws-section-actions button").first.click()
            report["equipFromEmptyOverview"] = {"panel": sheet.locator("[data-gws-panel]").get_attribute("data-gws-panel"), "modalCount": gm.locator(".gws-modal").count(), "text": sheet.locator(".gws-body").inner_text()}
            sheet.locator(".gws-body > .gws-section > button").click()
            picker = gm.locator(".gws-modal").last
            picker.get_by_role("button", name="Criar item", exact=True).click()
            creation = gm.locator(".gws-modal").filter(has=gm.locator('[data-gws-item-field="core.name"]'))
            expect(creation).to_be_visible()
            report["createInitialFocus"] = gm.evaluate(FOCUS)
            creation.locator('[data-gws-item-field="core.name"]').fill("Nome pessoal de teste")
            creation.locator('[data-gws-item-field="description"]').fill("Descrição pessoal a preservar ao trocar o tipo.")
            creation.locator(".gws-modal-body > .gws-field > select").select_option("armor")
            report["afterChangingCreationType"] = {
                "name": creation.locator('[data-gws-item-field="core.name"]').input_value(),
                "description": creation.locator('[data-gws-item-field="description"]').input_value(),
            }
            creation.screenshot(path=str(output / "creation-after-type-change.png"))
            creation.locator(".gws-modal-close").click()
            expect(gm.locator(".gws-modal")).to_have_count(0)

            native = gm.evaluate("async()=>await gravewright.items.create({name:'Item pessoal de teste',type:'weapon',data:{description:'Descrição pessoal inicial'}})")
            drop_item(gm, window, native["id"], seed["campaign"])
            expect(sheet.locator("[data-entry-id]")).to_have_count(1)
            sheet.locator("[data-entry-id] .gws-link").click()
            embedded = gm.locator(".gws-modal").last
            report["ownedEditInitialFocus"] = gm.evaluate(FOCUS)
            embedded.locator('[data-gws-item-field="description"]').fill("Alteração pessoal na cópia")
            embedded.locator(".gws-modal-close").click()
            expect(gm.locator(".gws-modal")).to_have_count(0)
            report["afterOwnedEditClose"] = gm.evaluate(FOCUS)
            close_actor(window)

            item = open_item(gm, native["id"])
            report["nativeTemplate"] = item.locator(".gws-item-editor").evaluate("root=>({width:root.clientWidth,scroll:root.scrollWidth,descriptionHeight:root.querySelector('[data-gws-item-field=description]').getBoundingClientRect().height,notesHeight:root.querySelector('[data-gws-item-field=notes]').getBoundingClientRect().height})")
            item.screenshot(path=str(output / "native-template.png"))
            close_item(item)

            gm.set_viewport_size({"width": 390, "height": 1000})
            window = open_actor(gm, seed["actor"])
            window.evaluate("element=>Object.assign(element.style,{left:'8px',right:'auto',width:'374px',maxWidth:'calc(100vw - 16px)',minWidth:'0'})")
            window.locator(".gws-skills > button").click()
            picker = gm.locator(".gws-modal").last
            expect(picker).to_be_visible()
            report["mobilePicker"] = picker.evaluate("element=>{const r=element.getBoundingClientRect();return {viewport:innerWidth,left:r.left,right:r.right,width:r.width,client:element.clientWidth,scroll:element.scrollWidth};}")
            gm.screenshot(path=str(output / "mobile-picker.png"))
            picker.locator(".gws-modal-close").click()
            close_actor(window)
            browser.close()
        (output / "audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"output": str(output), **report}, ensure_ascii=False, indent=2), flush=True)
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
        assert fingerprint(root / ".env") == before_env


if __name__ == "__main__":
    main()
