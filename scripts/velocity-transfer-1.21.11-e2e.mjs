import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("dist", "cli.js");
const workspace = process.env.MINECRAFT_CLI_E2E_WORKSPACE || process.cwd();
const session = process.env.MINECRAFT_CLI_E2E_SESSION || "velocity-transfer-12111";
const account = process.env.MINECRAFT_CLI_E2E_ACCOUNT || "main";
const host = process.env.MINECRAFT_CLI_E2E_HOST || "127.0.0.1";
const port = process.env.MINECRAFT_CLI_E2E_PORT || "25565";

function run(args, { allowFailure = false, timeout = 90_000 } = {}) {
  const result = spawnSync(process.execPath, [cli, "--json", "--compact", "--workspace", workspace, ...args], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    timeout
  });
  const stdout = result.stdout.trim();
  const response = stdout ? JSON.parse(stdout) : null;
  if (!allowFailure && (result.status !== 0 || response?.ok !== true)) {
    throw new Error(result.stderr.trim() || stdout || `minecraft-cli exited with status ${result.status}`);
  }
  return response;
}

function horizontalDistance(left, right) {
  return Math.hypot(Number(left.x) - Number(right.x), Number(left.z) - Number(right.z));
}

run(["session", "destroy", session], { allowFailure: true });

try {
  const auth = run(["auth", "status"]);
  const profile = auth.data.accounts.find(candidate => candidate.account === account);
  assert.ok(profile, `Microsoft account alias '${account}' is not authenticated.`);

  run([
    "session", "create", session,
    "--auth", "microsoft",
    "--account", account,
    "--host", host,
    "--port", port,
    "--version", "1.21.11",
    "--connect",
    "--timeout", "90000"
  ], { timeout: 120_000 });

  const beforeState = run(["session", "state", session, "--part", "core"]);
  assert.equal(beforeState.data.connected, true);
  assert.equal(beforeState.data.server.version, "1.21.11");

  const entityState = run(["session", "state", session, "--part", "entities"]);
  const entities = entityState.data.nearbyEntities;
  const activeLabel = entities.find(entity =>
    entity.name === "text_display" &&
    entity.labels.some(label => String(label).toLowerCase().includes(profile.profileName.toLowerCase()))
  );
  assert.ok(activeLabel, `No active Character NPC label was found for '${profile.profileName}'.`);

  const characterNpc = entities
    .filter(entity => entity.name === "player" && String(entity.username || "").startsWith("Npc"))
    .sort((left, right) => horizontalDistance(left.position, activeLabel.position) - horizontalDistance(right.position, activeLabel.position))[0];
  assert.ok(characterNpc, "No Character NPC player entity was found beside the active label.");
  assert.ok(horizontalDistance(characterNpc.position, activeLabel.position) < 0.25, "The active label was not paired with a Character NPC.");

  const beforeEvents = run(["session", "events", session, "--limit", "1"]);
  const afterSequence = Number(beforeEvents.data.nextSequence);

  run([
    "session", "interact", session,
    "--entity-id", String(characterNpc.id),
    "--method", "both",
    "--ticks", "40"
  ]);
  const transition = run([
    "session", "expect-transition", session,
    "--after", String(afterSequence),
    "--timeout-ticks", "240",
    "--stable-ticks", "20"
  ], { timeout: 30_000 });

  const afterState = run(["session", "state", session, "--part", "core"]);
  assert.equal(afterState.data.connected, true);
  assert.notDeepEqual(afterState.data.position, beforeState.data.position, "Velocity transition left the client at the lobby position.");

  const events = run(["session", "events", session, "--limit", "100"]);
  const transitionEvents = events.data.events.filter(event => Number(event.sequence) > afterSequence);
  assert.equal(transitionEvents.some(event => event.type === "kicked" || event.type === "disconnect"), false);
  assert.equal(transitionEvents.some(event => event.data?.state === "configuration"), true);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    session,
    account,
    version: afterState.data.server.version,
    from: beforeState.data.position,
    to: afterState.data.position,
    transition: transition.data
  })}\n`);
} finally {
  run(["session", "destroy", session], { allowFailure: true });
}
