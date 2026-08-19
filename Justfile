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
# `install-nolive` below is the escape hatch when you do not need the real
# package. This whole note goes away once zelos-packet ships as a wheel.
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
    uv pip install pytest jsonschema ruff "zelos-sdk>=0.0.10" "rich-click>=1.8.0"

# Format code
format:
    uv run ruff format .
    uv run ruff check --fix .

# Run checks
check:
    uv run ruff check .

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

# Package extension
package:
    uv run python scripts/package_extension.py

# Clean build artifacts
clean:
    rm -rf dist build .pytest_cache .ruff_cache *.tar.gz .artifacts
    find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
