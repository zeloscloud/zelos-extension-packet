"""Manifest facts the packager cannot check: saved-layout ids, targets and the action namespace."""

from __future__ import annotations

import tomllib
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = tomllib.loads((REPO_ROOT / "extension.toml").read_text())


def test_saved_layouts_find_the_packet_list() -> None:
    """Layouts saved by Zelos 26.0.9 and earlier refer to this panel by these ids."""
    owner_repo = urlparse(MANIFEST["repository"]).path.strip("/")
    assert owner_repo.lower().replace("/", ".", 1) == "zeloscloud.zelos-extension-packet"
    assert "packet-list" in {panel["id"] for panel in MANIFEST["app"]["panels"]}


#: Wheel platform tag fragment → manifest target name.
WHEEL_TARGETS = {
    "manylinux": {"x86_64": "linux-x86_64", "aarch64": "linux-aarch64"},
    "macosx": {"arm64": "darwin-arm64", "x86_64": "darwin-x86_64"},
    "win": {"amd64": "windows-x86_64"},
}


def _locked_zelos_packet_targets() -> set[str]:
    """The targets `zelos-packet`'s locked wheels cover. An sdist would build anywhere: no limit."""
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text())
    (package,) = [p for p in lock["package"] if p["name"] == "zelos-packet"]
    if "sdist" in package:
        return set(MANIFEST["agent"]["targets"])
    targets: set[str] = set()
    for wheel in package["wheels"]:
        platform = wheel["url"].rsplit("-", 1)[-1].removesuffix(".whl")
        for family, arches in WHEEL_TARGETS.items():
            if not platform.startswith(family):
                continue
            if platform.endswith("universal2"):
                targets.update(arches.values())
            else:
                targets.update(name for arch, name in arches.items() if platform.endswith(arch))
    return targets


def test_agent_targets_match_the_native_wheels() -> None:
    """`[agent] targets` names exactly the platforms zelos-packet can install on."""
    assert set(MANIFEST["agent"]["targets"]) == _locked_zelos_packet_targets()


def test_actions_register_under_the_manifest_name() -> None:
    """`zelos_sdk.init` takes SOURCE_PREFIX, and the app resolves actions by the manifest name."""
    from zelos_extension_packet.cli import SOURCE_PREFIX

    assert MANIFEST["name"] == SOURCE_PREFIX
