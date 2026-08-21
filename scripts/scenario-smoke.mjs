import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-scenario-"));
const workspace = path.join(root, "workspace");
const scenarioFile = path.join(root, "scenario.json");
const scenarioV2File = path.join(root, "scenario-v2.json");
const scenarioV2FailureFile = path.join(root, "scenario-v2-failure.json");
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

fs.writeFileSync(scenarioV2File, JSON.stringify({
  version: 2,
  name: "runner-v2-smoke",
  timeoutMs: 30_000,
  variables: { expectedAuth: "offline" },
  steps: [
    {
      name: "capture-status",
      args: ["status"],
      capture: { daemonPid: "$.data.daemon.pid" },
      assertions: [
        { path: "$.ok", equals: true },
        { path: "$.data.daemon.pid", gt: 0 },
        { path: "$.data.daemon.pid", gte: 1 },
        { path: "$.data.daemon.pid", lt: 9999999 },
        { path: "$.data.daemon.pid", lte: 9999999 },
        { path: "$.data.daemon.workspace", contains: "workspace" },
        { path: "$.data.daemon.workspace", matches: "workspace$" },
        { path: "$.data.daemon", exists: true },
        { path: "$.data.missing", exists: false },
        { path: "$.ok", notEquals: false }
      ]
    },
    {
      name: "parallel-create",
      parallel: [
        { name: "create-alpha", args: ["session", "create", "alpha"], capture: { alphaName: "$.data.name" } },
        { name: "create-beta", args: ["session", "create", "beta"], capture: { betaName: "$.data.name" } }
      ]
    },
    {
      name: "captured-alpha",
      args: ["session", "state", "${alphaName}", "--part", "core"],
      assertions: [{ path: "$.data.name", equals: "alpha" }, { path: "$.data.auth", equals: "${expectedAuth}" }]
    },
    { name: "repeat-status", args: ["status"], repeat: 3, assertions: [{ path: "$.ok", equals: true }] },
    { name: "retry-allowed", args: ["session", "state", "missing", "--part", "core"], retry: 2, retryDelayMs: 1, allowFailure: true },
    {
      name: "parallel-destroy",
      parallel: [
        { name: "destroy-alpha", args: ["session", "destroy", "${alphaName}"] },
        { name: "destroy-beta", args: ["session", "destroy", "${betaName}"] }
      ],
      when: "always"
    },
    { name: "cleanup-v2", args: ["cleanup"], when: "always" }
  ]
}, null, 2));

fs.writeFileSync(scenarioV2FailureFile, JSON.stringify({
  version: 2,
  name: "runner-v2-failure",
  steps: [
    { name: "create-capsule-bot", args: ["session", "create", "capsule_bot"] },
    { name: "assertion-failure", args: ["session", "state", "capsule_bot", "--part", "core"], assertions: [{ path: "$.data.name", equals: "wrong-name" }] },
    { name: "cleanup-capsule", args: ["cleanup"], when: "always" }
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

function runV2(extraArgs, expectedStatus) {
  const result = spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, "scenario", scenarioV2File, ...extraArgs], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, "scenario v2 output should be single-line JSON");
  return JSON.parse(result.stdout);
}

function runV2Failure(expectedStatus) {
  const result = spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, "scenario", scenarioV2FailureFile], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 90_000
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
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

  const dryRunV2 = runV2(["--dry-run"], 0);
  assert.equal(dryRunV2.data.version, 2);
  assert.equal(dryRunV2.data.stepCount, 9);

  const v2 = runV2([], 0);
  assert.equal(v2.ok, true);
  assert.equal(v2.data.name, "runner-v2-smoke");
  assert.equal(v2.data.passed, 8);
  assert.equal("steps" in v2.data, false);
  const v2Report = JSON.parse(fs.readFileSync(v2.data.reportFile, "utf8"));
  assert.equal(v2Report.version, 2);
  assert.equal(v2Report.steps[1].children[0].captures.alphaName, "alpha");
  assert.equal(v2Report.steps[1].children[1].captures.betaName, "beta");
  assert.equal(v2Report.steps[3].repetitions.length, 3);
  assert.equal(v2Report.steps[4].attempts, 3);
  assert.equal(v2Report.steps[4].allowedFailure, true);
  assert.equal(fs.existsSync(v2Report.steps[4].capsuleFile), true);

  const repeatedV2 = [runV2([], 0), runV2([], 0)];
  for (const repeated of repeatedV2) {
    assert.equal(repeated.ok, true);
    assert.equal(repeated.data.name, v2.data.name);
    assert.equal(repeated.data.passed, v2.data.passed);
    assert.equal(fs.existsSync(repeated.data.reportFile), true);
  }

  const failedV2 = runV2Failure(2);
  assert.equal(failedV2.ok, false);
  assert.equal(failedV2.data.failures.length, 1);
  assert.equal(failedV2.data.failures[0].assertions[0].operator, "equals");
  assert.equal(fs.existsSync(failedV2.data.failures[0].capsuleFile), true);
  const capsuleText = fs.readFileSync(failedV2.data.failures[0].capsuleFile, "utf8");
  const capsule = JSON.parse(capsuleText);
  assert.equal(capsule.kind, "minecraft-cli-failure-capsule");
  assert.equal(capsule.after.probe.data.available, false);
  assert.equal(/"token"\s*:\s*"(?!\[redacted\])/.test(capsuleText), false);
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
