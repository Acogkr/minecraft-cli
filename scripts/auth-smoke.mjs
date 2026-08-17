import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-auth-"));
const authRoot = path.join(root, "auth");
const workspace = path.join(root, "workspace");
const cli = path.resolve("dist", "cli.js");
fs.mkdirSync(workspace, { recursive: true });

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, MINECRAFT_CLI_AUTH_ROOT: authRoot }
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

try {
  assert.deepEqual(run(["auth", "status"]).data.accounts, []);
  assert.equal(run(["auth", "status", "missing"], 2).error.code, "MICROSOFT_AUTH_REQUIRED");

  const accountRoot = path.join(authRoot, "accounts", "main");
  fs.mkdirSync(path.join(accountRoot, "cache"), { recursive: true });
  fs.writeFileSync(path.join(accountRoot, "profile.json"), JSON.stringify({
    account: "main",
    profileName: "TestProfile",
    profileId: "0123456789abcdef0123456789abcdef",
    signedInAt: "2026-01-01T00:00:00.000Z"
  }));

  const status = run(["auth", "status", "main"]);
  assert.deepEqual(status.data.accounts[0], {
    account: "main",
    profileName: "TestProfile",
    signedInAt: "2026-01-01T00:00:00.000Z"
  });

  const microsoft = run(["session", "create", "ms-bot", "--auth", "microsoft", "--account", "main"]);
  assert.equal(microsoft.data.auth, "microsoft");
  assert.equal(microsoft.data.account, "main");

  const core = run(["session", "state", "ms-bot", "--part", "core"]);
  assert.equal(core.data.auth, "microsoft");
  assert.equal(core.data.account, "main");

  const metadata = fs.readFileSync(path.join(workspace, ".minecraft-cli", "sessions", "ms-bot", "metadata.json"), "utf8");
  assert.equal(/accessToken|refresh_token|device_code|token/i.test(metadata), false);

  const offline = run(["session", "create", "offline-bot", "--username", "OfflineBot"]);
  assert.equal(offline.data.auth, "offline");
  assert.equal("account" in offline.data, false);

  const multiMcRoot = path.join(root, "multimc");
  fs.mkdirSync(multiMcRoot, { recursive: true });
  const visualError = run([
    "visual", "launch", "visual-ms",
    "--auth", "microsoft",
    "--profile", "MissingProfile",
    "--host", "127.0.0.1",
    "--port", "25565",
    "--multimc", multiMcRoot
  ], 2);
  assert.equal(visualError.error.code, "MULTIMC_ACCOUNT_NOT_FOUND");

  fs.writeFileSync(path.join(multiMcRoot, "accounts.json"), JSON.stringify({
    formatVersion: 3,
    accounts: [
      { active: false, profile: { name: "OtherPlayer", id: "1" } },
      { active: true, profile: { name: "ActivePlayer", id: "2" } }
    ]
  }));
  const activeAccount = run([
    "visual", "launch", "visual-active",
    "--auth", "microsoft",
    "--host", "127.0.0.1",
    "--port", "25565",
    "--multimc", multiMcRoot
  ], 2);
  assert.equal(activeAccount.error.code, "MULTIMC_NOT_FOUND");

  const selectedAccount = run([
    "visual", "launch", "visual-selected",
    "--auth", "microsoft",
    "--profile", "OtherPlayer",
    "--host", "127.0.0.1",
    "--port", "25565",
    "--multimc", multiMcRoot
  ], 2);
  assert.equal(selectedAccount.error.code, "MULTIMC_NOT_FOUND");
} finally {
  try {
    run(["cleanup"]);
  } catch {
    // The daemon may not have started if an earlier assertion failed.
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.stdout.write("Microsoft authentication smoke test passed.\n");
