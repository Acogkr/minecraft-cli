# Command Patterns

Token-efficient scenario for three or more actions:

```json
{
  "version": 2,
  "name": "plugin-smoke",
  "variables": { "bot": "bot1" },
  "steps": [
    { "name": "open", "args": ["session", "command", "${bot}", "mcgui"], "retry": 2 },
    { "name": "assert", "args": ["session", "expect-window", "${bot}", "--slot", "10", "--item", "paper"] },
    { "name": "window", "args": ["session", "state", "${bot}", "--part", "window"], "capture": { "title": "$.data.window.title" }, "assertions": [{ "path": "$.ok", "equals": true }] },
    { "name": "cleanup", "args": ["session", "destroy", "${bot}"], "when": "always" }
  ]
}
```

Validate with `minecraft-cli --json scenario test.json --dry-run`, then run with `minecraft-cli --json scenario test.json`. Default steps run only while the scenario is successful; use `when: failure` for diagnostics and `when: always` for cleanup. Successful responses stay only in the report unless `includeResponse` is true. Reports are saved under `.minecraft-cli/runs`. Avoid `--full` during normal AI use.

Headless test:

```powershell
minecraft-cli --compact --json session create bot1 --username BotOne --host 127.0.0.1 --port 25565 --version 1.21.4 --connect
minecraft-cli --compact --json session state bot1 --part core
minecraft-cli --compact --json session expect-window bot1 --title "Menu" --slot 10 --item paper --lore "details" --timeout-ticks 80
minecraft-cli --compact --json session events bot1 --type message --contains error --limit 10
```

Incremental event polling:

```powershell
minecraft-cli --compact --json session events bot1 --limit 20
minecraft-cli --compact --json session events bot1 --after 42 --limit 20
```

Use the first response's `nextSequence` as the next `--after` value. This returns only newer events. Chat is stored once as `message`; do not request the removed duplicate `message_str` alias.

Rendered checkpoint:

```powershell
minecraft-cli --compact --json visual launch visual1 --host 127.0.0.1 --port 25565 --username VisualBot --version 1.21.4
minecraft-cli --compact --json visual hover-slot visual1 --slot 10
minecraft-cli --compact --json visual screenshot visual1 --label gui-lore
minecraft-cli --compact --json visual stop visual1
```

Rendered screenshot responses include `imageAnalysis.exactMatch`, `changedSampleRatio`, and `meaningfullyChanged`. Avoid loading an exact duplicate into vision context. Treat the heuristic only as a token-saving hint: inspect screenshots unconditionally for Lore, small text, colors, alignment, and explicit visual regressions. Use `--no-compare` only when no previous-frame comparison is useful.

Generic dialog, form, and scrolling controls:

```powershell
minecraft-cli --compact --json visual elements visual1
minecraft-cli --compact --json visual hover-element visual1 "Confirm" --exact
minecraft-cli --compact --json visual click-element visual1 "Confirm" --exact
minecraft-cli --compact --json visual click visual1 --x 160 --y 90
minecraft-cli --compact --json visual type-text visual1 "search text"
minecraft-cli --compact --json visual press-key visual1 tab
minecraft-cli --compact --json visual press-key visual1 enter
minecraft-cli --compact --json visual move-cursor visual1 --x 280 --y 160
minecraft-cli --compact --json visual scroll visual1 --delta -3
```

NPC to native Dialog flow:

```powershell
minecraft-cli --compact --json actor capabilities visual1
minecraft-cli --compact --json actor interact-role visual1 --role "Shop NPC"
minecraft-cli --compact --json actor actions visual1
minecraft-cli --compact --json actor click-action visual1 --action-id button:2
```

Use `fixtures/scenarios/npc-dialog-action.json` as the regression pattern. Actor capability failures are explicit; do not skip them.

Named state diff and visual crops:

```powershell
minecraft-cli --compact --json session checkpoint bot1 --label before --parts core,window,ui,hud,entities,inventory,events
minecraft-cli --compact --json session diff bot1 --baseline before
minecraft-cli --compact --json visual screenshot visual1 --label dialog --region dialog
```

Unchanged diffs are compact and unchanged images produce no crop. Failure capsules are saved under `.minecraft-cli/runs/capsules`.

Prefer semantic element commands. Coordinate clicking is the fallback for widgets without text and custom-drawn screens. Native data-driven dialogs are available on supported version `1.21.11`, not `1.20.1` or `1.21.4`.

Exact inventory and transfer assertions:

```powershell
minecraft-cli --compact --json session inventory-checkpoint bot1 --label before
minecraft-cli --compact --json session compare-inventory bot1 --baseline .minecraft-cli/sessions/bot1/json/<checkpoint>.inventory.json
minecraft-cli --compact --json session expect-transition bot1 --after 42 --brand Paper --timeout-ticks 200
```

Supported keys are `enter`, `tab`, `backspace`, `delete`, `escape`, `up`, `down`, `left`, `right`, `home`, `end`, `page-up`, `page-down`, and `space`. Add `--modifiers 1`, `2`, or `4` for Shift, Control, or Alt; combine them by addition. Text is capped at 4096 characters per call.

Use different visual names and, for offline clients, different usernames. A version supports up to eight active visual slots, created only as concurrent sessions need them.

Remove empty slots left by an older eager-allocation release with `minecraft-cli --json visual prune`. It keeps launched, modified, or running instances.

Microsoft-authenticated headless session:

```powershell
minecraft-cli --compact --json auth status
minecraft-cli auth login main
minecraft-cli --compact --json session create bot-ms --auth microsoft --account main --host play.example.com --port 25565 --version 1.21.4 --connect
```

`main` is a local account alias, not an email address. `auth login` opens Microsoft's HTTPS device-login page with the code prefilled and copies the code to the Windows clipboard. The user must complete the first Microsoft approval; after the command exits successfully, the cached account can be reused until it expires or is removed with `minecraft-cli auth logout main`.

Use either opt-out independently, or both in non-interactive automation:

```powershell
minecraft-cli auth login main --no-browser
minecraft-cli auth login main --no-clipboard
minecraft-cli auth login main --no-browser --no-clipboard
```

Do not treat code issuance alone as a completed login. Wait for `auth login` to finish successfully before running `session create`.

For a rendered Microsoft session, use `visual launch --auth microsoft`; it reuses MultiMC's active account and does not use the headless alias cache. Add `--profile <MinecraftName>` only to select another account already present in MultiMC.

State parts: `core`, `inventory`, `entities`, `window`, `ui`, `hud`, and `events`.

Optional isolated Paper Probe:

```powershell
minecraft-cli --compact --json probe status
minecraft-cli --compact --json probe events --after 0 --limit 20
minecraft-cli --compact --json probe diagnostics
```

`available: false` is the normal black-box fallback. Never install the Probe in a production server pack.

Artifact inspection and explicit retention cleanup:

```powershell
minecraft-cli --compact --json artifacts status
minecraft-cli --compact --json artifacts prune --older-than-days 30
minecraft-cli --compact --json artifacts prune --older-than-days 30 --apply
```

The second command is preview-only. Apply pruning only after reporting and only when old generated evidence may be removed. Defaults retain the newest 20 screenshots and 50 historical JSON files per session plus 50 scenario reports.
