"""`zelos extensions package` reads extension.toml and refuses on a dangling path.

Every miss below would surface for the first time at tag time, in the release
workflow, with the tag already pushed. Catching it in CI is the whole point.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = tomllib.loads((REPO_ROOT / "extension.toml").read_text())

# Added to the archive by the CLI whether or not [package] names them.
IMPLICIT_KEYS = ["icon", "readme"]


@pytest.mark.parametrize("relative", MANIFEST["package"]["paths"])
def test_package_path_exists(relative: str) -> None:
    """`dist` is the built panel: `just test` builds it first, as `just package` does."""
    assert (REPO_ROOT / relative).exists(), f"[package] paths names a missing {relative}"


@pytest.mark.parametrize("panel", MANIFEST["app"]["panels"], ids=lambda panel: panel["id"])
def test_panel_files_are_packaged(panel: dict) -> None:
    """Each panel's entry, icon and options schema exist and sit under a packaged path."""
    for key in ("entry", "icon", "options_schema"):
        relative = panel[key]
        assert (REPO_ROOT / relative).is_file(), (
            f"panel {panel['id']} {key} names a missing {relative}"
        )
        top = relative.split("/", 1)[0]
        assert top in MANIFEST["package"]["paths"], f"{relative} is outside [package] paths"


@pytest.mark.parametrize("key", IMPLICIT_KEYS)
def test_referenced_file_exists(key: str) -> None:
    assert (REPO_ROOT / MANIFEST[key]).is_file(), f"manifest {key} points at a missing file"


def test_config_schema_exists() -> None:
    assert (REPO_ROOT / MANIFEST["config"]["schema"]).is_file()


def test_entry_point_is_packaged() -> None:
    """The agent entry has to be in [package] paths - nothing adds it implicitly."""
    assert MANIFEST["agent"]["entry"] in MANIFEST["package"]["paths"]


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


def test_entry_module_re_exports_the_action_prefix() -> None:
    """At-rest and live actions must land in one namespace.

    The inventory dump reads `ACTION_PREFIX` off the entry module and otherwise
    falls back to its name, so a missing re-export ships `main/convert_pcap`
    while the running extension serves `Packet/convert_pcap` - two unrelated
    trees, no error anywhere.
    """
    import main
    from zelos_extension_packet import ACTION_PREFIX
    from zelos_extension_packet.cli import SOURCE_PREFIX

    assert main.ACTION_PREFIX == ACTION_PREFIX == SOURCE_PREFIX
