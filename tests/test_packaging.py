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
    assert (REPO_ROOT / relative).exists(), f"[package] paths names a missing {relative}"


@pytest.mark.parametrize("key", IMPLICIT_KEYS)
def test_referenced_file_exists(key: str) -> None:
    assert (REPO_ROOT / MANIFEST[key]).is_file(), f"manifest {key} points at a missing file"


def test_config_schema_exists() -> None:
    assert (REPO_ROOT / MANIFEST["config"]["schema"]).is_file()


def test_entry_point_is_packaged() -> None:
    """The runtime entry has to be in [package] paths - nothing adds it implicitly."""
    assert MANIFEST["runtime"]["entry"] in MANIFEST["package"]["paths"]


def test_entry_module_re_exports_the_action_prefix() -> None:
    """At-rest and live actions must land in one namespace.

    The inventory dump reads `ACTION_PREFIX` off the entry module and otherwise
    falls back to its name, so a missing re-export ships `main/convert_pcap`
    while the running extension serves `packet/convert_pcap` - two unrelated
    trees, no error anywhere.
    """
    import main
    from zelos_extension_packet import ACTION_PREFIX
    from zelos_extension_packet.cli import SOURCE_PREFIX

    assert main.ACTION_PREFIX == ACTION_PREFIX == SOURCE_PREFIX
