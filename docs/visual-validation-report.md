# Visual Validation Report

Date: 2026-08-12

Lifecycle audit: 2026-08-17

Generic input audit: 2026-08-17

## Scope

- Offline Paper servers and real rendered Fabric clients for `1.20.1`, `1.21.4`, and `1.21.11`
- Headless behavior assertions plus framebuffer visual evidence
- External server connection only; server management remains outside the product

## Results

| Area | 1.20.1 | 1.21.4 | 1.21.11 |
| --- | --- | --- | --- |
| Connect/state | pass | pass | pass |
| NPC right-click GUI | pass | pass | pass |
| GUI item/name/Lore | pass | pass | pass |
| Nested GUI click and ESC/back | pass | pass | pass |
| Chat event and rendered chat | pass | pass | pass |
| Chat hover tooltip and click result | pass | pass | pass |
| Title/subtitle | pass | pass | pass |
| Action bar | pass | pass | pass |
| Boss bar | pass | pass | pass |
| Scoreboard | pass | pass | pass |
| Recipe toast | pass | pass | pass |
| Movement/block/entity/item events | pass | pass | pass |
| Session PNG and JSON metadata | pass | pass | pass |

Arbitrary screens and dialogs use GUI-scaled virtual cursor movement, left/right/middle click, ESC, and framebuffer capture. Semantic control is available for inventory slots and interactive chat. Dialog-specific labels are not promised; visual inspection or screen-specific assertions remain necessary.

Generic text input, navigation/editing keys, and virtual-cursor scrolling are available without taking Windows input focus. All three version adapters compile against their native input APIs. A real Paper `1.21.4` client test verified Korean and ASCII text entry, Backspace, scroll, Enter submission, framebuffer evidence, and matching server chat output. The JSON response reports both attempted and screen-handled character counts so an unfocused field can be detected without reading an image.

## Performance

- Full representative state: `10,647B`; `core` part: `792B` (`92.6%` smaller).
- Six state parts can be requested independently. Only full state plus the small `core` part are written on routine actions; larger part files refresh on demand to reduce disk work.
- 51 recorded framebuffer captures: `85-1,266ms`, `378.8ms` average. The maximum includes first-capture initialization.
- Warm control-mod builds: about one second per adapter in the final run.
- Only keep a rendered client alive around visual checkpoints; headless clients handle continuous behavior tests with much lower memory use.
- A five-step scenario with one explicitly included state returned `934B` instead of the complete `1,729B` report (`46%` fewer output bytes). The exact reduction is emitted for every scenario because it varies with the selected steps and failures.
- Event responses expose a monotonic cursor so repeated polls return only unseen events. Mineflayer's documented `messagestr` alias is no longer stored beside the original `message`, and raw title/boss-bar/scoreboard/window packets are not duplicated after their semantic events.
- A real Paper `1.21.4` chat produced exactly one filtered `message` event. Polling again with its returned `nextSequence` produced zero events, while the server log confirmed the same submitted text.
- Real `1.21.4` framebuffer captures produced SHA-256 and previous-frame change metadata. Comparing two 960×540 PNGs 50 times averaged `19.24ms` per comparison; the live second capture reported 2,304 samples, `0.00447` mean channel delta, and `0.00825` changed-sample ratio.
- Artifact retention is preview-only by default and was tested against old/new screenshots, historical/latest JSON, and scenario reports. Applying the plan removed only four eligible generated files and retained protected/latest files. The real project preview found zero candidates under the default keep counts, so no user evidence was deleted.

## AI Usage

1. Put workflows of three or more actions in a JSON scenario.
2. Keep scenario summary output and mark only required successful data with `includeResponse`.
3. Poll events with the previous `nextSequence` as `--after`.
4. Read screenshot `imageAnalysis` before loading repeated visual evidence.
5. Add `--compact --json` to standalone action commands.
6. Read `state --part core` first.
7. Use semantic `expect-*` commands instead of full state dumps.
8. Request only the state part relevant to a failure.
9. Inspect a screenshot when visual layout, hover, toast, dialog, resource-pack, small text, color, or rendering is the assertion target.

The scenario runner validates commands before execution, skips dependent work after a failure, supports failure-only diagnostics and always-run cleanup, and saves the complete compact report while returning a measured summary/full byte comparison.

A Codex skill is installed at `~/.codex/skills/minecraft-plugin-test` and validates successfully.

## Boundaries

- Supported visual versions are intentionally limited to `1.20.1`, `1.21.4`, and `1.21.11`.
- Microsoft device-code issuance was verified against the live service without approving an account. The CLI opens only a validated Microsoft HTTPS URL with the code prefilled, copies the same code through a non-interpolated Windows process environment, and supports independent `--no-browser` and `--no-clipboard` opt-outs. Cache isolation, redacted metadata, offline regression, MultiMC active-account selection, profile override, and missing-profile rejection are covered by `test:auth`.
- A complete first account approval was intentionally not performed because it requires the user's Microsoft consent. Code issuance is not reported as a completed login; the CLI waits for the authentication flow to finish before returning success.
- Resource-pack acceptance and server-specific custom dialogs require a server fixture that emits them. Generic coordinate control and screenshots are available, but no software can prove every future plugin screen without assertions for that screen.
- The tests prove the documented scenarios on the recorded versions and environment; they do not constitute a mathematical guarantee that no future bug can exist.

## Instance Lifecycle Audit

- Visual slots are created lazily up to a limit of eight per version. A clean isolated prepare created only the base slot, verified by `test:visual-lifecycle`.
- Allocation is serialized with a MultiMC-root lock, so concurrent AI processes cannot claim the same slot.
- Failed launches stop their assigned client automatically, and stopped slots are reused rather than creating unbounded directories.
- A managed `1.21.4` client launched and connected while the user's existing MultiMC launcher and separate `1.21.11` client remained running with unchanged process IDs.
- Managed instance logs retain five files and crash reports retain three files per version.
- Downloads use temporary files plus atomic rename; an existing corrupt Fabric library is discarded and downloaded once more before failing hash validation.
- Two `1.21.4` visual sessions were launched concurrently into slots one and two with different control ports and tokens. Stopping slot one left slot two connected.
- GUI Lore hover rendered on `1.20.1`, `1.21.4`, and `1.21.11` after removing native cursor movement. The Windows pointer coordinates were unchanged before and after each hover command.
- Every created visual slot is forced to contain exactly one `soundCategory_master:0.0` entry.
- MultiMC groups only the managed slots that actually exist under `minecraft-cli`; isolated tests preserved unrelated groups, hidden state, and custom group members.
- The lazy-allocation migration pruned 20 never-launched placeholders from the local MultiMC setup and retained four instances with real launch history.
- Twelve simultaneous first-use CLI calls produced one daemon, and cleanup left zero daemon processes; this is covered by `test:daemon-lifecycle`.
- After updating `minecraft-protocol` to `1.67.0`, the full Paper `1.20.1` behavior E2E completed through final cleanup and disconnect.
- The test plugin now builds reproducibly for Java 17 with Bukkit API `1.20`, so the same fixture can load on every supported server line.
- A duplicate Java process without the visual control port was identified and removed while the controlled client stayed connected. New launches now retain the control-port owner and stop duplicate processes automatically.
