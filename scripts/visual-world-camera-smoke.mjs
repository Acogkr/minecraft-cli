import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-world-camera-"));
const workspace = path.join(root, "workspace");
const session = "world-camera";
const token = "world-camera-token";
const legacyToken = "legacy-world-camera-token";
const cli = path.resolve("dist", "cli.js");
const adapterJar = path.resolve("fixtures", "control-mod-1.21.11", "build", "libs", "minecraft-cli-control-1.21.11-0.1.0.jar");
const adapterJarTimes = fs.existsSync(adapterJar) ? fs.statSync(adapterJar) : undefined;
const routes = [];
const clickedActions = [];
const textDisplay = {
  id: 501,
  uuid: "00000000-0000-0000-0000-000000000501",
  type: "minecraft:text_display",
  name: "text_display",
  distance: 18.5,
  textDisplay: {
    text: "스폰 뒷편",
    position: { x: 12, y: 80, z: -4 },
    scale: { x: 6, y: 6, z: 6 },
    seeThrough: true,
    viewRange: 1.5,
    visible: true,
    angularErrorDegrees: 4.25,
    selectionConeDegrees: 1.75,
    screenBounds: { x: 440, y: 220, width: 80, height: 18, pixelWidth: 80, pixelHeight: 18 }
  }
};
const secondTextDisplay = {
  ...textDisplay,
  id: 502,
  uuid: "00000000-0000-0000-0000-000000000502",
  distance: 75.26,
  textDisplay: { ...textDisplay.textDisplay, text: "새 워프", screenBounds: { ...textDisplay.textDisplay.screenBounds, x: 600 } }
};

const state = {
  ok: true,
  controlProtocol: 2,
  version: "1.21.11",
  connected: true,
  screen: "game",
  framebufferWidth: 960,
  framebufferHeight: 540,
  guiScale: 2,
  configuredGuiScale: 2,
  fov: 70,
  yaw: 10,
  pitch: -5,
  perspective: "first",
  resourcePacks: { selected: ["vanilla"], available: ["vanilla"] },
  capabilities: { npcRoleInteraction: true, framebuffer: true, rotation: true, perspective: true, textDisplayProjection: true, screenActions: true, nativeDialog: true }
};

function respond(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  response.end(data);
}

const server = http.createServer((request, response) => {
  if (![token, legacyToken].includes(request.headers.authorization)) return respond(response, 401, { ok: false, error: "unauthorized" });
  const url = new URL(request.url, "http://127.0.0.1");
  routes.push(`${url.pathname}?${url.searchParams}`);
  if (request.headers.authorization === legacyToken && url.pathname === "/state") return respond(response, 200, { ok: true, version: "1.21.11", connected: true, screen: "game", capabilities: { worldPosition: true } });
  if (url.pathname === "/state") return respond(response, 200, state);
  if (url.pathname === "/world/entities") return respond(response, 200, { ...state, snapshotId: 9, entities: [textDisplay, secondTextDisplay] });
  if (url.pathname === "/world/rotate") return respond(response, 200, { ...state, yaw: Number(url.searchParams.get("yaw")), pitch: Number(url.searchParams.get("pitch")) });
  if (url.pathname === "/world/perspective") return respond(response, 200, { ...state, perspective: url.searchParams.get("mode") });
  if (url.pathname === "/world/aim-text") return respond(response, 200, { ...state, target: textDisplay, beforeAim: textDisplay.textDisplay });
  if (url.pathname === "/world/use-item") return respond(response, 200, { ...state, usedItem: true });
  if (url.pathname === "/screen/actions") return respond(response, 200, { ...state, title: "캐릭터 로그아웃", actions: [
    { actionIndex: 0, actionId: "dialog:0", text: "저장하고 로그아웃", x: 340, y: 300, width: 140, height: 20, source: "dialog-layout", dialogUserAction: true },
    { actionIndex: 1, actionId: "dialog:1", text: "계속 플레이", x: 490, y: 300, width: 100, height: 20, source: "dialog-layout", dialogUserAction: true },
    { actionIndex: 2, actionId: "dialog-warning", text: "", x: 920, y: 10, width: 20, height: 20, source: "dialog-warning", dialogUserAction: false }
  ] });
  if (url.pathname === "/screen/click-action") {
    clickedActions.push(url.searchParams.get("actionId") ?? url.searchParams.get("index"));
    return respond(response, 200, { ...state, screen: "game", handled: true, callbackInvoked: true,
      action: { actionIndex: 0, actionId: "dialog:0", text: "저장하고 로그아웃", source: "dialog-layout", dialogUserAction: true } });
  }
  response.writeHead(404, { "content-type": "text/html" });
  response.end("<html><body>Not Found</body></html>");
});

function run(args, expected = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--json", "--workspace", workspace, ...args], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
    child.once("error", reject);
    child.once("close", code => {
      try {
        assert.equal(code, expected, stderr || stdout);
        resolve(stdout.trim().startsWith("{") ? JSON.parse(stdout) : stdout);
      } catch (error) { reject(error); }
    });
  });
}

