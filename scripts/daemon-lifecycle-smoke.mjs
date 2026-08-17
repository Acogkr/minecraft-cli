import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-daemon-"));
const workspace = path.join(root, "workspace");
const workspaceAlias = path.join(root, "workspace-alias");
const cli = path.resolve("dist", "cli.js");
const daemonPath = path.resolve("dist", "daemon.js");
fs.mkdirSync(workspace, { recursive: true });
fs.symlinkSync(workspace, workspaceAlias, "junction");

function runAsync(args, selectedWorkspace = workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--json", "--workspace", selectedWorkspace, ...args], {
      cwd: process.cwd(),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      if (code !== 0) reject(new Error(stderr || stdout || `CLI exited with ${code}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

function daemonProcessCount() {
  if (process.platform !== "win32") return undefined;
  const script = "$workspace=$env:TEST_WORKSPACE; $daemon=$env:TEST_DAEMON; @(" +
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -and " +
    "$_.CommandLine.IndexOf($workspace,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and " +
    "$_.CommandLine.IndexOf($daemon,[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, TEST_WORKSPACE: workspace, TEST_DAEMON: daemonPath }
  });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a test port"));
      server.close(() => resolve(address.port));
    });
  });
}

try {
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => runAsync(["session", "list"], index % 2 === 0 ? workspace : workspaceAlias)));
  assert.equal(results.every(result => result.ok === true), true);
  const state = JSON.parse(fs.readFileSync(path.join(workspace, ".minecraft-cli", "runtime", "daemon.json"), "utf8"));
  assert.equal(Number.isInteger(state.pid), true);
  assert.equal(state.workspace.toLowerCase(), fs.realpathSync.native(workspace).toLowerCase());
  if (process.platform === "win32") assert.equal(daemonProcessCount(), 1);

  if (process.platform === "win32") {
    const staleState = { ...state, port: await unusedPort() };
    fs.writeFileSync(path.join(workspace, ".minecraft-cli", "runtime", "daemon.json"), JSON.stringify(staleState, null, 2));
    const startedAt = Date.now();
    const recovered = await runAsync(["session", "list"], workspaceAlias);
    const recoveryMs = Date.now() - startedAt;
    const recoveredState = JSON.parse(fs.readFileSync(path.join(workspace, ".minecraft-cli", "runtime", "daemon.json"), "utf8"));
    assert.equal(recovered.ok, true);
    assert.notEqual(recoveredState.pid, state.pid);
    assert.notEqual(recoveredState.port, staleState.port);
    assert.equal(recoveryMs < 10_000, true, `Stale daemon state recovery took ${recoveryMs}ms`);
    assert.equal(daemonProcessCount(), 1);
  }

  await runAsync(["cleanup"]);
  await new Promise(resolve => setTimeout(resolve, 500));
  if (process.platform === "win32") assert.equal(daemonProcessCount(), 0);
  const alreadyStopped = await runAsync(["cleanup"]);
  assert.equal(alreadyStopped.data.stopped, false);
  assert.equal(alreadyStopped.data.reason, "not_running");
  if (process.platform === "win32") assert.equal(daemonProcessCount(), 0);
} finally {
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.stdout.write("Daemon lifecycle smoke test passed.\n");
