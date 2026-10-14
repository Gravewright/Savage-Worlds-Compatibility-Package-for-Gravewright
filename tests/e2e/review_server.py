"""Run a disposable SWADE review table without changing the host's .env.

Example (from the Gravewright host checkout)::

    uv run --locked python data/swade-source/tests/e2e/review_server.py

The fixture uses its own database, media, module installation and test accounts.
Only the requested localhost port is served. Close the process to stop previewing.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import secrets
import socket
import sys


MODULE = Path(__file__).resolve().parents[2]


def default_archive() -> Path:
    manifest = json.loads((MODULE / "manifest.json").read_text(encoding="utf-8"))
    return MODULE / "dist" / f'gravewright-savage-worlds-{manifest["version"]}.zip'


def host_root(value: str | None = None) -> Path:
    candidates = ([Path(value)] if value else []) + [Path.cwd(), *MODULE.parents]
    for candidate in candidates:
        resolved = candidate.resolve()
        if (resolved / "manage.py").is_file() and (resolved / "gravewright").is_dir():
            return resolved
    raise RuntimeError("Pass --host-root with a Gravewright checkout containing manage.py.")


def available_port(preferred: int) -> int:
    with socket.socket() as connection:
        try:
            connection.bind(("127.0.0.1", preferred))
        except OSError:
            if not preferred:
                raise
            connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def configure_environment(root: Path, fixture: Path, port: int) -> None:
    # Process exports take precedence over optional .env defaults. All persisted
    # state and package registries are selected before Django imports settings.
    server = MODULE / 'server'
    if not (server / 'gravewright_swade' / 'apps.py').is_file():
        raise RuntimeError('Build the module server companion before running a rules fixture.')
    os.environ.update({
        "PYTHON_DOTENV_DISABLED": "1",
        "PYTHONUTF8": "1",
        "DEFAULT_LOCALE": "en",
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "DJANGO_DEBUG": "true",
        "DJANGO_SECRET_KEY": secrets.token_urlsafe(64),
        "DJANGO_ALLOWED_HOSTS": "127.0.0.1,localhost,testserver",
        "DJANGO_SECURE_COOKIES": "false",
        "DATABASE_ECHO": "false",
        "GRAVEWRIGHT_HOST": "127.0.0.1",
        "GRAVEWRIGHT_PORT": str(port),
        "GRAVEWRIGHT_PUBLIC_ORIGIN": "",
        "GRAVEWRIGHT_DATABASE": str(fixture / "review.sqlite3"),
        "GRAVEWRIGHT_MEDIA_ROOT": str(fixture / "media"),
        "GRAVEWRIGHT_MODULES_ROOT": str(fixture / "modules"),
        "GRAVEWRIGHT_CONTENT_ROOT": str(fixture / "content"),
        "GRAVEWRIGHT_SERVER_APPS": "gravewright_swade.apps.SwadeConfig",
        "GRAVEWRIGHT_SERVER_APP_PATHS": str(server),
        "GRAVEWRIGHT_API_MODULES_ROOT": str(root / "extensions" / "api") if (root / "extensions" / "api").is_dir() else "",
        "GRAVEWRIGHT_DJANGO_MODULES_ROOT": str(root / "extensions" / "django") if (root / "extensions" / "django").is_dir() else "",
        "GRAVEWRIGHT_REDIS_URL": "",
        "GRAVEWRIGHT_MARKETPLACE_URL": "",
        "GRAVEWRIGHT_MARKETPLACE_KEYS_FILE": "",
        "TRUSTED_PROXIES": "",
    })
    sys.path.insert(0, str(server))
    sys.path.insert(0, str(root))


def create_fixture(root: Path, fixture: Path, archive: Path, translator: Path | None, with_card_deck: bool = False) -> dict:
    # Validate against the actual host contract before installation so a package
    # error reports its path rather than only the host's public invalid_data code.
    from zipfile import ZipFile
    from jsonschema.validators import validator_for
    schema = json.loads((root / 'gravewright/modules/contracts/schemas/manifest.json').read_text(encoding='utf-8'))
    with ZipFile(archive) as package_archive:
        manifest = json.loads(package_archive.read('manifest.json'))
    issues = list(validator_for(schema)(schema).iter_errors(manifest))
    if issues:
        details = '; '.join(f"{'/'.join(map(str, issue.path))}: {issue.message}" for issue in issues)
        raise ValueError(f'Package violates the host manifest contract: {details}')
    import django
    django.setup()
    from django.conf import settings
    from django.core.management import call_command
    from django.test import Client
    from django.utils import timezone
    from gravewright.accounts.models import User
    from gravewright.actors.models import Actor
    from gravewright.campaigns.models import Campaign, Membership, Onboarding
    from gravewright.maps.models import Broadcast, Scene
    from gravewright.maps.services import DEFAULTS
    from gravewright.modules.models import ModuleSet
    from gravewright.modules.packages import host
    from gravewright.tokens.models import Token

    settings.PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
    call_command("migrate", verbosity=0, interactive=False)
    package = host().install_local(archive.read_bytes(), expected_type="system")
    installed = {package["id"]: package["version"]}
    locale_package = None
    if translator:
        locale_package = host().install_local(translator.read_bytes(), expected_type="module")

    users = {
        "gm": User.objects.create_user("swade-gm@example.test", secrets.token_urlsafe(20), name="GM de teste", role="owner"),
        "editor": User.objects.create_user("swade-editor@example.test", secrets.token_urlsafe(20), name="Editor de teste"),
        "reader": User.objects.create_user("swade-reader@example.test", secrets.token_urlsafe(20), name="Leitor de teste"),
    }
    if locale_package:
        # Language packs belong to the installation, never to a campaign's
        # module set. Exercise the real authenticated activation endpoint.
        owner_client = Client()
        owner_client.force_login(users["gm"])
        activation = owner_client.post('/api/module-packages/activation',
            {"id": locale_package["id"], "version": locale_package["version"], "enabled": True},
            content_type='application/json')
        if activation.status_code != 200 or activation.json().get('enabled') is not True:
            raise RuntimeError(f'Could not activate the fixture Translator: {activation.status_code} {activation.content!r}')
    campaign = Campaign.objects.create(owner=users["gm"], name="SWADE · revisão isolada", system=package["id"])
    for role, user in users.items():
        membership = Membership.objects.create(campaign=campaign, user=user, role="gm" if role == "gm" else "player")
        Onboarding.objects.create(membership=membership, dismissed=True, player_shown_at=timezone.now())
    ModuleSet.objects.create(campaign=campaign, modules=installed)
    grants = {str(users["editor"].pk): "owner", str(users["reader"].pk): "read"}
    actor = Actor.objects.create(campaign=campaign, name="Personagem de teste", type="character", data={}, permissions=grants)
    scene = Scene.objects.create(campaign=campaign, name="Cena de teste", width=1024, height=768, settings=deepcopy(DEFAULTS))
    Broadcast.objects.create(campaign=campaign, scene=scene)
    linked = Token.objects.create(scene=scene, actor=actor, grid_x=2, grid_y=2)
    snapshot = Token.objects.create(scene=scene, actor=actor, linked=False, grid_x=5, grid_y=2,
        snapshot={"token": {"name": "Cópia independente de teste"}, "identity": {"concept": "Conceito independente inicial"}})
    card_deck = None
    if with_card_deck:
        # These image-bearing cards belong only to this disposable database.
        # Runtime packages neither create this deck nor contain these assets.
        import base64
        from django.core.files.uploadedfile import SimpleUploadedFile
        from gravewright.cards.models import Card, Deck
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN49+zSfwAJEgOmcY9FVAAAAABJRU5ErkJggg==')
        deck = Deck.objects.create(campaign=campaign, name='Native fixture deck with fronts')
        names = [f'{rank} {suit}' for suit in ('♣', '♦', '♥', '♠')
                 for rank in ('2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A')]
        names += ['★ 1', '★ 2']
        for position, name in enumerate(names):
            Card.objects.create(deck=deck, name=name, position=position,
                front=SimpleUploadedFile(f'fixture-front-{position}.png', png, content_type='image/png'))
        card_deck = {'id': str(deck.pk), 'name': deck.name, 'cards': len(names)}
    sessions = {}
    for role, user in users.items():
        client = Client()
        client.force_login(user)
        sessions[role] = {"name": settings.SESSION_COOKIE_NAME, "value": client.cookies[settings.SESSION_COOKIE_NAME].value}
    return {
        "kind": "swade-isolated-review", "fixture": str(fixture), "host": str(root), "module": str(MODULE),
        "package": {"id": package["id"], "version": package["version"]},
        "translator": ({"id": locale_package["id"], "version": locale_package["version"],
                        "archive": str(translator.resolve()), "globalEnabled": True} if locale_package else None),
        "campaign": str(campaign.pk), "actor": str(actor.pk), "scene": str(scene.pk),
        "linkedToken": str(linked.pk), "snapshotToken": str(snapshot.pk),
        "cardDeck": card_deck,
        "users": {role: str(user.pk) for role, user in users.items()}, "sessions": sessions,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-root", default=os.environ.get("GRAVEWRIGHT_HOST_ROOT"))
    parser.add_argument("--archive", type=Path, default=default_archive())
    parser.add_argument("--translator-zip", type=Path)
    parser.add_argument("--with-card-deck", action="store_true", help="Seed 54 native cards with test front images in the disposable fixture.")
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--seed", type=Path)
    parser.add_argument("--port", type=int, default=30019)
    args = parser.parse_args()
    root = host_root(args.host_root)
    fixture = (args.fixture or root / "data" / "swade-review" / secrets.token_hex(8)).resolve()
    if fixture.exists() and any(fixture.iterdir()):
        raise RuntimeError("Use a new, empty --fixture directory for an isolated review.")
    fixture.mkdir(parents=True, exist_ok=True)
    archive = args.archive.resolve()
    if not archive.is_file():
        raise RuntimeError(f"Build the SWADE archive before starting the fixture: {archive}")
    port = available_port(args.port)
    configure_environment(root, fixture, port)
    seed = create_fixture(root, fixture, archive, args.translator_zip, with_card_deck=args.with_card_deck)
    seed["base"] = f"http://127.0.0.1:{port}"
    seed_file = (args.seed or fixture / "seed.json").resolve()
    seed_file.parent.mkdir(parents=True, exist_ok=True)
    seed_file.write_text(json.dumps(seed, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"base": seed["base"], "seed": str(seed_file), "campaign": seed["campaign"]}), flush=True)
    from django.core.management import call_command
    call_command("runserver", f"127.0.0.1:{port}", use_reloader=False, verbosity=0)


if __name__ == "__main__":
    main()