try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runtimeRoot = path.join(workspace, ".minecraft-cli", "sessions", session);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "visual-client.json"), JSON.stringify({
    name: session, version: "1.21.11", port: address.port, token, auth: "offline",
    displaySettings: { width: 960, height: 540, guiScale: 2, fov: 70 }
  }));
  const legacyRoot = path.join(workspace, ".minecraft-cli", "sessions", "legacy-camera");
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "visual-client.json"), JSON.stringify({ name: "legacy-camera", version: "1.21.11", port: address.port, token: legacyToken }));

  const current = await run(["visual", "state", session]);
  assert.equal(current.data.framebufferWidth, 960);
  assert.equal(current.data.requestedDisplay.guiScale, 2);

  const labels = await run(["visual", "text-displays", session, "--text", "스폰"]);
  assert.equal(labels.data.count, 1);
  assert.equal(labels.data.textDisplays[0].textDisplay.screenBounds.pixelHeight, 18);
  const allLabels = await run(["visual", "text-displays", session]);
  assert.equal(allLabels.data.count, 2);

  const staleRotate = await run(["visual", "rotate", "legacy-camera", "--yaw", "45", "--pitch", "0", "--relative"], 2);
  assert.equal(staleRotate.error.code, "VISUAL_CONTROL_ADAPTER_STALE");
  const stalePerspective = await run(["visual", "perspective", "legacy-camera", "--mode", "third-back"], 2);
  assert.equal(stalePerspective.error.code, "VISUAL_CONTROL_ADAPTER_STALE");

  const html404 = await run(["visual", "interact-role", session, "--role", "missing"], 2);
  assert.equal(html404.error.code, "VISUAL_ROUTE_UNAVAILABLE");

  const rotated = await run(["visual", "rotate", session, "--yaw", "35", "--pitch", "-12", "--relative"]);
  assert.equal(rotated.data.yaw, 35);
  assert.match(routes.at(-1), /relative=true/);

  const perspective = await run(["visual", "perspective", session, "--mode", "third-back"]);
  assert.equal(perspective.data.perspective, "third-back");

  const dialogActions = await run(["actor", "actions", session]);
  assert.deepEqual(dialogActions.data.result.actions.map(action => action.actionId), ["dialog:0", "dialog:1", "dialog-warning"]);
  assert.equal(dialogActions.data.result.actions[0].text, "저장하고 로그아웃");
  assert.equal(dialogActions.data.result.actions[0].dialogUserAction, true);
  const clickedDialog = await run(["actor", "click-action", session, "--action-id", "dialog:0"]);
  assert.equal(clickedDialog.data.result.callbackInvoked, true);
  assert.deepEqual(clickedActions, ["dialog:0"]);

  const aimed = await run(["actor", "aim-text", session, "--text", "스폰 뒷편", "--max-angular-miss", "8", "--min-pixel-height", "12", "--max-pixel-height", "28", "--click"]);
  assert.equal(aimed.data.clicked, true);
  assert.equal(aimed.data.clickResult.usedItem, true);
  assert.match(routes.at(-2), /minPixelHeight=12/);

  const unavailable = await run(["actor", "capture-pair", session, "--observer", "missing"], 2);
  assert.equal(unavailable.error.code, "ACTOR_CAPABILITY_UNAVAILABLE");

  const invalidFramebuffer = await run(["visual", "prepare", "bad", "--width", "100", "--height", "540"], 2);
  assert.equal(invalidFramebuffer.error.code, "VISUAL_FRAMEBUFFER_INVALID");

  const fakeMultiMc = path.join(root, "MultiMC");
  const loaderVersion = "0.19.3";
  fs.mkdirSync(path.join(fakeMultiMc, "meta", "net.fabricmc.fabric-loader"), { recursive: true });
  fs.writeFileSync(path.join(fakeMultiMc, "MultiMC.exe"), "fixture");
  fs.writeFileSync(path.join(fakeMultiMc, "meta", "net.fabricmc.fabric-loader", `${loaderVersion}.json`), JSON.stringify({ libraries: [] }));
  const intermediary = path.join(fakeMultiMc, "libraries", "net", "fabricmc", "intermediary", "1.21.11", "intermediary-1.21.11.jar");
  fs.mkdirSync(path.dirname(intermediary), { recursive: true });
  fs.writeFileSync(intermediary, "fixture");
  const sourceOptions = path.join(fakeMultiMc, "instances", "1.21.11", ".minecraft", "options.txt");
  fs.mkdirSync(path.dirname(sourceOptions), { recursive: true });
  fs.writeFileSync(sourceOptions, "guiScale:3\nfov:80\nresourcePacks:[\"vanilla\"]\n");
  const packZip = path.join(root, "modelengine-core.zip");
  fs.writeFileSync(packZip, Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64"));
  if (adapterJarTimes) {
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(adapterJar, future, future);
  }

  const prepared = await run(["visual", "prepare", "pack-fixture", "--version", "1.21.11", "--multimc", fakeMultiMc,
    "--width", "1280", "--height", "720", "--gui-scale", "2", "--fov", "75", "--resource-pack", packZip, "--pack-uuid", "modelengine-core"]);
  assert.equal(prepared.data.resourcePack.uuid, "modelengine-core");
  assert.equal(fs.existsSync(prepared.data.resourcePack.file), true);
  const managedOptions = path.join(prepared.data.instanceRoot, ".minecraft", "options.txt");
  assert.match(fs.readFileSync(managedOptions, "utf8"), /guiScale:2/);
  assert.match(fs.readFileSync(managedOptions, "utf8"), /minecraft-cli-modelengine-core/);

  const stopped = await run(["visual", "stop", "pack-fixture"]);
  assert.equal(stopped.data.restore.restored, true);
  assert.equal(fs.existsSync(prepared.data.resourcePack.file), false);
  assert.equal(fs.existsSync(managedOptions), false);
} finally {
  if (adapterJarTimes && fs.existsSync(adapterJar)) fs.utimesSync(adapterJar, adapterJarTimes.atime, adapterJarTimes.mtime);
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.stdout.write("Visual world camera smoke passed: display state, rotation, perspective, TextDisplay targeting, pair capability failure, and resource-pack restore are enforced.\n");
