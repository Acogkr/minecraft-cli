import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-checkpoint-"));
const workspace = path.join(root, "workspace");
const cli = path.resolve("dist", "cli.js");
fs.mkdirSync(workspace, { recursive: true });

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, "--json", "--compact", "--workspace", workspace, ...args], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 60_000
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return { raw: result.stdout.trim(), value: JSON.parse(result.stdout) };
}

try {
  run(["session", "create", "checkpoint_bot"]);
  const created = run(["session", "checkpoint", "checkpoint_bot", "--label", "before"]);
  assert.deepEqual(created.value.data.parts, ["core", "window", "ui", "hud", "entities", "inventory", "events"]);
  assert.equal(fs.existsSync(created.value.data.file), true);

  const unchanged = run(["session", "diff", "checkpoint_bot", "--baseline", "before"]);
  assert.equal(unchanged.value.data.changed, false);
  assert.equal(unchanged.value.data.changeCount, 0);
  assert.equal(Buffer.byteLength(unchanged.raw) < 600, true);

  const baseline = JSON.parse(fs.readFileSync(created.value.data.file, "utf8"));
  baseline.parts.core.health = 999;
  fs.writeFileSync(created.value.data.file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  const changed = run(["session", "diff", "checkpoint_bot", "--baseline", "before", "--parts", "core"]);
  assert.equal(changed.value.data.changed, true);
  assert.equal(changed.value.data.parts.core.changes.some(change => change.path === "$.health"), true);

  const asserted = run(["session", "diff", "checkpoint_bot", "--baseline", "before", "--parts", "core", "--assert-unchanged"], 2);
  assert.equal(asserted.value.error.code, "CHECKPOINT_CHANGED");

  const listed = run(["session", "checkpoint-list", "checkpoint_bot"]);
  assert.deepEqual(listed.value.data.checkpoints, ["before"]);
  run(["session", "checkpoint-delete", "checkpoint_bot", "--label", "before"]);
  assert.equal(run(["session", "checkpoint-list", "checkpoint_bot"]).value.data.count, 0);
  run(["cleanup"]);
} finally {
  spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, "cleanup"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

process.stdout.write("Session checkpoint smoke test passed.\n");
