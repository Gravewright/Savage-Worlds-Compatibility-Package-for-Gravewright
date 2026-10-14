"""Focused visual smoke of the installed ZIP at desktop and narrow widths.

This checks layout geometry and captures screenshots. It does not rerun the
functional E2E suite or edit the host .env.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import secrets
import subprocess

from playwright.sync_api import expect, sync_playwright

from review_server import MODULE, default_archive, host_root
from swade import close_actor, fingerprint, open_actor, start_fixture


MEASURE = """root => {
  const bounds = root.getBoundingClientRect();
  const rectangle = element => {
    const rect = element.getBoundingClientRect();
    return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,
      clientWidth:element.clientWidth,scrollWidth:element.scrollWidth};
  };
  const selectors = ['.gws-header','.gws-header-stats','.gws-attributes',
    '.gws-attribute-grid','.gws-resources','.gws-resource','.gws-attribute'];
  const sections = selectors.flatMap(selector => [...root.querySelectorAll(selector)].map((element,index)=>({
    selector,index,...rectangle(element),
    outsideRoot:element.getBoundingClientRect().left < bounds.left - 1 || element.getBoundingClientRect().right > bounds.right + 1,
  })));
  const innerOverflow = [];
  for(const container of root.querySelectorAll('.gws-attribute,.gws-resource,.gws-stat')) {
    const parent=container.getBoundingClientRect();
    for(const child of container.children) {
      const childBounds=child.getBoundingClientRect();
      if(!childBounds.width && !childBounds.height) continue;
      if(childBounds.left < parent.left - 1 || childBounds.right > parent.right + 1)
        innerOverflow.push({parent:container.className,child:child.className,...rectangle(child)});
    }
  }
  const value=root.querySelector('.gws-die span'),icon=root.querySelector('.gws-die svg');
  return {viewport:window.innerWidth,root:rectangle(root),sections,innerOverflow,
    die:{text:value.textContent,color:getComputedStyle(value).color,background:getComputedStyle(value).backgroundColor,
      strokeWidth:getComputedStyle(icon).strokeWidth,...rectangle(value)}};
}"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-root")
    parser.add_argument("--archive", type=Path, default=default_archive())
    parser.add_argument("--port", type=int, default=30019)
    args = parser.parse_args()
    root = host_root(args.host_root)
    output = root / "test-results" / "swade-visual" / secrets.token_hex(8)
    output.mkdir(parents=True)
    original_env = fingerprint(root / ".env")
    server = log = None
    metrics = []
    try:
        server, log, seed = start_fixture(root, output, args.archive.resolve(), args.port)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={"width": 1500, "height": 1080}, locale="pt-BR")
            context.add_cookies([{**seed["sessions"]["gm"], "url": seed["base"]}])
            context.add_init_script("window.gravewrightLocale={id:'pt-BR',messages:{}};")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(seed["base"] + "/game/" + seed["campaign"])
            page.wait_for_function("!!window.gravewrightActors && !!window.gravewright")
            expect(page.locator(".game-menubar__presence")).to_have_attribute("data-presence", "seated", timeout=15000)
            window = open_actor(page, seed["actor"])
            sheet = window.locator(".gws-sheet")
            for width, height in [(1500, 1080), (940, 1000), (640, 1000), (390, 1000)]:
                page.set_viewport_size({"width": width, "height": height})
                if width != 1500:
                    # Match a user resizing the host window to the available
                    # viewport; native remembered geometry may stay narrower.
                    window.evaluate("(element,width)=>Object.assign(element.style,{left:'8px',right:'auto',width:(width-16)+'px',maxWidth:'calc(100vw - 16px)',minWidth:'0'})", width)
                page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                measurement = sheet.evaluate(MEASURE)
                measurement["window"] = window.evaluate("element=>{const r=element.getBoundingClientRect();return {x:r.x,width:r.width,right:r.right};}")
                metrics.append(measurement)
                page.screenshot(path=str(output / f"swade-{width}.png"))
                if width == 1500:
                    window.screenshot(path=str(output / "swade-desktop-window.png"))
                    sheet.locator(".gws-attributes").screenshot(path=str(output / "swade-dice-closeup.png"))
            (output / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
            assert not errors, errors
            for measurement in metrics:
                assert measurement["root"]["scrollWidth"] <= measurement["root"]["clientWidth"] + 1, measurement
                assert not any(section["outsideRoot"] for section in measurement["sections"]), measurement
                assert all(section["scrollWidth"] <= section["clientWidth"] + 1 for section in measurement["sections"]), measurement
                assert not measurement["innerOverflow"], measurement
            close_actor(window)
            browser.close()
        print(json.dumps({"passed": True, "widths": [value["viewport"] for value in metrics], "output": str(output),
            "rootWidths": [{"viewport":value["viewport"],"client":value["root"]["clientWidth"],"scroll":value["root"]["scrollWidth"]} for value in metrics]}, ensure_ascii=False), flush=True)
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
        assert fingerprint(root / ".env") == original_env, "The host .env changed during visual smoke."


if __name__ == "__main__":
    main()
