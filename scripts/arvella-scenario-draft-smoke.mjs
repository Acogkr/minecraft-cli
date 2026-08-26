import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-arvella-drafts-"));
const cli = path.resolve("dist", "cli.js");
const suites = [
  {
    root: path.resolve("fixtures", "scenarios", "arvella"),
    expected: new Map([
      ["npc-shop-open.json", 6],
      ["job-restricted-quest.json", 11],
      ["quest-guidance-actionbar.json", 7],
      ["character-last-location.json", 7]
    ])
  },
  {
    root: path.resolve("fixtures", "scenarios", "arvella-world"),
    expected: new Map([
      ["character-logout-dialog.json", 7],
      ["modelengine-pack-off.json", 9],
      ["modelengine-pack-on.json", 10],
      ["world-textdisplay-camera.json", 9]
    ])
  }
];

try {
  for (const suite of suites) {
    for (const [fileName, stepCount] of suite.expected) {
      const file = path.join(suite.root, fileName);
      const definition = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(definition.version, 2);
      assert.equal(definition.steps.some(step => step.args?.[0] === "visual" && ["launch", "prepare"].includes(step.args?.[1])), false);
      assert.equal(definition.steps.some(step => step.args?.[0] === "probe"), false);

      const result = spawnSync(process.execPath, [cli, "--json", "--workspace", workspace, "scenario", file, "--dry-run"], {
        cwd: process.cwd(),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, true);
      assert.equal(response.data.version, 2);
      assert.equal(response.data.stepCount, stepCount);
    }
  }
  assert.equal(fs.existsSync(path.join(workspace, ".minecraft-cli")), false);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.stdout.write("Arvella scenario draft smoke test passed.\n");
