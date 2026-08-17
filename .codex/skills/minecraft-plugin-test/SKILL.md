---
name: minecraft-plugin-test
description: Test Paper/Bukkit Minecraft plugins end to end with minecraft-cli, including offline or Microsoft-authenticated clients, GUI items and lore, nested GUI navigation, chat hover/click, titles, action bars, boss bars, scoreboards, dialogs, toasts, and framebuffer screenshots. Use for plugin implementation, regression testing, visual validation, or bug reproduction on Minecraft 1.20.1, 1.21.4, or 1.21.11.
---

# Minecraft Plugin Test

Use the globally installed `minecraft-cli` command. Support only `1.20.1`, `1.21.4`, and `1.21.11` unless another adapter has been implemented and proven.

## Workflow

1. Confirm `minecraft-cli --help` succeeds.
2. Connect to the user's already-running Paper server. Use offline auth by default or a previously authorized Microsoft account when the server requires it. Do not manage the server.
3. Use headless sessions for behavior and protocol assertions.
4. Start visual sessions only for assertions requiring pixels. Use distinct names when several clients must be observed together.
5. Stop every visual session immediately after its visual checkpoints.
6. Report a feature as passing only after checking the resulting JSON or PNG.

## Scenario First

- For workflows with three or more CLI calls, prefer `minecraft-cli --json scenario <file>` over issuing every command separately.
- Keep the default summary output. The complete compact responses are already saved under `.minecraft-cli/runs`; use `--full` only to investigate a runner problem.
- Set `includeResponse: true` only on the few successful steps whose data is needed for the answer.
- Use default `when: success` for dependent actions, `when: failure` for diagnostics/screenshots, and `when: always` for session/client cleanup.
- Run `scenario <file> --dry-run` after creating or changing a scenario, then run it normally.

## Authentication

- Use offline auth unless the target server requires a Microsoft account.
- For a headless Microsoft session, check `auth status` for the requested alias. If it is absent, run `auth login <alias>` and let the user complete the Microsoft approval in the browser that opens. Do not expose or store tokens in project artifacts.
- Treat the alias as a local cache name, not an email address. Reuse it until authentication expires or the user logs out.
- For non-interactive environments, add `--no-browser` and/or `--no-clipboard`; report the fallback URL and device code to the user.
- For a rendered Microsoft session, use `visual launch --auth microsoft`. It reuses MultiMC's active account; use `--profile <MinecraftName>` only when a specific existing MultiMC account is required.
- Do not assume a successful device-code issuance means account approval completed. Confirm `auth login` exits successfully before creating the session.

## Token Discipline

- Add `--compact --json` to action commands.
- Batch three or more actions into one scenario so the agent receives one summary instead of repeated command envelopes.
- Expect `--compact` and scenario stdout to be single-line JSON; parse it directly instead of reformatting it unless a failure needs inspection.
- Read `session state <name> --part core` first.
- Request only `inventory`, `entities`, `window`, `ui`, or `events` when needed.
- Prefer `expect-chat`, `expect-event`, `expect-window`, and `expect-inventory` over full state dumps.
- Use `inventory-checkpoint` and `compare-inventory` when every slot and item metadata must remain identical.
- Capture the current event cursor before a proxy move, then use `expect-transition --after <sequence>` to verify reconnect and destination stability.
- When polling events, retain `nextSequence` and pass it back as `events <name> --after <sequence>` so previously read events are not returned again.
- Inspect only failed or explicitly visual screenshots.

## Visual Discipline

- Use `visual hover-slot` before GUI Lore screenshots.
- Use `visual elements`, `visual hover-element`, and `visual click-element` for ordinary buttons and native dialogs. Use GUI-scaled `visual click` only when the screen has no semantic widget text.
- Use `visual close-screen` for ESC/back behavior.
- Use `visual open-chat`, `visual hover-chat`, and `visual click-hover` for interactive chat.
- Use `visual type-text`, `visual press-key`, and `visual scroll` for focused fields, keyboard navigation, and long screens. These inject in-game events and do not take the user's Windows input focus.
- Capture title/subtitle, action bar, boss bar, scoreboard, toast, resource-pack screen, dialog, and arbitrary plugin UI when relevant.
- Native data-driven dialogs exist only in Minecraft 1.21.6 and newer, so among the supported versions test them on 1.21.11. Test plugin inventories and custom screens on all three versions.
- Read `imageAnalysis` before loading a repeated screenshot. Skip exact duplicates and normally skip unchanged routine checkpoints; always inspect the PNG when small text, Lore, color, alignment, or the renderer itself is under test.
- Read and write evidence in `.minecraft-cli/sessions/<name>` under the plugin project being tested.
- Visual instances are created only when concurrent clients need them. Up to eight sessions per version can run with independent slots, ports, tokens, and artifacts, and stopped slots are reused.
- All managed instances belong to the reusable `minecraft-cli` MultiMC group.
- Managed visual clients always launch with the Minecraft master volume set to zero.

## Artifact Retention

- Use `artifacts status` when evidence size matters; it does not start the daemon.
- Run `artifacts prune --older-than-days <days>` without `--apply` to preview candidates.
- Never apply pruning before the final report or while evidence is still needed. Use `--apply` only when retention was requested or old generated evidence is demonstrably disposable.
- Metadata, latest state files, event logs, runtimes, and downloads are protected from this pruning command.

Read [commands.md](references/commands.md) when scenario syntax, command syntax, or the full Microsoft login sequence is needed.
