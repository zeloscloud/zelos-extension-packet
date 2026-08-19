"""The published archive must not carry the local-dev `[tool.uv.sources]` table.

uv honours `[tool.uv.sources]` whenever uv is the resolver - which includes the
extension host - so shipping the developer's monorepo path would make every
install fail on a directory that exists on exactly one machine.
"""

from __future__ import annotations

import importlib.util
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_packager():
    spec = importlib.util.spec_from_file_location(
        "package_extension", REPO_ROOT / "scripts" / "package_extension.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TestStripUvSources:
    def test_real_pyproject_loses_uv_sources_and_keeps_everything_else(self):
        packager = _load_packager()
        original = (REPO_ROOT / "pyproject.toml").read_text()
        assert "[tool.uv.sources]" in original, "expected a local-dev source entry"

        stripped = packager.strip_uv_sources(original)
        parsed = tomllib.loads(stripped)

        assert "sources" not in parsed.get("tool", {}).get("uv", {})
        assert "api/py/zelos-packet" not in stripped  # the local checkout path
        assert parsed["project"]["name"] == "zelos-extension-packet"
        assert parsed["build-system"]["build-backend"] == "hatchling.build"
        # The dependency itself must survive - only the local override goes.
        assert any(dep.startswith("zelos-packet") for dep in parsed["project"]["dependencies"])

    def test_pyproject_without_the_table_is_unchanged(self):
        packager = _load_packager()
        text = '[project]\nname = "x"\n\n[build-system]\nrequires = ["hatchling"]\n'
        assert packager.strip_uv_sources(text) == text

    def test_comments_inside_the_table_are_removed_too(self):
        packager = _load_packager()
        text = "[tool.uv.sources]\n# local only\nfoo = { path = '../foo' }\n\n[build-system]\n"
        stripped = packager.strip_uv_sources(text)
        assert "local only" not in stripped
        assert stripped.strip() == "[build-system]"
