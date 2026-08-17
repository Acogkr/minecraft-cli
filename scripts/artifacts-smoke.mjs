import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-artifacts-"));
const workspace = path.join(root, "workspace");
const cli = path.resolve("dist", "cli.js");
const screenshots = path.join(workspace, ".minecraft-cli", "sessions", "bot", "screenshots");
const json = path.join(workspace, ".minecraft-cli", "sessions", "bot", "json");
const runs = path.join(workspace, ".minecraft-cli", "runs");
for (const directory of [screenshots, json, runs]) fs.mkdirSync(directory, { recursive: true });

const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
function oldFile(file, content = "test") {
  fs.writeFileSync(file, content);
  fs.utimesSync(file, old, old);
}
oldFile(path.join(screenshots, "old-a.png"));
oldFile(path.join(screenshots, "old-b.png"));
oldFile(path.join(json, "2025-01-01T00-00-00-state.json"));
oldFile(path.join(json, "latest-state.json"));
oldFile(path.join(runs, "old-run.json"));
fs.writeFileSync(path.join(screenshots, "new.png"), "new");

function run(args) {
  const result = spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, ...args], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

try {
  const status = run(["artifacts", "status"]);
  assert.equal(status.data.areas.find(area => area.name === "sessions").files, 5);

  const preview = run(["artifacts", "prune", "--older-than-days", "30", "--keep-screenshots", "1", "--keep-json", "0", "--keep-runs", "0"]);
  assert.equal(preview.data.applied, false);
  assert.equal(preview.data.candidates, 4);
  assert.equal(fs.existsSync(path.join(screenshots, "old-a.png")), true);
  assert.equal(fs.existsSync(path.join(json, "latest-state.json")), true);

  const applied = run(["artifacts", "prune", "--older-than-days", "30", "--keep-screenshots", "1", "--keep-json", "0", "--keep-runs", "0", "--apply"]);
  assert.equal(applied.data.removed, 4);
  assert.equal(fs.existsSync(path.join(screenshots, "new.png")), true);
  assert.equal(fs.existsSync(path.join(json, "latest-state.json")), true);
  assert.equal(fs.existsSync(applied.data.reportFile), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("Artifact retention smoke test passed.\n");
