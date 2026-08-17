import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-visual-"));
const multiMcRoot = path.join(root, "multimc");
const workspace = path.join(root, "workspace");
const cli = path.resolve("dist", "cli.js");
const intermediary = path.join(multiMcRoot, "libraries", "net", "fabricmc", "intermediary", "1.21.4", "intermediary-1.21.4.jar");
const loaderMetadata = path.join(multiMcRoot, "meta", "net.fabricmc.fabric-loader", "0.18.1.json");

fs.mkdirSync(path.dirname(intermediary), { recursive: true });
fs.mkdirSync(path.dirname(loaderMetadata), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(multiMcRoot, "MultiMC.exe"), "test");
fs.writeFileSync(intermediary, "test");
fs.writeFileSync(loaderMetadata, JSON.stringify({ libraries: [] }));

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

try {
  const invalidScroll = run(["visual", "scroll", "missing", "--delta", "0"], 2);
  assert.equal(invalidScroll.error.code, "VISUAL_SCROLL_INVALID");

  const invalidModifiers = run(["visual", "press-key", "missing", "enter", "--modifiers", "8"], 2);
  assert.equal(invalidModifiers.error.code, "VISUAL_MODIFIERS_INVALID");

  const excessiveText = run(["visual", "type-text", "missing", "x".repeat(4097)], 2);
  assert.equal(excessiveText.error.code, "VISUAL_TEXT_TOO_LONG");

  const invalidElementIndex = run(["visual", "click-element", "missing", "Confirm", "--index", "-1"], 2);
  assert.equal(invalidElementIndex.error.code, "VISUAL_ELEMENT_INDEX_INVALID");

  const prepared = run(["visual", "prepare", "lazy-one", "--version", "1.21.4", "--multimc", multiMcRoot]);
  assert.equal(prepared.data.instanceId, "minecraft-cli-1.21.4");
  assert.equal(prepared.data.createdInstance, true);
  assert.equal("createdSlots" in prepared.data, false);

  const managed = fs.readdirSync(path.join(multiMcRoot, "instances"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("minecraft-cli-"))
    .map(entry => entry.name);
  assert.deepEqual(managed, ["minecraft-cli-1.21.4"]);

  const groups = JSON.parse(fs.readFileSync(path.join(multiMcRoot, "instances", "instgroups.json"), "utf8"));
  assert.deepEqual(groups.groups["minecraft-cli"].instances, ["minecraft-cli-1.21.4"]);

  const baseInstance = path.join(multiMcRoot, "instances", "minecraft-cli-1.21.4");
  const emptyPlaceholder = path.join(multiMcRoot, "instances", "minecraft-cli-1.21.4-2");
  const modifiedPlaceholder = path.join(multiMcRoot, "instances", "minecraft-cli-1.21.4-3");
  fs.cpSync(baseInstance, emptyPlaceholder, { recursive: true });
  fs.cpSync(baseInstance, modifiedPlaceholder, { recursive: true });
  fs.writeFileSync(path.join(modifiedPlaceholder, "user-file.txt"), "keep");

  const pruned = run(["visual", "prune", "--multimc", multiMcRoot]);
  assert.deepEqual(pruned.data.removed, ["minecraft-cli-1.21.4-2"]);
  assert.equal(pruned.data.skipped.includes("minecraft-cli-1.21.4-3"), true);
  assert.equal(fs.existsSync(emptyPlaceholder), false);
  assert.equal(fs.existsSync(modifiedPlaceholder), true);
  run(["visual", "stop", "lazy-one"]);
} finally {
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.stdout.write("Visual instance lifecycle smoke test passed.\n");
