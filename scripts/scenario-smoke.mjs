import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-scenario-"));
const workspace = path.join(root, "workspace");
const scenarioFile = path.join(root, "scenario.json");
const cli = path.resolve("dist", "cli.js");
fs.mkdirSync(workspace, { recursive: true });

fs.writeFileSync(scenarioFile, JSON.stringify({
  version: 1,
  name: "runner-smoke",
  timeoutMs: 30_000,
  steps: [
    { name: "initial-status", args: ["status"] },
    { name: "expected-failure", args: ["visual", "scroll", "missing", "--delta", "0"] },
    { name: "skipped-after-failure", args: ["status"] },
    { name: "failure-diagnostic", args: ["status"], when: "failure", includeResponse: true },
    { name: "cleanup", args: ["cleanup"], when: "always" }
  ]
}, null, 2));

function run(extraArgs, expectedStatus) {
  const result = spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, "scenario", scenarioFile, ...extraArgs], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, "scenario output should be single-line JSON");
  return JSON.parse(result.stdout);
}

try {
  const dryRun = run(["--dry-run"], 0);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.data.stepCount, 5);
  assert.equal(fs.existsSync(path.join(workspace, ".minecraft-cli")), false);

  const result = run([], 2);
  assert.equal(result.ok, false);
  assert.equal(result.data.passed, 3);
  assert.equal(result.data.failed, 1);
  assert.equal(result.data.skipped, 1);
  assert.equal(result.data.steps[1].response.error.code, "VISUAL_SCROLL_INVALID");
  assert.equal(result.data.steps[2].skipped, true);
  assert.equal(result.data.steps[3].response.ok, true);
  assert.equal(result.data.output.savedBytes > 0, true);
  assert.equal(result.data.output.reductionPercent > 0, true);
  assert.equal(fs.existsSync(result.data.reportFile), true);

  const report = JSON.parse(fs.readFileSync(result.data.reportFile, "utf8"));
  assert.equal(report.steps.length, 5);
  assert.equal(report.steps[0].response.ok, true);
  assert.equal(report.steps[4].response.ok, true);

  const full = run(["--full"], 2);
  assert.equal(full.data.steps.length, 5);
  assert.equal(full.data.steps[0].response.ok, true);
} finally {
  spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, "cleanup"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
}

process.stdout.write("Scenario runner smoke test passed.\n");
