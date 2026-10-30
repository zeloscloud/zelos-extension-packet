# Contributing

## Prerequisites

- [Zelos](https://zeloscloud.io) 26.0.10 or later
- [Zelos CLI](https://docs.zeloscloud.io/getting-started/install-cli/) 0.1.12 or later
- [just](https://github.com/casey/just)
- [uv](https://docs.astral.sh/uv/), when the project has an agent runtime (`pyproject.toml`)
- Node.js 24 LTS (see `web/.nvmrc`), when the project has a web project (`web/package.json`)

## Layout

`extension.toml` describes everything the extension contributes:

| Part | Files | Manifest |
| ---- | ----- | -------- |
| Agent runtime | `main.py`, the Python package, `pyproject.toml`, `config.schema.json` | `[agent]`, `[config]` |
| Panels | `web/src/panels/<id>.html`, `web/src/panels/<id>/` | `[[app.panels]]` |

The web project builds every tab and panel document into `dist/` at the project root with
`just build` (`npm run build`). `.gitignore` keeps `dist/` out of the repository, so a fresh clone
has none until its first build.

The agent runtime is the capture agent. `zelos-packet`, the native capture and decode package,
does the capturing; the Python package configures it:

| Module | Role |
| ------ | ---- |
| `capture.py` | Config parsing, one capture session per interface, permission remediation |
| `converter.py` | pcap and pcapng to `.trz`, for the `convert` command and the `convert_pcap` action |
| `actions.py` | The actions the app and Zelos AI call |
| `cli.py` | App mode (no subcommand) and the `interfaces`, `check`, `capture`, `replay` and `convert` commands |
| `agent_filter.py` | Keeps the agent's own traffic out of the capture |
| `pkg.py` | Imports `zelos_packet`, and is where the tests swap in a stand-in |

The Packet List panel is `web/src/panels/packet-list/`, a React app on
[`@zeloscloud/app-extension-sdk`](https://www.npmjs.com/package/@zeloscloud/app-extension-sdk):

| File | Role |
| ---- | ---- |
| `panel.tsx` | The panel: subscriptions, grid, menu, drawer |
| `data.ts` | Query window to one row per packet |
| `stats.ts` | The status strip |
| `filter.ts` | The display-filter language |
| `dissect.ts` | The frame to header tree |
| `event-fetch.ts` | One packet's remaining fields, on demand |
| `options.ts` | Options, defaults, the visible-field mapping |
| `dev-feed.ts` | A synthetic capture for `just dev` |
| `grid/` | AG Grid chrome: search, follow, cursor row, theme |

The host pushes the packets as a `rows` subscription (`usePanelData`), newest `bufferSize` first,
and the stats as a `latest` one. Scrolling off the live tail drops the subscription, so the rows
hold still; following again subscribes afresh.

## Commands

| Command                  | Description                                                           |
| ------------------------ | --------------------------------------------------------------------- |
| `just install`           | Install dependencies and the pre-commit hooks                         |
| `just format`            | Format code with ruff and Prettier                                    |
| `just check`             | Check formatting and lint (ruff, Prettier, ESLint), type-check `web/` |
| `just test`              | Run tests (pytest, Vitest)                                            |
| `just build`             | Build the web project into `dist/`                                    |
| `just package`           | Build and package for the Zelos marketplace                           |
| `just release VERSION`   | Bump version, check, test, build, commit, tag                         |
| `just clean`             | Remove build output, caches and packages                              |
| `just run`               | Run the agent runtime locally, as Zelos starts it                     |
| `just interfaces`        | List capturable interfaces                                            |
| `just check-permissions` | Probe capture permissions and print remediation                       |
| `just dev`               | Serve the panel against the SDK's mock host                           |
| `just watch`             | Rebuild `dist/` on every change                                       |

`just --list` also shows the recipes each part adds. `just install` installs the
pre-commit hooks in `.pre-commit-config.yaml`.

The tests replace `zelos_packet` with a stand-in, so they need no capture rights. The few that
need the real package skip with a reason when it cannot load.

`just dev` serves `http://localhost:5173/panels/packet-list.html`. The SDK's mock host stands in
for Zelos, and `dev-feed.ts` plays the host's side: one synthetic capture,
`Packet/eth0/packets` (the 31 fields of `zelos.packet.v1`) and `Packet/eth0/stats`, with TCP, UDP
and ICMP packets carrying real frame bytes every 250 ms, a paused cursor that walks forward, and
answers to the drawer's one-packet re-fetch. `main.tsx` loads the feed only when the bridge is the
standalone mock, so the panel never runs it inside Zelos.

## Run it in Zelos

```bash
just build
zelos extensions install-local .
```

A local install runs from your project directory, so you do not install again after a code
change:

- Tab or panel: after a rebuild, reload the tab or the panel. Keep `just watch` running to rebuild
  on every save, and use `just dev` to work on it in the browser against the mock host of the SDK.
- Agent runtime: stop and start the extension. After a dependency change, stop it and run
  `zelos extensions reinstall local.packet`.
- `extension.toml`: run `zelos extensions install-local .` again.

`config.schema.json` drives the extension's settings form in Zelos. The Interface field takes its
choices from the `list_interfaces` action (`ui:widget: action-choices`), because a static schema
cannot list a machine's NICs. See the
[configuration docs](https://docs.zeloscloud.io/sdk/how-to/develop-extensions/#configuration) for
the widgets.

## Packaging

```bash
just package
```

The archive lands next to `extension.toml` as `<name>-<version>.tar.gz`, where `<name>` is the
manifest name in lowercase with every other run of characters turned into one hyphen. It holds
`extension.toml`, the README, the icon, the config schema and the paths listed in
`[package] paths`. With an agent runtime it also holds `pyproject.toml`, `uv.lock` and
`actions.json`, the list of actions that run while the extension is stopped.

`auto_config`, `list_interfaces` and `convert_pcap` are declared `standalone=True`, so they run
with the extension stopped. `zelos extensions package` writes them into `actions.json`, which ships
in the archive and is never committed.

## Release

```bash
just release 1.0.0
git push --follow-tags
```

The release workflow checks, tests, builds and packages the extension, then attaches the
archive to a GitHub release. CI runs the same check, test and package steps on every push and
pull request.

To list the extension in the Zelos marketplace, once: push the project to a GitHub repository,
submit it at [marketplace.zeloscloud.io](https://marketplace.zeloscloud.io/), and install the
Zelos GitHub App on the repository when asked. After approval, every release you publish reaches
the marketplace. See
[Publish to the Marketplace](https://docs.zeloscloud.io/sdk/how-to/package-extensions/#publish-to-the-marketplace).
