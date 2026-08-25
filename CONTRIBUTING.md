# Contributing

## Prerequisites

- [Zelos CLI](https://docs.zeloscloud.io/cli)
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- [just](https://github.com/casey/just)

## Commands

| Command                | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `just install`         | Install dependencies and pre-commit hooks         |
| `just install-nolive`  | Install without `zelos-packet` (see below)        |
| `just dev`             | Run the extension locally in app-config mode      |
| `just interfaces`      | List capturable NICs                              |
| `just check-permissions` | Probe capture rights and print the fix          |
| `just format`          | Format code with ruff                             |
| `just check`           | Lint with ruff                                    |
| `just test`            | Run tests with pytest                             |
| `just package`         | Package for the Zelos marketplace                 |
| `just release VERSION` | Bump version, check, test, commit, and tag        |
| `just clean`           | Remove build artifacts                            |

## The `zelos-packet` dependency

The native capture/decode package is not on PyPI yet, so `[tool.uv.sources]` in
`pyproject.toml` points `zelos-packet` at a monorepo checkout. Two consequences
until that flips:

- **`just install` and `just test` must run inside the monorepo dev shell.**
  `zelos-packet` links libpcap, and only that shell provides one:

  ```bash
  direnv exec ~/zelos/src/.claude/worktrees/zelos-packet just test
  ```

- **`just install-nolive` / `just test-nolive` / `just check-nolive`** build an
  environment with everything *except* the native package. The handful of tests
  that need the real thing skip with a reason. This is what CI runs.

Packaging refuses to run while the source override is in place — see below.

## Configuration

`config.schema.json` drives the configuration UI in the Zelos desktop app;
`config.json` is the shipped default. The interface picker uses a `ui:widget`
hint rather than an enum, because a static schema cannot enumerate a machine's
NICs. See the [configuration docs](https://docs.zeloscloud.io/sdk/how-to/develop-extensions/#configuration)
for the widget reference.

## Actions

`list_interfaces` and `convert_pcap` are declared `standalone=True`, so they run
with the extension stopped. `zelos extensions package` inventories them into
`actions.json` and ships it inside the archive — that file is what makes them
discoverable at rest. It is generated, never committed.

## Packaging

```bash
just package        # blocked while [tool.uv.sources] is present
just package-dev    # local dry run into dist/, installs nowhere
```

`just package` refuses while `zelos-packet` resolves through
`[tool.uv.sources]`: uv honors that table in the extension host too, and both
`pyproject.toml` and `uv.lock` ship in the archive, so the package would install
nowhere. Drop the table and re-run `uv lock` once `zelos-packet` publishes.

The archive lands next to `extension.toml` as `packet-capture-{version}.tar.gz`.

## Releasing

```bash
just release 0.0.2
git push --follow-tags
```

The tag drives `.github/workflows/release.yml`, which re-verifies the version
against both manifests, packages, checks that `actions.json` made it into the
archive, and attaches the result to a GitHub release.

## Getting help

- [Zelos Docs](https://docs.zeloscloud.io)
- [SDK Guide](https://docs.zeloscloud.io/sdk)
- [GitHub Issues](https://github.com/zeloscloud/zelos-extension-packet/issues)

## License

MIT - see [LICENSE](LICENSE)
