# Contributing

## Prerequisites

- [Zelos CLI](https://docs.zeloscloud.io/cli)
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- [just](https://github.com/casey/just)
- Node.js 22.12+ (the Packet List panel)

## Commands

| Command                | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `just install`         | Install dependencies and pre-commit hooks         |
| `just install-nolive`  | Install without `zelos-packet` (see below)        |
| `just dev`             | Run the extension locally in app-config mode      |
| `just interfaces`      | List capturable NICs                              |
| `just check-permissions` | Probe capture rights and print the fix          |
| `just format`          | Format code with ruff                             |
| `just check`           | Lint with ruff and type-check the panel           |
| `just test`            | Run the panel's tests, build it, run pytest       |
| `just web-install`     | Install the panel's npm dependencies              |
| `just web-install-local SDK_TGZ` | Install against a local SDK tarball      |
| `just web-dev`         | Serve the panel standalone, against a mock host   |
| `just web-build`       | Build the panel into `dist/panels/`               |
| `just web-check`       | Type-check the panel                              |
| `just web-test`        | Run the panel's tests                             |
| `just package`         | Build the panel and package for the marketplace   |
| `just release VERSION` | Bump version, check, test, commit, and tag        |
| `just clean`           | Remove build artifacts                            |

## The `zelos-packet` dependency

`zelos-packet` is the native capture and decode package. `just install` runs
`uv sync`, which installs it from the package index like every other dependency.

`just install-nolive` / `just test-nolive` / `just check-nolive` build an
environment with everything *except* the native package. The handful of tests
that need the real thing skip with a reason.

## The Packet List panel

`web/` is the panel: a React app that runs in a sandboxed frame inside the Zelos app and talks to it
only through [`@zeloscloud/app-extension-sdk`](https://www.npmjs.com/package/@zeloscloud/app-extension-sdk).
Vite builds `web/src/panels/packet-list.html` into `dist/panels/packet-list.html`, the `entry` that
`extension.toml` names, and copies `web/public/panels/packet-list.options.json` beside it: the form
the panel's Edit sheet renders.

```
web/src/panels/packet-list/
  panel.tsx          the panel: subscriptions, grid, menu, drawer
  data.ts            query window → one row per packet
  stats.ts           the status strip
  filter.ts          the display-filter language
  dissect.ts         the frame → header tree
  event-fetch.ts     one packet's remaining fields, on demand
  options.ts         options, defaults, the visible-field mapping
  dev-feed.ts        a synthetic capture for `npm run dev` (standalone only)
  grid/              AG Grid chrome: search, follow, cursor row, theme
```

The host pushes the packets as a `rows` subscription (`usePanelData`), newest `bufferSize` first, and
the stats as a `latest` one. The SDK acknowledges each frame. Scrolling off the live tail drops the
subscription, so the rows hold still; following again subscribes afresh.

### The dev loop

```bash
just web-install     # once
just web-dev         # http://localhost:5173/panels/packet-list.html, against the SDK's mock host
just web-test        # vitest
```

Standalone, the SDK's mock host stands in for Zelos, and `dev-feed.ts` plays the host's side: one
synthetic capture, `Packet/eth0/packets` (all 31 fields of `zelos.packet.v1`) and `Packet/eth0/stats`,
with TCP, UDP and ICMP packets carrying real frame bytes pushed every 250 ms, a paused cursor that walks
forward, and answers to the drawer's one-packet re-fetch. `main.tsx` loads the feed as its own chunk and
only when the bridge is the standalone mock, so the panel never runs it inside Zelos.

In the app, run `cd web && npm run watch`, install the repository as a local extension, and use
**Reload** from the panel's ⋮ menu after each build.

### Before the SDK publishes

The panel needs `@zeloscloud/app-extension-sdk` 0.4.0. Until it is on npm, install a packed tarball:

```bash
just web-install-local ../path/to/zeloscloud-app-extension-sdk-0.4.0.tgz
```

`package.json` keeps `^0.4.0`, and `web/package-lock.json` is not committed (`web/.gitignore`).
Once 0.4.0 publishes, drop that ignore line, run `just web-install`, and commit the lockfile it writes.

## Configuration

`config.schema.json` drives the agent's configuration UI in the Zelos desktop app;
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
just package-dev    # local dry run into .artifacts/, installs nowhere
```

Both build the panel first: `dist` and `assets` are in `[package].paths`.

`just package` refuses while `zelos-packet` resolves through
`[tool.uv.sources]`: uv honors that table in the extension host too, and both
`pyproject.toml` and `uv.lock` ship in the archive, so the package would install
nowhere. Drop the table and re-run `uv lock` once `zelos-packet` publishes.

The archive lands next to `extension.toml` as `packet-{version}.tar.gz`.

## Releasing

```bash
just release 0.0.2
git push --follow-tags
```

The tag drives `.github/workflows/release.yml`, which re-verifies the version
against both manifests, builds the panel, packages, checks that the panel and
`actions.json` made it into the archive, and attaches the result to a GitHub
release.

## Getting help

- [Zelos Docs](https://docs.zeloscloud.io)
- [SDK Guide](https://docs.zeloscloud.io/sdk)
- [GitHub Issues](https://github.com/zeloscloud/zelos-extension-packet/issues)

## License

MIT - see [LICENSE](LICENSE)
