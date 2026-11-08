# Kilo32 — Kilo Code CLI 7.8.17 for Windows x86 (with Tor)

Complete 32-bit build of Kilo Code CLI with interactive TUI, bundled Tor and
local proxy pool. No Node.js, no Tor Browser, no external services required —
everything is already inside the archive.

## Quick start (3 steps)

```bat
git clone https://github.com/javidik/Kilo32.git
cd Kilo32
install.bat
```

The installer verifies the archive's SHA-256, unpacks it, copies Kilo to
`%LOCALAPPDATA%\Programs\KiloCLI`, and adds that folder to the user `PATH`.
No administrator rights required.

After installation, **open a NEW PowerShell or CMD window** and verify:

```bat
kilo --version
kilo --help
kilo
```

Running `kilo` (no arguments) starts the TUI with Tor enabled.

## Run modes

| Command | What happens |
|---------|--------------|
| `kilo` | TUI with Tor (default). Tor starts, fetches bridges and connects. |
| `kilo --no-proxy` | TUI without Tor (faster startup, useful on clean networks). |
| `kilo --proxy` | Force-enable Tor even if disabled in `config.json`. |
| `kilo --proxy-debug` | Tor with verbose logging (debugging). |
| `kilo run "task"` | Headless mode without TUI. |
| `kilo serve --port 4096` | Local server. |
| `kilo models` | List available models. |
| `kilo auth login` | Sign in to Kilo Gateway. |

## Tor and bridges

Tor is enabled by default. Kilo routes traffic through a local proxy pool at
`127.0.0.1:17890` which forwards into Tor SOCKS5h at `127.0.0.1:19050`.

obfs4 bridges are fetched from a public feed
(`raw.githubusercontent.com/scriptzteam/Tor-Bridges-Collector/master/bridges-obfs4`)
on first launch, cached locally, and refreshed every 7 days. If bridges stop
working, Kilo forces a refresh and restarts Tor automatically.

## Authentication

```bat
kilo auth login
```

Opens the Kilo Gateway sign-in page in your browser.

## Uninstall

```powershell
& "$env:LOCALAPPDATA\Programs\KiloCLI\uninstall.ps1"
```

Removes the program and `PATH` entry. User data (sessions, settings, cache)
is left untouched.

## Requirements

- Windows 10 x86 (1809+) or newer
- PowerShell 5.1 (built into Windows 10) or PowerShell 7+
- Git (to clone this repository)

64-bit Windows will not work — this build targets 32-bit Windows and processors.

## What is inside the archive

`kilo-cli-x86/dist/Kilo-CLI-7.8.17-win32-ia32-TUI-Tor.zip` (80.9 MB) contains:

- `node.exe` — Node.js 22.23.0 win-x86
- `kilo-main.mjs` — bundled Kilo Code CLI 7.8.17
- `cli/tui/worker.js` — TUI worker
- `node_modules/` — all dependencies, including:
  - `@opentui/core-win32-ia32/opentui.dll` — native TUI (Zig core)
  - `koffi/` — FFI bridge (with 32-bit patch)
  - `@lydell/node-pty` — 32-bit PTY
- `proxy/` — autonomous proxy pool:
  - `launcher.cjs` — handles `--proxy` / `--no-proxy` / `--proxy-debug` flags
  - `manager.cjs` — Tor control and bridge auto-refresh
  - `server.cjs` — HTTP CONNECT pool with Basic auth
  - `config.json` — default config (Tor enabled)
- `proxy/tor/` — Tor Expert Bundle i686:
  - `tor/tor.exe` — Tor 0.4.9.15
  - `tor/pluggable_transports/lyrebird.exe` — obfs4/snowflake/webtunnel
  - `tor/pluggable_transports/conjure-client.exe` — conjure transport
  - `data/geoip`, `data/geoip6` — GeoIP databases
- `*.wasm` — Tree-sitter and photon-runtime
- `*.mp3` — CLI sound effects

## License

MIT. Kilo Code CLI is distributed under the MIT license — see `LICENSE` and
the licenses inside the archive (`proxy/tor/licenses/`). The Tor Expert
Bundle is distributed by the Tor Project under BSD-3-Clause.

## Troubleshooting

### "kilo is not recognized as an internal or external command"

Open a **new** PowerShell or CMD window after installation. The `PATH`
update only affects processes started after `install.bat` finishes.

### PowerShell shows garbled characters when running install.bat

This should not happen — `install.bat` switches the console to UTF-8
(`chcp 65001`) before launching PowerShell, and `install.ps1` is English-only.
If you still see garbled output, run `chcp 65001` manually before
`install.bat`.

### Tor fails to bootstrap

Run `kilo --proxy --proxy-debug` and look at the `[kilo-tor]` lines. Common
causes:
- `lyrebird.exe failed at launch` — install Visual C++ Redistributable 32-bit
  from Microsoft.
- `Tor bootstrap timed out` — bridges may be blocked. Kilo will retry once
  with fresh bridges; if that also fails, wait a few minutes and try again.
- `bridge feed HTTP 404` — the public feed is temporarily unavailable.
  Kilo will fall back to the cached bridge list.

### Different SHA-256 than expected

Re-clone the repository — the archive may have been corrupted during
`git clone`. The installer refuses to proceed if the SHA-256 does not match
`SHA256SUM`.
