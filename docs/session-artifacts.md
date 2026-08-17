# Session Artifacts

`minecraft-cli` stores per-session evidence under:

`.minecraft-cli/sessions/<session>/`

Layout:

- `metadata.json`: session name, authentication mode, account alias when used, player name, target server, version
- `json/latest-state.json`: latest session state
- `json/latest-core.json`: lightweight state refreshed with every snapshot
- `json/latest-inventory.json`, `latest-entities.json`, `latest-window.json`, `latest-ui.json`, `latest-events.json`: token-efficient state parts refreshed when that part is requested
- `json/latest-event-buffer.json`: latest raw in-memory event buffer
- `json/<timestamp>-<label>.json`: explicit saved states
- `json/<timestamp>-<label>.inventory.json`: exact all-slot inventory checkpoint
- `json/<timestamp>-inventory-diff.json`: exact slot and metadata comparison result
- `json/<timestamp>-<label>.screenshot.json`: screenshot metadata plus session state
- `logs/events.jsonl`: append-only event log
- `screenshots/<timestamp>-<label>.png`: visual evidence

Events contain a monotonically increasing `sequence`. The `events` command returns `oldestSequence` and `nextSequence`; pass the latter to `--after` on the next poll. Clearing the in-memory buffer does not reuse sequence numbers.

Multi-session scenario reports are stored separately under `.minecraft-cli/runs/<timestamp>-<scenario>.json`. A report contains every compact step response, while the normal CLI result contains only the summary, failures, and steps marked with `includeResponse`.

Useful commands:

```powershell
minecraft-cli --json session click-item bot1 --item book --name "Book Menu" --lore "slot 20"
minecraft-cli --json session save-state bot1 --label after-book-gui
minecraft-cli --json session screenshot bot1 --label gui --window-title "Minecraft 1.21.4"
minecraft-cli --json session screenshot bot1 --label paper-hover --window-title "Minecraft 1.21.4" --hover-slot 10 --native
```

Use `--native` when Windows captures a Minecraft OpenGL window as a blank or white image. It presses Minecraft's own screenshot key and copies the generated image into the session screenshot folder.

`--hover-slot` is a best-effort helper for chest-style GUI slots. It moves the real mouse over the slot before taking the screenshot, which can capture item tooltip/lore design.

## Background visual client

For reliable rendered tests, use the dedicated Fabric-controlled client. It does not use the user's foreground window, keyboard, or system mouse.

```powershell
minecraft-cli --json visual launch visual1 --host 127.0.0.1 --port 25565 --username VisualBot --version 1.21.4
minecraft-cli --json visual state visual1
minecraft-cli --json visual elements visual1
minecraft-cli --json visual hover-element visual1 "Confirm" --exact
minecraft-cli --json visual click-element visual1 "Confirm" --exact
minecraft-cli --json visual hover-slot visual1 --slot 10
minecraft-cli --json visual click-slot visual1 --slot 20
minecraft-cli --json visual close-screen visual1
minecraft-cli --json visual open-chat visual1
minecraft-cli --json visual hover-chat visual1
minecraft-cli --json visual click-hover visual1
minecraft-cli --json visual move-cursor visual1 --x 240 --y 135
minecraft-cli --json visual click visual1 --x 240 --y 135 --button 0
minecraft-cli --json visual type-text visual1 "form value"
minecraft-cli --json visual press-key visual1 tab
minecraft-cli --json visual press-key visual1 enter
minecraft-cli --json visual scroll visual1 --delta -3
minecraft-cli --json visual screenshot visual1 --label proof
```

`visual launch` automatically creates or refreshes a version-specific MultiMC instance, installs the matching Fabric Loader and control mod, and waits for the playable screen after connecting. Microsoft mode reuses MultiMC's active account by default; `--profile` only overrides that choice. The user's normal Minecraft instance is not modified.

Visual instances are created lazily. Slot one keeps the base name, such as `minecraft-cli-1.21.4`; additional slots use `minecraft-cli-1.21.4-2` through `-8` only when concurrent clients need them. Stopped slots are reused before another directory is created.

`visual prune` removes only never-launched placeholder slots left by older releases. Any running slot or slot containing logs, screenshots, or modified files is retained.

The control API binds only to `127.0.0.1` and requires a random per-launch token stored in the session runtime file. Rendered screenshots come from Minecraft's framebuffer and are saved under the same session artifact directory.

Visual screenshot metadata includes a SHA-256 hash and a comparison with the latest prior PNG in the same session. Exact matching and a 64×36 normalized RGB sample produce `meanChannelDelta`, `changedSampleRatio`, and `meaningfullyChanged`. Use `--no-compare` to disable this work for an isolated capture.

## Microsoft authentication data

Headless Microsoft login starts with `minecraft-cli auth login <alias>`. It opens Microsoft's device-login page with the code prefilled and also copies the code to the Windows clipboard. The user completes the first approval in that browser; later sessions reuse the alias until it expires or is removed with `auth logout`.

Authentication secrets are stored under the Windows user's `LocalAppData`, outside `.minecraft-cli` and outside the tested project. Session metadata records only the authentication mode and local alias. Tokens, refresh credentials, and the device code are never written to the evidence JSON or screenshots by the CLI.

Rendered Microsoft clients use MultiMC's active account instead of the headless alias cache. `visual launch --auth microsoft --profile <MinecraftName>` selects another account already configured in MultiMC.

Rendered control supports exactly Minecraft `1.20.1`, `1.21.4`, and `1.21.11`. Other versions fail with `VISUAL_VERSION_UNSUPPORTED` until a matching adapter is built and tested.

Use compact state parts for AI workflows:

```powershell
minecraft-cli --compact --json session state bot1 --part core
minecraft-cli --compact --json session state bot1 --part window
minecraft-cli --compact --json session state bot1 --part ui
```

`visual elements` exposes visible widget text and GUI-scaled bounds. Prefer text-based `hover-element` and `click-element` for buttons, including native dialogs. Coordinates use the same GUI-scaled space reported by `visual state`; they are a fallback for custom-drawn controls without semantic text. None of these commands move the Windows pointer. Text, key, and scroll commands are also delivered directly to the current Minecraft screen.

Keep one visual client only for checkpoints that need rendered evidence. Functional tests should remain on Mineflayer; launch the rendered client near visual assertions and stop it afterward with `visual stop`.

Use `artifacts status` for file counts and byte totals. `artifacts prune` writes a complete candidate report but removes nothing unless `--apply` is present. Retention is based on both age and newest-file counts, and never removes session metadata, `latest-*`, event logs, runtimes, or downloads.

The older `session screenshot` command uses Windows window automation and is retained for compatibility. It can be affected by foreground-window behavior; `visual screenshot` is the recommended path.
