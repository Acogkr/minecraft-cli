import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-entity-interaction-"));
const workspace = path.join(root, "workspace");
const sessionName = "visual-fixture";
const token = "visual-entity-smoke-token";
const cli = path.resolve("dist", "cli.js");
const interactions = [];

const entities = [
  { id: 77, uuid: "00000000-0000-0000-0000-000000000077", type: "entity.minecraft.player", name: "Npc77", displayName: "Npc77", distance: 3.25 },
  { id: 88, uuid: "00000000-0000-0000-0000-000000000088", type: "minecraft:armor_stand", name: "Marker", displayName: "Marker", distance: 4.0 },
  { id: 99, uuid: "00000000-0000-0000-0000-000000000099", type: "minecraft:player", name: "Npc99", displayName: "Npc99", distance: 6.5 }
];

function json(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length });
  response.end(encoded);
}

const server = http.createServer((request, response) => {
  if (request.headers.authorization !== token) {
    json(response, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/world/entities") {
    json(response, 200, { ok: true, snapshotId: 42, entities });
    return;
  }
  if (url.pathname === "/world/interact-entity") {
    const interaction = Object.fromEntries(url.searchParams.entries());
    interactions.push(interaction);
    json(response, 200, {
      ok: true,
      interacted: true,
      snapshotId: Number(interaction.snapshotId),
      entity: entities.find(entity => entity.id === Number(interaction.entityId))
    });
    return;
  }
  json(response, 404, { ok: false, error: "not_found" });
});

function run(args, expectedStatus = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--json", "--workspace", workspace, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => {
      try {
        assert.equal(status, expectedStatus, stderr || stdout);
        resolve(stdout.trim().startsWith("{") ? JSON.parse(stdout) : stdout);
      } catch (error) {
        reject(error);
      }
    });
  });
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runtimeRoot = path.join(workspace, ".minecraft-cli", "sessions", sessionName);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "visual-client.json"), JSON.stringify({
    name: sessionName,
    version: "1.21.11",
    port: address.port,
    token
  }));

  const help = await run(["visual", "interact-entity", "--help"]);
  assert.match(help, /--entity-id <id>/);
  assert.match(help, /--nearest-type <type>/);

  const direct = await run(["visual", "interact-entity", sessionName, "--entity-id", "77", "--max-distance", "8"]);
  assert.equal(direct.data.snapshotId, 42);
  assert.equal(direct.data.entity.id, 77);
  assert.deepEqual(interactions.at(-1), {
    snapshotId: "42",
    entityId: "77",
    expectedType: "entity.minecraft.player",
    maxDistance: "8"
  });

  const nearest = await run(["visual", "interact-entity", sessionName, "--nearest-type", "player", "--index", "1", "--max-distance", "8"]);
  assert.equal(nearest.data.entity.id, 99);
  assert.deepEqual(interactions.at(-1), {
    snapshotId: "42",
    entityId: "99",
    expectedType: "minecraft:player",
    maxDistance: "8"
  });

  const missingSelector = await run(["visual", "interact-entity", sessionName], 2);
  assert.equal(missingSelector.error.code, "VISUAL_ENTITY_SELECTOR_INVALID");

  const conflictingSelectors = await run(["visual", "interact-entity", sessionName, "--entity-id", "77", "--nearest-type", "player"], 2);
  assert.equal(conflictingSelectors.error.code, "VISUAL_ENTITY_SELECTOR_INVALID");

  const missingId = await run(["visual", "interact-entity", sessionName, "--entity-id", "404"], 2);
  assert.equal(missingId.error.code, "VISUAL_ENTITY_NOT_IN_SNAPSHOT");

  const outOfRange = await run(["visual", "interact-entity", sessionName, "--entity-id", "99", "--max-distance", "5"], 2);
  assert.equal(outOfRange.error.code, "VISUAL_ENTITY_OUT_OF_RANGE");

  const missingTypeIndex = await run(["visual", "interact-entity", sessionName, "--nearest-type", "player", "--index", "2"], 2);
  assert.equal(missingTypeIndex.error.code, "VISUAL_ENTITY_TYPE_NOT_FOUND");
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.stdout.write("Visual direct entity interaction smoke passed: fresh snapshot, id/type binding, distance checks, and selector failures are enforced.\n");
