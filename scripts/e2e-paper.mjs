#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const host = process.env.MINECRAFT_CLI_HOST ?? "127.0.0.1";
const port = process.env.MINECRAFT_CLI_PORT ?? "25566";
const version = process.env.MINECRAFT_CLI_VERSION ?? "1.21.4";
const stamp = Date.now().toString().slice(-8);
const session = `e2e_${stamp}`;
const username = `E2E${stamp.slice(-8)}`.slice(0, 16);

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, "--json", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000
  });
  const stdout = result.stdout.trim();
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Non-JSON CLI output for ${args.join(" ")}:\n${stdout}\n${result.stderr}`);
  }
  if (!options.allowFail && (!parsed.ok || result.status !== 0)) {
    throw new Error(`CLI command failed: ${args.join(" ")}\n${JSON.stringify(parsed, null, 2)}`);
  }
  return parsed;
}

function expectOk(label, parsed) {
  if (!parsed.ok) throw new Error(`${label} failed:\n${JSON.stringify(parsed, null, 2)}`);
  console.log(`${label}: ok`);
  return parsed.data;
}

function clearEvents() {
  expectOk("clear events", run(["session", "clear-events", session]));
}

function expectChat(text, timeoutTicks = 80) {
  return expectOk(
    `expect chat ${text}`,
    run(["session", "expect-chat", session, "--contains", text, "--timeout-ticks", String(timeoutTicks)], {
      timeout: timeoutTicks * 50 + 15_000
    })
  );
}

function expectEvent(type, contains, timeoutTicks = 80) {
  const args = ["session", "expect-event", session, "--type", type, "--timeout-ticks", String(timeoutTicks)];
  if (contains) args.push("--contains", contains);
  return expectOk(`expect event ${type}`, run(args, { timeout: timeoutTicks * 50 + 15_000 }));
}

try {
  run(["cleanup"], { allowFail: true, timeout: 50_000 });
  expectOk(
    "connect",
    run(
      [
        "session",
        "create",
        session,
        "--username",
        username,
        "--host",
        host,
        "--port",
        port,
        "--version",
        version,
        "--connect"
      ],
      { timeout: 90_000 }
    )
  );

  clearEvents();
  expectOk("cleanup helper entities", run(["session", "command", session, "mchelper", "cleanup"]));
  expectChat("cleanup removed");

  clearEvents();
  expectOk("spawn npc", run(["session", "command", session, "mcnpc", "spawn"]));
  const npcSpawn = expectChat("npc spawned").match.message;
  const npcIdMatch = npcSpawn.match(/npc spawned (\d+)/);
  if (!npcIdMatch) throw new Error(`Could not parse NPC id from line: ${npcSpawn}`);
  const npcId = npcIdMatch[1];
  expectOk("wait for npc tracking", run(["session", "wait", session, "--ticks", "100"]));
  expectOk("give npc click item", run(["session", "command", session, "mchelper", "give", "stone", "1"]));
  expectOk("equip npc click item", run(["session", "equip-item", session, "--item", "stone"]));
  expectOk("wait for equipped item", run(["session", "wait", session, "--ticks", "10"]));
  expectOk("look at npc", run(["session", "look-at", session, "--entity-id", npcId, "--max-distance", "6"]));
  expectOk("right-click npc with held item", run(["session", "use-on", session, "--entity-id", npcId, "--max-distance", "6", "--ticks", "20"]));
  expectChat("npc clicked");
  expectOk("npc gui emerald", run(["session", "expect-window", session, "--title", "Minecraft CLI NPC GUI", "--slot", "3", "--item", "emerald", "--timeout-ticks", "80"]));
  expectOk("npc gui diamond", run(["session", "expect-window", session, "--slot", "5", "--item", "diamond", "--timeout-ticks", "80"]));
  expectOk("close npc gui", run(["session", "close-window", session, "--ticks", "10"]));

  clearEvents();
  expectOk("look", run(["session", "look", session, "--yaw", "180", "--pitch", "0"]));
  expectOk("move", run(["session", "move", session, "--forward", "--ticks", "5"]));
  expectEvent("move_end", undefined, 20);

  clearEvents();
  expectOk("open root gui", run(["session", "command", session, "mcgui"]));
  expectChat("slot gui opened");
  expectOk(
    "root gui slot 10",
    run([
      "session",
      "expect-window",
      session,
      "--title",
      "Minecraft CLI Slot Test GUI",
      "--slot",
      "10",
      "--item",
      "paper",
      "--name",
      "Paper Menu",
      "--lore",
      "slot 10",
      "--timeout-ticks",
      "80"
    ])
  );
  expectOk(
    "root gui slot 20",
    run([
      "session",
      "expect-window",
      session,
      "--slot",
      "20",
      "--item",
      "book",
      "--name",
      "Book Menu",
      "--lore",
      "slot 20",
      "--timeout-ticks",
      "80"
    ])
  );
  expectOk("click book slot", run(["session", "click-slot", session, "--slot", "20", "--ticks", "20"]));
  expectOk(
    "book detail gui",
    run([
      "session",
      "expect-window",
      session,
      "--title",
      "Minecraft CLI Book Details",
      "--slot",
      "13",
      "--item",
      "book",
      "--name",
      "Book Detail Item",
      "--lore",
      "book detail lore line 1",
      "--timeout-ticks",
      "80"
    ])
  );
  expectOk("esc back", run(["session", "close-window", session, "--ticks", "20"]));
  expectOk(
    "root gui after esc",
    run(["session", "expect-window", session, "--title", "Minecraft CLI Slot Test GUI", "--slot", "10", "--item", "paper", "--timeout-ticks", "80"])
  );
  expectOk("close root gui", run(["session", "close-window", session, "--ticks", "10"]));

  clearEvents();
  expectOk("signals command", run(["session", "command", session, "mchelper", "signals"]));
  expectChat("signals sent");
  expectEvent("title", "Minecraft CLI Title");
  expectEvent("action_bar", "Minecraft CLI Action Bar");
  expectEvent("boss_bar", "Minecraft CLI Boss Bar");
  expectEvent("sound_effect", undefined);
  expectEvent("scoreboard", "Minecraft CLI Scoreboard");

  clearEvents();
  expectOk("setup helper", run(["session", "command", session, "mchelper", "setup"]));
  const setup = expectChat("minecraft-cli-helper setup").match.message;
  const match = setup.match(/setup block (-?\d+) (-?\d+) (-?\d+) floor (-?\d+) (-?\d+) (-?\d+) target (\d+)/);
  if (!match) throw new Error(`Could not parse setup line: ${setup}`);
  const [, bx, by, bz, fx, fy, fz, pigId] = match;
  expectOk("inventory stone", run(["session", "expect-inventory", session, "--item", "stone", "--count", "8", "--timeout-ticks", "80"]));
  expectOk("equip stone", run(["session", "equip-item", session, "--item", "stone"]));
  expectOk("select slot", run(["session", "select-slot", session, "--slot", "0"]));
  expectOk("activate block", run(["session", "activate-block", session, "--x", bx, "--y", by, "--z", bz, "--ticks", "10"]));
  expectChat(`interact-block right_click_block stone ${bx} ${by} ${bz}`);
  expectOk("dig block", run(["session", "dig-block", session, "--x", bx, "--y", by, "--z", bz, "--ticks", "10"]));
  expectChat(`block-break stone ${bx} ${by} ${bz}`);
  expectOk("place block", run(["session", "place-block", session, "--x", fx, "--y", fy, "--z", fz, "--face", "up", "--ticks", "10"]));
  expectChat(`block-place stone ${bx} ${by} ${bz}`);

  clearEvents();
  expectOk("look at pig", run(["session", "look-at", session, "--entity-id", pigId, "--max-distance", "8"]));
  expectOk("right-click pig with held item", run(["session", "use-on", session, "--entity-id", pigId, "--max-distance", "8", "--ticks", "10"]));
  expectChat(`entity-interact-at pig ${pigId}`);
  expectOk("attack pig", run(["session", "attack", session, "--entity-id", pigId, "--max-distance", "8", "--ticks", "10"]));
  expectChat(`entity-damage pig ${pigId}`);
  expectOk("swing arm", run(["session", "swing-arm", session, "--ticks", "10"]));
  expectChat("arm-swing");

  clearEvents();
  expectOk("prepare airspace", run(["session", "command", session, "mchelper", "airspace"]));
  expectChat("airspace ready");
  clearEvents();
  expectOk("give air-use item", run(["session", "command", session, "mchelper", "give", "carrot_on_a_stick", "1"]));
  expectOk("inventory air-use item", run(["session", "expect-inventory", session, "--item", "carrot_on_a_stick", "--count", "1", "--timeout-ticks", "80"]));
  expectOk("equip air-use item", run(["session", "equip-item", session, "--item", "carrot_on_a_stick"]));
  expectOk("use item in air", run(["session", "use-item", session, "--air", "--ticks", "5"]));
  expectChat("interact-item right_click_air carrot_on_a_stick");

  clearEvents();
  expectOk("give stone", run(["session", "command", session, "mchelper", "give", "stone", "2"]));
  expectOk("equip stone again", run(["session", "equip-item", session, "--item", "stone"]));
  expectOk("toss stone", run(["session", "toss-item", session, "--count", "1", "--ticks", "10"]));
  expectChat("item-drop stone 1");
  expectOk("respawn request", run(["session", "respawn", session, "--ticks", "5"]));
  expectEvent("respawn_requested", undefined, 20);

  clearEvents();
  expectOk("cleanup helper entities", run(["session", "command", session, "mchelper", "cleanup"]));
  expectChat("cleanup removed");

  expectOk("cleanup", run(["cleanup"], { timeout: 50_000 }));
  console.log(`minecraft-cli Paper ${version} e2e: ok`);
} catch (error) {
  try {
    const events = run(["session", "events", session, "--limit", "20"], { allowFail: true });
    console.error(JSON.stringify(events, null, 2));
  } catch {
    // Best-effort diagnostics only.
  }
  try {
    run(["cleanup"], { allowFail: true, timeout: 50_000 });
  } catch {
    // Best-effort cleanup only.
  }
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
