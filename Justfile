set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

# Install dependencies (needs zelos-packet to be resolvable - see [tool.uv.sources])
#
# RUN THIS INSIDE THE MONOREPO DEV SHELL while zelos-packet is a path
# dependency:
#
#     direnv exec ~/zelos/src/.claude/worktrees/zelos-packet just install
#
# zelos-packet links libpcap, and nothing outside that shell provides one:
# the nix SDK ships no libpcap and the toolchain does not see the macOS
# system copy, so a build elsewhere fails at link with
# `ld: library not found for -lpcap`. The shell also exports LIBPCAP_LIBDIR,
# which gets a static link rather than a dynamic one.
#
install:
    uv sync --extra dev
    uv run pre-commit install

# Install dependencies for CI (no pre-commit hooks). Same dev-shell
# requirement as `install`.
ci-install:
    uv sync --extra dev

# Dev environment WITHOUT zelos-packet, for while that package is still being
# built. Every test that needs the real package skips with a clear reason.
install-nolive:
    uv venv --python 3.11
    uv pip install pytest jsonschema ruff "zelos-sdk>=0.0.12a1" "rich-click>=1.8.0"

# Format code
format:
    uv run ruff format .
    uv run ruff check --fix .

# Check formatting (no changes)
format-check:
    uv run ruff format --check .
    uv run ruff check .

# Run checks
check:
    uv run ruff check .

# Run checks against the install-nolive environment
check-nolive:
    .venv/bin/python -m ruff check .

# Run tests
test:
    uv run pytest

# Run tests against the install-nolive environment
test-nolive:
    .venv/bin/python -m pytest

# Run extension locally (app-config mode)
dev:
    uv run python main.py

# List capturable interfaces
interfaces:
    uv run python main.py interfaces

# Probe capture permissions and print remediation
check-permissions:
    uv run python main.py check

# Package for the Zelos marketplace (also generates actions.json)
package: clean
    #!/usr/bin/env bash
    set -euo pipefail
    if grep -q '^\[tool\.uv\.sources\]' pyproject.toml; then
        echo "error: pyproject.toml still resolves zelos-packet through [tool.uv.sources]." >&2
        echo "       uv honors that table in the extension host too, and both it and uv.lock" >&2
        echo "       ship in the archive, so the package would install nowhere. Drop the table" >&2
        echo "       and re-run 'uv lock' once zelos-packet publishes." >&2
        echo "       For a local, install-nowhere dry run: just package-dev" >&2
        exit 1
    fi
    # The packager only skips dotted paths and node_modules, so a stray
    # __pycache__ would ship. `clean` clears what is there; this keeps the
    # action dump (a `uv run` in this directory) from writing more.
    PYTHONDONTWRITEBYTECODE=1 zelos extensions package .

# Dry-run package while the zelos-packet override stands (installs nowhere)
package-dev: clean
    # `--output` only means "directory" if the directory already exists.
    mkdir -p dist
    PYTHONDONTWRITEBYTECODE=1 zelos extensions package . --output dist

# Release: bump version, format, check, test, commit, tag
release VERSION:
    #!/usr/bin/env bash
    set -euo pipefail
    git diff-index --quiet HEAD || (echo "Uncommitted changes! Commit or stash first." && exit 1)
    zelos extensions bump "{{VERSION}}"
    just format
    uv lock
    just check
    just test
    git add -A
    git commit -m "Release v{{VERSION}}"
    git tag -a "v{{VERSION}}" -m "Release v{{VERSION}}"
    echo ""
    echo "✓ Release v{{VERSION}} ready!"
    echo ""
    echo "Push with: git push --follow-tags"

# Clean build artifacts
clean:
    rm -rf dist build .pytest_cache .ruff_cache *.tar.gz .artifacts actions.json
    find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
