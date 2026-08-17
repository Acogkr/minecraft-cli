import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-events-"));
const workspace = path.join(root, "workspace");
const cli = path.resolve("dist", "cli.js");
fs.mkdirSync(workspace, { recursive: true });

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, "--json", "--compact", "--workspace", workspace, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

try {
  run(["session", "create", "eventbot", "--username", "EventBot", "--host", "127.0.0.1", "--port", "25565", "--version", "1.21.4"]);
  const initial = run(["session", "events", "eventbot"]);
  assert.equal(initial.data.count, 1);
  assert.equal(initial.data.events[0].sequence, 1);
  assert.equal(initial.data.nextSequence, 1);

  const delta = run(["session", "events", "eventbot", "--after", "1"]);
  assert.equal(delta.data.count, 0);
  assert.equal(delta.data.afterSequence, 1);
  assert.equal(delta.data.nextSequence, 1);

  const invalid = run(["session", "events", "eventbot", "--after", "-1"], 2);
  assert.equal(invalid.error.code, "INVALID_EVENT_SEQUENCE");

  run(["session", "clear-events", "eventbot"]);
  const cleared = run(["session", "events", "eventbot", "--after", "1"]);
  assert.equal(cleared.data.count, 0);
  assert.equal(cleared.data.nextSequence, 1);
  run(["session", "destroy", "eventbot"]);
  run(["cleanup"]);
} finally {
  spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, "cleanup"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 60_000
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
}

process.stdout.write("Event cursor smoke test passed.\n");
