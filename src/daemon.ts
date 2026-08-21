#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { MinecraftCliError, toErrorResponse } from "./errors";
import { getFreePort, isPortOpen } from "./ipc";
import { ensureBaseDirs, getPaths } from "./paths";
import { accountPaths, normalizeAccountAlias, normalizeAuthMode, readAccountProfile, type MinecraftAuthMode } from "./auth-store";
import type { DaemonStateFile, SessionEvent, SessionSnapshot } from "./types";

const nodeRequire = createRequire(__filename);
const mineflayer = nodeRequire("mineflayer");

type Bot = any;

interface SessionRecord {
  name: string;
  username: string;
  auth: MinecraftAuthMode;
  account?: string;
  createdAt: string;
  connecting: boolean;
  connected: boolean;
  host: string;
  port: number;
  version: string;
  bot?: Bot;
  events: SessionEvent[];
  nextEventSequence: number;
  interactionSequence: number;
  pendingTransfer?: { host: string; port: number };
}

const args = process.argv.slice(2);
const workspaceArg = readFlag(args, "--workspace") ?? process.cwd();
const paths = getPaths(workspaceArg);
const workspace = paths.workspace;
ensureBaseDirs(paths);

const sessions = new Map<string, SessionRecord>();
const daemonToken = crypto.randomBytes(32).toString("hex");
let shuttingDown = false;
let httpServer: http.Server | null = null;

main().catch((error) => {
  const response = toErrorResponse(error);
  process.stderr.write(`${JSON.stringify(response, null, 2)}\n`);
  process.exit(1);
});

function readFlag(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  return values[index + 1];
}

async function main() {
  const port = await getFreePort();
  httpServer = http.createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(port, "127.0.0.1", resolve);
  });

  const state: DaemonStateFile = {
    pid: process.pid,
    port,
    token: daemonToken,
    workspace,
    startedAt: new Date().toISOString()
  };
  fs.writeFileSync(paths.daemonState, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });

  process.once("SIGINT", () => void stopDaemon(30_000));
  process.once("SIGTERM", () => void stopDaemon(30_000));
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (request.headers.authorization !== daemonToken) {
      writeJson(response, 401, { ok: false, error: { code: "DAEMON_UNAUTHORIZED", message: "Invalid daemon token." } });
      return;
    }
    const body = await readJsonBody(request);
    const result = await route(request.method ?? "GET", url, body);
    writeJson(response, 200, { ok: true, data: result });
  } catch (error) {
    const payload = toErrorResponse(error);
    const status = error instanceof MinecraftCliError ? error.status : 500;
    writeJson(response, status, payload);
  }
}

function writeJson(response: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

async function readJsonBody(request: http.IncomingMessage) {
  if (request.method === "GET" || request.method === "DELETE") return undefined;
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) {
      throw new MinecraftCliError("REQUEST_TOO_LARGE", "Daemon request body exceeds 1 MiB.", 413);
    }
  }
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new MinecraftCliError("BAD_JSON", "Request body is not valid JSON.", 400);
  }
}

async function route(method: string, url: URL, body: any) {
  const pathname = decodeURIComponent(url.pathname);

  if (method === "GET" && pathname === "/health") {
    return { pid: process.pid, workspace, uptimeSeconds: process.uptime() };
  }

  if (method === "GET" && pathname === "/status") return getStatus();
  if (method === "POST" && pathname === "/daemon/stop") return stopDaemon(Number(body?.timeoutMs ?? 30_000));

  if (method === "GET" && pathname === "/session") return listSessions();
  if (method === "POST" && pathname === "/session/create") return createSession(body ?? {});

  const sessionMatch = pathname.match(/^\/session\/([^/]+)(?:\/([^/]+))?$/);
  if (sessionMatch) {
    const name = sessionMatch[1];
    const action = sessionMatch[2];
    if (method === "DELETE" && !action) return destroySession(name);
    if (method === "GET" && action === "state") return getSessionState(name, url.searchParams.get("part") ?? undefined);
    if (method === "POST" && action === "connect") return connectSession(name, Number(body?.timeout ?? body?.timeoutMs ?? 60_000), body ?? {});
    if (method === "POST" && action === "disconnect") return disconnectSession(name, Number(body?.timeout ?? body?.timeoutMs ?? 20_000));
    if (method === "POST" && action === "chat") return sessionChat(name, String(body?.message ?? ""));
    if (method === "POST" && action === "command") return sessionCommand(name, String(body?.command ?? ""));
    if (method === "POST" && action === "move") return sessionMove(name, body ?? {});
    if (method === "POST" && action === "select-slot") return sessionSelectSlot(name, body ?? {});
    if (method === "POST" && action === "equip-item") return sessionEquipItem(name, body ?? {});
    if (method === "POST" && action === "look") return sessionLook(name, Number(body?.yaw), Number(body?.pitch));
    if (method === "POST" && action === "look-at") return sessionLookAt(name, body ?? {});
    if (method === "POST" && action === "interact") return sessionInteract(name, body ?? {});
    if (method === "POST" && action === "use-on") return sessionUseOn(name, body ?? {});
    if (method === "POST" && action === "wait") return sessionWait(name, Number(body?.ticks ?? 20));
    if (method === "POST" && action === "use-item") return sessionUseItem(name, body ?? {});
    if (method === "POST" && action === "activate-block") return sessionActivateBlock(name, body ?? {});
    if (method === "POST" && action === "dig-block") return sessionDigBlock(name, body ?? {});
    if (method === "POST" && action === "place-block") return sessionPlaceBlock(name, body ?? {});
    if (method === "POST" && action === "attack") return sessionAttack(name, body ?? {});
    if (method === "POST" && action === "toss-item") return sessionTossItem(name, body ?? {});
    if (method === "POST" && action === "swing-arm") return sessionSwingArm(name, body ?? {});
    if (method === "POST" && action === "respawn") return sessionRespawn(name, body ?? {});
    if (method === "POST" && action === "click-slot") return sessionClickSlot(name, body ?? {});
    if (method === "POST" && action === "click-item") return sessionClickItem(name, body ?? {});
    if (method === "POST" && action === "close-window") return sessionCloseWindow(name, body ?? {});
    if (method === "POST" && action === "expect-event") return sessionExpectEvent(name, body ?? {});
    if (method === "GET" && action === "events") return getSessionEvents(name, queryOptions(url));
    if (method === "POST" && action === "clear-events") return clearSessionEvents(name);
    if (method === "POST" && action === "expect-chat") return sessionExpectChat(name, body ?? {});
    if (method === "POST" && action === "expect-window") return sessionExpectWindow(name, body ?? {});
    if (method === "POST" && action === "expect-inventory") return sessionExpectInventory(name, body ?? {});
  }

  throw new MinecraftCliError("NOT_FOUND", `${method} ${pathname} is not a minecraft-cli daemon route.`, 404);
}

function getStatus() {
  return {
    daemon: {
      pid: process.pid,
      workspace,
      uptimeSeconds: Math.round(process.uptime())
    },
    sessions: listSessions()
  };
}

async function createSession(options: any) {
  const name = normalizeSessionName(String(options.name ?? ""));
  const auth = normalizeAuthMode(options.auth);
  const account = auth === "microsoft" ? normalizeAccountAlias(options.account) : undefined;
  const username = auth === "microsoft"
    ? readAccountProfile(account).profileName
    : normalizeUsername(String(options.username ?? name));
  const host = normalizeHost(String(options.host ?? "127.0.0.1"));
  const port = normalizePort(Number(options.port ?? 25565));
  const version = normalizeVersion(String(options.version ?? "1.21.4"));
  if (sessions.has(name)) {
    throw new MinecraftCliError("SESSION_ALREADY_EXISTS", `Session '${name}' already exists.`, 409);
  }
  const record: SessionRecord = {
    name,
    username,
    auth,
    ...(account ? { account } : {}),
    createdAt: new Date().toISOString(),
    connecting: false,
    connected: false,
    host,
    port,
    version,
    events: [],
    nextEventSequence: 0,
    interactionSequence: 0
  };
  sessions.set(name, record);
  ensureSessionDirs(record);
  persistSessionMetadata(record);
  addEvent(record, "created", `Session ${name} created for ${username} using ${auth} authentication.`);

  if (options.connect) await connectSession(name, Number(options.timeout ?? options.timeoutMs ?? 60_000));
  return snapshotSession(record);
}

function normalizeSessionName(name: string) {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(trimmed)) {
    throw new MinecraftCliError("INVALID_SESSION_NAME", "Session name must be 1-32 letters, numbers, underscores, or hyphens.");
  }
  return trimmed;
}

function normalizeUsername(username: string) {
  const trimmed = username.trim();
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(trimmed)) {
    throw new MinecraftCliError("INVALID_USERNAME", "Offline Minecraft username must be 3-16 letters, numbers, or underscores.");
  }
  return trimmed;
}

function normalizeHost(host: string) {
  const trimmed = host.trim();
  if (!trimmed || /[\s/]/.test(trimmed)) {
    throw new MinecraftCliError("INVALID_HOST", "Server host must be a hostname or IP address.");
  }
  return trimmed;
}

function normalizePort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MinecraftCliError("INVALID_PORT", "Server port must be between 1 and 65535.");
  }
  return port;
}

function normalizeVersion(version: string) {
  const trimmed = version.trim();
  if (!trimmed) {
    throw new MinecraftCliError("INVALID_VERSION", "Minecraft version cannot be empty.");
  }
  return trimmed;
}

function requireSession(name: string) {
  const record = sessions.get(normalizeSessionName(name));
  if (!record) throw new MinecraftCliError("SESSION_NOT_FOUND", `Session '${name}' does not exist.`, 404);
  return record;
}

function requireConnectedSession(name: string) {
  const record = requireSession(name);
  if (!record.bot || !record.connected) {
    throw new MinecraftCliError("SESSION_NOT_CONNECTED", `Session '${name}' is not connected.`, 409);
  }
  return record;
}

async function connectSession(name: string, timeoutMs = 60_000, options: any = {}) {
  const record = requireSession(name);
  if (record.connected && record.bot) return snapshotSession(record);
  if (record.connecting) {
    throw new MinecraftCliError("SESSION_CONNECTING", `Session '${name}' is already connecting.`, 409);
  }

  if (options.host !== undefined) record.host = normalizeHost(String(options.host));
  if (options.port !== undefined) record.port = normalizePort(Number(options.port));
  if (options.version !== undefined) record.version = normalizeVersion(String(options.version));

  record.connecting = true;
  addEvent(record, "connect_start", `Connecting to ${record.host}:${record.port} (${record.version}).`);

  if (!(await isPortOpen(record.port, record.host, 3000))) {
    record.connecting = false;
    addEvent(record, "connect_failed", `Server is not reachable at ${record.host}:${record.port}.`);
    throw new MinecraftCliError("SERVER_UNREACHABLE", `No Minecraft server is reachable at ${record.host}:${record.port}.`, 409);
  }

  const bot = mineflayer.createBot({
    host: record.host,
    port: record.port,
    username: record.auth === "microsoft" ? record.account! : record.username,
    auth: record.auth,
    ...(record.auth === "microsoft" ? {
      profilesFolder: accountPaths(record.account).cache,
      onMsaCode: () => {
        addEvent(record, "microsoft_auth_required", `Cached authentication for '${record.account}' needs attention. Run minecraft-cli auth login ${record.account}.`);
      }
    } : {}),
    version: record.version,
    hideErrors: false
  });
  record.bot = bot;
  attachBotEvents(record, bot);

  try {
    await waitForBotEvent(bot, "spawn", timeoutMs);
    record.connected = true;
    record.connecting = false;
    addEvent(record, "connected", "Spawned in world.");
    return snapshotSession(record);
  } catch (error) {
    record.connecting = false;
    record.connected = false;
    try {
      bot.quit("connect failed");
    } catch {
      // Ignore cleanup failures after a failed login.
    }
    throw new MinecraftCliError("CONNECTION_TIMEOUT", `Session '${name}' did not spawn within ${timeoutMs}ms.`, 504, {
      cause: error instanceof Error ? error.message : String(error),
      events: record.events.slice(-10)
    });
  }
}

function attachBotEvents(record: SessionRecord, bot: Bot) {
  bot.once("login", () => {
    if (record.auth === "microsoft" && bot.username) {
      record.username = String(bot.username);
      persistSessionMetadata(record);
    }
    addEvent(record, "login", "Logged in.");
  });
  bot.on("spawn", () => {
    record.connected = true;
    record.connecting = false;
    addEvent(record, "spawn", "Spawn event received.");
  });
  bot.on("respawn", () => {
    addEvent(record, "server_transition", "Respawn or proxy backend transition received.", gameConnectionSummary(bot));
  });
  bot.on("game", () => {
    addEvent(record, "game_change", "Server game properties changed.", gameConnectionSummary(bot));
  });
  bot._client?.on?.("transfer", (packet: any) => {
    try {
      const target = { host: normalizeHost(String(packet?.host ?? "")), port: normalizePort(Number(packet?.port)) };
      record.pendingTransfer = target;
      addEvent(record, "server_transfer_requested", `Server requested transfer to ${target.host}:${target.port}.`, target);
      bot._client.end();
    } catch (error) {
      addEvent(record, "server_transfer_failed", error instanceof Error ? error.message : String(error), simplifyUnknown(packet, 3));
    }
  });
  bot.on("message", (message: any, position: unknown, _jsonMessage: unknown, sender: unknown, verified: unknown) => {
    const component = chatComponentSummary(message);
    const details = {
      ...component,
      ...(position === undefined ? {} : { position }),
      ...(sender === undefined || sender === null ? {} : { sender }),
      ...(verified === undefined || verified === null ? {} : { verified })
    };
    addEvent(record, "message", message?.toString?.() ?? String(message), details);
    if (component.interactions.length > 0) {
      addEvent(record, "chat_component", component.text, details);
    }
  });
  bot.on("actionBar", (message: any) => {
    addEvent(record, "action_bar", textFromComponent(message) ?? message?.toString?.() ?? String(message), simplifyUnknown(message, 5));
  });
  bot._client?.on?.("systemChat", (data: any) => {
    if (data?.positionId !== 2) return;
    addEvent(record, "action_bar", textFromComponent(data.formattedMessage) ?? String(data.formattedMessage ?? ""), simplifyUnknown(data, 5));
  });
  bot._client?.on?.("system_chat", (packet: any) => {
    if (!packet?.isActionBar) return;
    addEvent(record, "action_bar", textFromComponent(packet.content) ?? String(packet.content ?? ""), simplifyUnknown(packet, 5));
  });
  bot.on("title", (title: any, titleType: string) => {
    addEvent(record, "title", textFromComponent(title) ?? title?.toString?.() ?? String(title), {
      titleType,
      raw: simplifyUnknown(title, 5)
    });
  });
  bot.on("title_times", (fadeIn: number, stay: number, fadeOut: number) => {
    addEvent(record, "title_times", "Title timing changed.", { fadeIn, stay, fadeOut });
  });
  bot.on("title_clear", () => {
    addEvent(record, "title_clear", "Titles cleared.");
  });
  bot.on("windowOpen", (window: any) => {
    addEvent(record, "window_open", "Window opened.", compactWindowSummary(window));
  });
  bot.on("windowClose", (window: any) => {
    addEvent(record, "window_close", "Window closed.", compactWindowSummary(window));
  });
  bot.on("health", () => {
    addEvent(record, "health", "Health changed.", {
      health: bot.health,
      food: bot.food
    });
  });
  bot.on("resourcePack", (urlOrUuid: string, hashOrUrl: string) => {
    addEvent(record, "resource_pack", "Resource pack requested.", { urlOrUuid, hashOrUrl });
  });
  bot.on("soundEffectHeard", (soundName: string, position: any, volume: number, pitch: number) => {
    addEvent(record, "sound_effect", soundName, {
      soundName,
      position: vectorSummary(position),
      volume,
      pitch
    });
  });
  bot.on("hardcodedSoundEffectHeard", (soundId: number, category: string, position: any, volume: number, pitch: number) => {
    addEvent(record, "sound_effect", String(soundId), {
      soundId,
      category,
      position: vectorSummary(position),
      volume,
      pitch
    });
  });
  bot.on("bossBarCreated", (bossBar: any) => {
    addEvent(record, "boss_bar", "Boss bar created.", bossBarSummary(bossBar));
  });
  bot.on("bossBarUpdated", (bossBar: any) => {
    addEvent(record, "boss_bar", "Boss bar updated.", bossBarSummary(bossBar));
  });
  bot.on("bossBarDeleted", (bossBar: any) => {
    addEvent(record, "boss_bar", "Boss bar deleted.", bossBarSummary(bossBar));
  });
  bot.on("scoreboardCreated", (scoreboard: any) => {
    addEvent(record, "scoreboard", "Scoreboard created.", scoreboardSummary(scoreboard));
  });
  bot.on("scoreboardTitleChanged", (scoreboard: any) => {
    addEvent(record, "scoreboard", "Scoreboard title changed.", scoreboardSummary(scoreboard));
  });
  bot.on("scoreUpdated", (scoreboard: any, item: any) => {
    addEvent(record, "scoreboard", "Scoreboard score updated.", {
      scoreboard: scoreboardSummary(scoreboard),
      item: simplifyUnknown(item, 4)
    });
  });
  bot.on("scoreRemoved", (scoreboard: any, item: any) => {
    addEvent(record, "scoreboard", "Scoreboard score removed.", {
      scoreboard: scoreboardSummary(scoreboard),
      item: simplifyUnknown(item, 4)
    });
  });
  bot.on("blockPlaced", (oldBlock: any, newBlock: any) => {
    addEvent(record, "block_update", "Block placed update received.", {
      oldBlock: oldBlock ? blockSummary(oldBlock) : undefined,
      newBlock: newBlock ? blockSummary(newBlock) : undefined
    });
  });
  bot._client?.on?.("packet", (packet: any, metadata: any) => {
    const packetName = String(metadata?.name ?? "");
    if (!isInterestingPacket(packetName)) return;
    addEvent(record, "packet", packetName, {
      name: packetName,
      state: metadata?.state,
      packet: simplifyUnknown(packet, 5)
    });
  });
  bot.on("kicked", (reason: unknown) => {
    addEvent(record, "kicked", "Kicked from server.", reason);
  });
  bot.on("error", (error: unknown) => {
    addEvent(record, "error", error instanceof Error ? error.message : String(error));
  });
  bot.on("end", (reason: unknown) => {
    const transfer = record.pendingTransfer;
    record.pendingTransfer = undefined;
    record.connected = false;
    record.connecting = false;
    record.bot = undefined;
    addEvent(record, "disconnect", "Disconnected.", reason);
    if (transfer && sessions.has(record.name)) {
      record.host = transfer.host;
      record.port = transfer.port;
      setTimeout(() => {
        if (!sessions.has(record.name) || record.connected || record.connecting) return;
        connectSession(record.name, 60_000, transfer).catch((error) => {
          addEvent(record, "server_transfer_failed", error instanceof Error ? error.message : String(error), transfer);
        });
      }, 500);
    }
  });
}

async function disconnectSession(name: string, timeoutMs = 20_000) {
  const record = requireSession(name);
  record.pendingTransfer = undefined;
  if (!record.bot) {
    record.connected = false;
    return snapshotSession(record);
  }
  const bot = record.bot;
  bot.quit("minecraft-cli disconnect");
  await Promise.race([
    waitForBotEvent(bot, "end", timeoutMs).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
  record.connected = false;
  record.connecting = false;
  record.bot = undefined;
  return snapshotSession(record);
}

async function destroySession(name: string) {
  const record = requireSession(name);
  await disconnectSession(record.name, 20_000);
  sessions.delete(record.name);
  return {
    destroyed: true,
    session: record.name
  };
}

function listSessions() {
  return {
    sessions: [...sessions.values()].map(snapshotSession)
  };
}

function getSessionState(name: string, part?: string) {
  const record = requireSession(name);
  const snapshot = snapshotSession(record);
  if (!part) return snapshot;
  const value = sessionStatePart(snapshot, part);
  persistSessionPart(record, part, value);
  return value;
}

function sessionStatePart(snapshot: SessionSnapshot, part: string) {
  const parts: Record<string, unknown> = {
    core: {
      name: snapshot.name,
      username: snapshot.username,
      auth: snapshot.auth,
      ...(snapshot.account ? { account: snapshot.account } : {}),
      connected: snapshot.connected,
      connecting: snapshot.connecting,
      server: snapshot.server,
      position: snapshot.position,
      rotation: snapshot.rotation,
      health: snapshot.health,
      food: snapshot.food,
      gameMode: snapshot.gameMode,
      dimension: snapshot.dimension,
      selectedSlot: snapshot.selectedSlot,
      heldItem: snapshot.heldItem
    },
    inventory: {
      name: snapshot.name,
      inventory: snapshot.inventory ?? [],
      slots: snapshot.inventorySlots ?? [],
      slotCount: snapshot.inventorySlotCount ?? 0,
      hash: snapshot.inventoryHash,
      selectedSlot: snapshot.selectedSlot,
      heldItem: snapshot.heldItem
    },
    entities: { name: snapshot.name, nearbyEntities: snapshot.nearbyEntities ?? [], nearbyPlayers: snapshot.nearbyPlayers ?? [] },
    window: { name: snapshot.name, openWindow: snapshot.openWindow ?? null },
    ui: {
      name: snapshot.name,
      bossBars: snapshot.bossBars ?? [],
      scoreboards: snapshot.scoreboards ?? [],
      tablist: snapshot.tablist ?? null
    },
    hud: {
      name: snapshot.name,
      bossBars: snapshot.bossBars ?? [],
      scoreboards: snapshot.scoreboards ?? [],
      tablist: snapshot.tablist ?? null,
      events: snapshot.recentEvents.filter(event => ["title", "title_times", "title_clear", "action_bar", "boss_bar", "scoreboard", "toast", "dialog", "resource_pack"].includes(event.type))
    },
    events: { name: snapshot.name, events: snapshot.recentEvents }
  };
  if (!(part in parts)) {
    throw new MinecraftCliError("INVALID_STATE_PART", "State part must be core, inventory, entities, window, ui, hud, or events.", 400);
  }
  return parts[part];
}

async function sessionChat(name: string, message: string) {
  if (!message.trim()) throw new MinecraftCliError("INVALID_CHAT", "Chat message cannot be empty.");
  const record = requireConnectedSession(name);
  record.bot!.chat(message);
  addEvent(record, "chat_sent", message);
  return snapshotSession(record);
}

async function sessionCommand(name: string, command: string) {
  if (!command.trim()) throw new MinecraftCliError("INVALID_COMMAND", "Player command cannot be empty.");
  const record = requireConnectedSession(name);
  const normalized = command.trim().replace(/^\/+/, "");
  record.bot!.chat(`/${normalized}`);
  addEvent(record, "command_sent", `/${normalized}`);
  return snapshotSession(record);
}

async function sessionMove(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 60));
  const controls = ["forward", "back", "left", "right", "jump", "sprint", "sneak"].filter((control) => Boolean(options[control]));
  if (controls.length === 0) {
    throw new MinecraftCliError("NO_MOVEMENT_CONTROL", "At least one movement control flag is required.");
  }

  for (const control of controls) bot.setControlState(control, true);
  addEvent(record, "move_start", `Controls ${controls.join(", ")} for ${ticks} ticks.`);
  try {
    await bot.waitForTicks(ticks);
  } finally {
    for (const control of controls) bot.setControlState(control, false);
  }
  addEvent(record, "move_end", "Movement finished.");
  return snapshotSession(record);
}

async function sessionSelectSlot(name: string, options: any) {
  const record = requireConnectedSession(name);
  const slot = normalizeHotbarSlot(Number(options.slot));
  record.bot!.setQuickBarSlot(slot);
  addEvent(record, "hotbar_select", `Selected hotbar slot ${slot}.`);
  return snapshotSession(record);
}

async function sessionEquipItem(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const item = resolveInventoryItem(record, options);
  const destination = normalizeEquipmentDestination(String(options.destination ?? "hand"));
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 5), 20 * 20));
  await bot.equip(item, destination);
  await bot.waitForTicks(ticks);
  addEvent(record, "item_equip", `Equipped ${item.name} to ${destination}.`, {
    item: itemSummary(item),
    destination
  });
  return snapshotSession(record);
}

async function sessionLook(name: string, yawDegrees: number, pitchDegrees: number) {
  if (!Number.isFinite(yawDegrees) || !Number.isFinite(pitchDegrees)) {
    throw new MinecraftCliError("INVALID_ROTATION", "Yaw and pitch must be numeric degrees.");
  }
  const record = requireConnectedSession(name);
  const yaw = (yawDegrees * Math.PI) / 180;
  const pitch = (pitchDegrees * Math.PI) / 180;
  await record.bot!.look(yaw, pitch, true);
  addEvent(record, "look", `yaw=${yawDegrees} pitch=${pitchDegrees}`);
  return snapshotSession(record);
}

async function sessionLookAt(name: string, options: any) {
  const record = requireConnectedSession(name);
  const target = resolveLookTarget(record, options);
  await record.bot!.lookAt(target.position, true);
  addEvent(record, "look_at", target.message, target.summary);
  return snapshotSession(record);
}

async function sessionInteract(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const target: any = resolveEntityTarget(record, options);
  const method = normalizeEntityInteractionMethod(String(options.method ?? "at"));
  await activateEntityByMethod(bot, target, method);
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  await bot.waitForTicks(ticks);
  addEvent(record, "entity_interact", `Right-clicked ${target.name ?? target.type ?? "entity"}#${target.id}.`, {
    method,
    target: entitySummary(bot, target)
  });
  return snapshotSession(record);
}

async function sessionUseOn(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  if (!bot.heldItem) {
    throw new MinecraftCliError("NO_HELD_ITEM", `Session '${name}' is not holding an item.`, 409);
  }
  const target: any = resolveEntityTarget(record, options);
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  const clickPosition = entityClickPosition(target);
  await bot.lookAt(clickPosition, true);
  await bot.waitForTicks(2);
  writeUseEntityPacket(bot, target, "at", clickPosition);
  bot.swingArm("right", true);
  await bot.waitForTicks(ticks);
  const result = {
    session: record.name,
    interacted: true,
    item: itemSummary(bot.heldItem),
    target: entitySummary(bot, target)
  };
  addEvent(record, "entity_use_item", `Used ${bot.heldItem.name} on ${target.name ?? target.type ?? "entity"}#${target.id}.`, result);
  return result;
}

async function sessionWait(name: string, ticks: number) {
  const record = requireConnectedSession(name);
  const bounded = Math.max(1, Math.min(Number(ticks), 20 * 120));
  await record.bot!.waitForTicks(bounded);
  addEvent(record, "wait", `${bounded} ticks.`);
  return snapshotSession(record);
}

async function sessionUseItem(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 10), 20 * 30));
  const offhand = Boolean(options.offhand);
  const keepActive = Boolean(options.keepActive);
  const air = Boolean(options.air);
  const heldItem = offhand ? bot.inventory?.slots?.[45] : bot.heldItem;

  if (air && bot.entity) {
    const baseYaw = bot.entity.yaw ?? 0;
    let clearDirection = false;
    for (const pitch of [0, -Math.PI / 3, Math.PI / 3, -Math.PI / 2, Math.PI / 2]) {
      for (const yawOffset of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        await bot.look(baseYaw + yawOffset, pitch, true);
        await bot.waitForTicks(1);
        if (!bot.blockAtCursor(5)) {
          clearDirection = true;
          break;
        }
      }
      if (clearDirection) break;
    }
    if (!clearDirection) throw new MinecraftCliError("NO_CLEAR_AIR_DIRECTION", "No clear direction was available for an air-only item use.", 409);
    await bot.waitForTicks(3);
  }
  bot.activateItem(offhand);
  await bot.waitForTicks(ticks);
  if (!keepActive) bot.deactivateItem();
  addEvent(record, "item_use", `Used ${offhand ? "offhand" : "held"} item for ${ticks} ticks.`, {
    offhand,
    air,
    keepActive,
    item: heldItem ? itemSummary(heldItem) : undefined
  });
  return snapshotSession(record);
}

async function sessionActivateBlock(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const block = resolveBlockTarget(record, options);
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await bot.activateBlock(block);
  await bot.waitForTicks(ticks);
  addEvent(record, "block_activate", `Activated ${block.name} at ${block.position.x}, ${block.position.y}, ${block.position.z}.`, blockSummary(block));
  return snapshotSession(record);
}

async function sessionDigBlock(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const block = resolveBlockTarget(record, options);
  if (block.name === "air") {
    throw new MinecraftCliError("BLOCK_IS_AIR", "Cannot dig air.");
  }
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  await bot.dig(block, true);
  await bot.waitForTicks(ticks);
  addEvent(record, "block_dig", `Dug ${block.name} at ${block.position.x}, ${block.position.y}, ${block.position.z}.`, blockSummary(block));
  return snapshotSession(record);
}

async function sessionPlaceBlock(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  if (!bot.heldItem) {
    throw new MinecraftCliError("NO_HELD_ITEM", `Session '${name}' is not holding an item.`, 409);
  }
  const referenceBlock = resolveBlockTarget(record, options);
  if (referenceBlock.name === "air") {
    throw new MinecraftCliError("REFERENCE_BLOCK_IS_AIR", "Reference block cannot be air.");
  }
  const face = faceVector(String(options.face ?? "up"));
  const referencePosition = referenceBlock.position.clone();
  const destination = referencePosition.plus(face);
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  await bot.lookAt(referenceBlock.position.offset(0.5, 0.5, 0.5), true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const currentDestination = bot.blockAt(destination);
      if (currentDestination && currentDestination.name !== "air" && currentDestination.name !== "cave_air") {
        lastError = undefined;
        break;
      }
      const currentReference = bot.blockAt(referencePosition);
      if (!currentReference || currentReference.name === "air") throw new Error("Reference block disappeared before placement");
      if (bot.supportFeature("blockPlaceHasInsideBlock")) {
        await placeModernBlock(record, currentReference, face, destination);
      } else {
        await bot.placeBlock(currentReference, face);
      }
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await bot.waitForTicks(5);
    }
  }
  if (lastError) throw lastError;
  await bot.waitForTicks(ticks);
  addEvent(record, "block_place", `Placed ${bot.heldItem?.name ?? "held item"} against ${referenceBlock.name}.`, {
    referenceBlock: blockSummary(referenceBlock),
    face: String(options.face ?? "up")
  });
  return snapshotSession(record);
}

async function sessionAttack(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const target: any = resolveEntityTarget(record, options);
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  await bot.lookAt(entityEyePosition(target), true);
  bot.attack(target, true);
  await bot.waitForTicks(ticks);
  addEvent(record, "entity_attack", `Attacked ${target.name ?? target.type ?? "entity"}#${target.id}.`, entitySummary(bot, target));
  return snapshotSession(record);
}

async function sessionTossItem(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const heldItem = bot.heldItem;
  if (!heldItem) {
    throw new MinecraftCliError("NO_HELD_ITEM", `Session '${name}' is not holding an item.`, 409);
  }
  const count = Math.max(1, Math.min(Number(options.count ?? 1), Number(heldItem.count ?? 1)));
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  await bot.toss(heldItem.type, heldItem.metadata ?? null, count);
  await bot.waitForTicks(ticks);
  addEvent(record, "item_toss", `Dropped ${count} ${heldItem.name}.`, { item: itemSummary(heldItem), count });
  return snapshotSession(record);
}

async function sessionSwingArm(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const hand = normalizeHand(String(options.hand ?? "right"));
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 5), 20 * 20));
  bot.swingArm(hand, true);
  await bot.waitForTicks(ticks);
  addEvent(record, "arm_swing", `Swung ${hand} hand.`, { hand });
  return snapshotSession(record);
}

async function sessionRespawn(name: string, options: any) {
  const record = requireConnectedSession(name);
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  record.bot!.respawn();
  await record.bot!.waitForTicks(ticks);
  addEvent(record, "respawn_requested", "Respawn requested.");
  return snapshotSession(record);
}

async function sessionClickSlot(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const window = bot.currentWindow;
  if (!window) {
    throw new MinecraftCliError("WINDOW_NOT_OPEN", `Session '${name}' has no open GUI/window.`, 409);
  }

  const slot = Number(options.slot);
  if (!Number.isInteger(slot) || slot < 0) {
    throw new MinecraftCliError("INVALID_SLOT", "Window slot must be a non-negative integer.");
  }

  const mouseButton = normalizeMouseButton(String(options.button ?? "left"));
  const mode = normalizeClickMode(String(options.mode ?? "normal"));
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  const before = compactWindowSummary(window);

  await bot.clickWindow(slot, mouseButton, mode);
  await bot.waitForTicks(ticks);
  addEvent(record, "window_click", `Clicked slot ${slot}.`, {
    slot,
    button: options.button ?? "left",
    mode: options.mode ?? "normal",
    before
  });
  return snapshotSession(record);
}

async function sessionClickItem(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const window = bot.currentWindow;
  if (!window) {
    throw new MinecraftCliError("WINDOW_NOT_OPEN", `Session '${name}' has no open GUI/window.`, 409);
  }

  const expected = windowItemClickOptions(options);
  const summary = windowSummary(window);
  const match = findWindowItemMatch(summary, expected);
  if (!match) {
    throw new MinecraftCliError("WINDOW_ITEM_NOT_FOUND", "No open GUI/window item matched the click criteria.", 404, {
      expected,
      window: summary
    });
  }

  const mouseButton = normalizeMouseButton(String(options.button ?? "left"));
  const mode = normalizeClickMode(String(options.mode ?? "normal"));
  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  const before = compactWindowSummary(window);

  await bot.clickWindow(match.slot, mouseButton, mode);
  await bot.waitForTicks(ticks);
  addEvent(record, "window_item_click", `Clicked matching item in slot ${match.slot}.`, {
    slot: match.slot,
    button: options.button ?? "left",
    mode: options.mode ?? "normal",
    criteria: expected,
    item: match,
    before
  });
  return {
    clicked: true,
    slot: match.slot,
    item: match,
    session: snapshotSession(record)
  };
}

async function sessionCloseWindow(name: string, options: any) {
  const record = requireConnectedSession(name);
  const bot = record.bot!;
  const window = bot.currentWindow;
  if (!window) {
    throw new MinecraftCliError("WINDOW_NOT_OPEN", `Session '${name}' has no open GUI/window.`, 409);
  }

  const ticks = Math.max(1, Math.min(Number(options.ticks ?? 20), 20 * 20));
  const before = compactWindowSummary(window);
  bot.closeWindow(window);
  await bot.waitForTicks(ticks);
  addEvent(record, "window_close_sent", "Closed current window.", { before });
  return snapshotSession(record);
}

async function sessionExpectEvent(name: string, options: any) {
  const record = requireConnectedSession(name);
  const expected = expectationOptions(options);
  const result = await waitForExpectation(record, expected.timeoutTicks, () => matchEventExpectation(record, expected));
  if (!result.matched) throw expectationError("EXPECT_EVENT_FAILED", result);
  addEvent(record, "expect_event", "Matched event expectation.", {
    expected,
    match: expectationMatchSummary(result.match)
  });
  return {
    matched: true,
    match: expectationMatchSummary(result.match)
  };
}

function getSessionEvents(name: string, options: any) {
  const record = requireSession(name);
  const afterSequence = options.afterSequence === undefined ? undefined : Number(options.afterSequence);
  if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
    throw new MinecraftCliError("INVALID_EVENT_SEQUENCE", "Event sequence must be a non-negative integer.");
  }
  const expected = {
    types: options.type ? [String(options.type)] : [],
    contains: stringList(options.contains),
    caseSensitive: Boolean(options.caseSensitive),
    limit: Math.max(1, Math.min(Number(options.limit ?? 30), 500))
  };
  const filtered = record.events.filter((event) => {
    if (afterSequence !== undefined && event.sequence <= afterSequence) return false;
    if (expected.types.length > 0 && !expected.types.includes(event.type)) return false;
    const text = eventSearchText(event);
    return expected.contains.every((needle: string) => textContains(text, needle, expected.caseSensitive));
  });
  return {
    session: record.name,
    count: filtered.length,
    oldestSequence: record.events[0]?.sequence ?? record.nextEventSequence,
    nextSequence: record.nextEventSequence,
    ...(afterSequence === undefined ? {} : { afterSequence }),
    events: filtered.slice(-expected.limit).map((event) => ({
      ...event,
      data: simplifyUnknown(event.data, 5)
    }))
  };
}

function clearSessionEvents(name: string) {
  const record = requireSession(name);
  const cleared = record.events.length;
  record.events = [];
  return {
    session: record.name,
    cleared
  };
}

async function sessionExpectChat(name: string, options: any) {
  return sessionExpectEvent(name, {
    ...options,
    type: options.type ?? "message"
  });
}

async function sessionExpectWindow(name: string, options: any) {
  const record = requireConnectedSession(name);
  const expected = windowExpectationOptions(options);
  const result = await waitForExpectation(record, expected.timeoutTicks, () => matchWindowExpectation(record, expected));
  if (!result.matched) throw expectationError("EXPECT_WINDOW_FAILED", result);
  addEvent(record, "expect_window", "Matched window expectation.", {
    expected,
    match: expectationMatchSummary(result.match)
  });
  return {
    matched: true,
    match: expectationMatchSummary(result.match)
  };
}

async function sessionExpectInventory(name: string, options: any) {
  const record = requireConnectedSession(name);
  const expected = inventoryExpectationOptions(options);
  const result = await waitForExpectation(record, expected.timeoutTicks, () => matchInventoryExpectation(record, expected));
  if (!result.matched) throw expectationError("EXPECT_INVENTORY_FAILED", result);
  addEvent(record, "expect_inventory", "Matched inventory expectation.", {
    expected,
    match: expectationMatchSummary(result.match)
  });
  return {
    matched: true,
    match: expectationMatchSummary(result.match)
  };
}

function normalizeMouseButton(button: string) {
  switch (button.toLowerCase()) {
    case "left":
      return 0;
    case "right":
      return 1;
    case "middle":
      return 2;
    default:
      throw new MinecraftCliError("INVALID_BUTTON", "Button must be left, right, or middle.");
  }
}

function normalizeClickMode(mode: string) {
  switch (mode.toLowerCase()) {
    case "normal":
    case "mouse":
      return 0;
    case "shift":
      return 1;
    case "number":
      return 2;
    case "drop":
      return 4;
    default:
      throw new MinecraftCliError("INVALID_CLICK_MODE", "Click mode must be normal, shift, number, or drop.");
  }
}

function normalizeHotbarSlot(slot: number) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
    throw new MinecraftCliError("INVALID_HOTBAR_SLOT", "Hotbar slot must be an integer from 0 to 8.");
  }
  return slot;
}

function normalizeEquipmentDestination(destination: string) {
  const normalized = destination.toLowerCase();
  switch (normalized) {
    case "hand":
    case "off-hand":
    case "head":
    case "torso":
    case "legs":
    case "feet":
      return normalized;
    case "offhand":
      return "off-hand";
    case "helmet":
      return "head";
    case "chest":
    case "chestplate":
      return "torso";
    case "leggings":
      return "legs";
    case "boots":
      return "feet";
    default:
      throw new MinecraftCliError("INVALID_EQUIPMENT_DESTINATION", "Destination must be hand, off-hand, head, torso, legs, or feet.");
  }
}

function normalizeHand(hand: string) {
  const normalized = hand.toLowerCase();
  if (normalized === "right" || normalized === "left") return normalized;
  throw new MinecraftCliError("INVALID_HAND", "Hand must be left or right.");
}

function normalizeEntityInteractionMethod(method: string) {
  const normalized = method.toLowerCase();
  if (normalized === "normal" || normalized === "at" || normalized === "both") return normalized;
  throw new MinecraftCliError("INVALID_ENTITY_INTERACTION_METHOD", "Method must be at, normal, or both.");
}

async function activateEntityByMethod(bot: Bot, target: any, method: string) {
  if (method === "normal" || method === "both") {
    await bot.lookAt(entityEyePosition(target), true);
    writeUseEntityPacket(bot, target, "normal");
    bot.swingArm("right", true);
    if (method === "normal") return;
    await bot.waitForTicks(2);
  }

  const clickPosition = entityClickPosition(target);
  await bot.lookAt(clickPosition, true);
  await bot.waitForTicks(2);
  writeUseEntityPacket(bot, target, "at", clickPosition);
  bot.swingArm("right", true);
}

function resolveInventoryItem(record: SessionRecord, options: any) {
  const bot = record.bot!;
  const slots = Array.isArray(bot.inventory?.slots) ? bot.inventory.slots : [];
  const slot = Number(options.slot);
  if (Number.isFinite(slot)) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length) {
      throw new MinecraftCliError("INVALID_SLOT", `Inventory slot must be an integer from 0 to ${Math.max(0, slots.length - 1)}.`);
    }
    const item = slots[slot];
    if (!item) {
      throw new MinecraftCliError("ITEM_NOT_FOUND", `Inventory slot ${slot} is empty.`, 404);
    }
    return item;
  }

  const expectedItem = stringOption(options.item);
  const expectedName = stringOption(options.name);
  const expectedLore = stringList(options.lore);
  if (!expectedItem && !expectedName && expectedLore.length === 0) {
    throw new MinecraftCliError("ITEM_SELECTOR_REQUIRED", "Provide --item, --name, --lore, or --slot.");
  }

  const match = slots.find((item: any) => item && itemMatches(itemSummary(item), { item: expectedItem, name: expectedName, lore: expectedLore, caseSensitive: Boolean(options.caseSensitive) }));
  if (!match) {
    throw new MinecraftCliError("ITEM_NOT_FOUND", "No inventory item matched the selector.", 404, {
      expected: {
        item: expectedItem,
        name: expectedName,
        lore: expectedLore
      },
      inventory: slots.filter(Boolean).map(itemSummary)
    });
  }
  return match;
}

function resolveBlockTarget(record: SessionRecord, options: any) {
  const bot = record.bot!;
  const Vec3 = nodeRequire("vec3").Vec3;
  let block: any;

  if (Number.isFinite(Number(options.x)) && Number.isFinite(Number(options.y)) && Number.isFinite(Number(options.z))) {
    block = bot.blockAt(new Vec3(Math.floor(Number(options.x)), Math.floor(Number(options.y)), Math.floor(Number(options.z))));
  } else if (options.cursor) {
    const maxDistance = Number.isFinite(Number(options.maxDistance)) ? Number(options.maxDistance) : 5;
    block = bot.blockAtCursor(maxDistance);
  } else {
    throw new MinecraftCliError("BLOCK_TARGET_REQUIRED", "Provide --x --y --z or pass --cursor.");
  }

  if (!block) {
    throw new MinecraftCliError("BLOCK_NOT_FOUND", "No block was found for the requested target.", 404, {
      x: options.x,
      y: options.y,
      z: options.z,
      cursor: Boolean(options.cursor)
    });
  }
  return block;
}

function blockSummary(block: any) {
  return {
    name: block.name,
    displayName: block.displayName,
    type: block.type,
    metadata: block.metadata,
    position: vectorSummary(block.position),
    boundingBox: block.boundingBox
  };
}

function faceVector(face: string) {
  const Vec3 = nodeRequire("vec3").Vec3;
  switch (face.toLowerCase()) {
    case "up":
      return new Vec3(0, 1, 0);
    case "down":
      return new Vec3(0, -1, 0);
    case "north":
      return new Vec3(0, 0, -1);
    case "south":
      return new Vec3(0, 0, 1);
    case "east":
      return new Vec3(1, 0, 0);
    case "west":
      return new Vec3(-1, 0, 0);
    default:
      throw new MinecraftCliError("INVALID_BLOCK_FACE", "Face must be up, down, north, south, east, or west.");
  }
}

async function placeModernBlock(record: SessionRecord, referenceBlock: any, face: any, destination: any) {
  const bot = record.bot!;
  const cursor = {
    x: 0.5 + face.x * 0.5,
    y: 0.5 + face.y * 0.5,
    z: 0.5 + face.z * 0.5
  };
  await bot.lookAt(referenceBlock.position.offset(cursor.x, cursor.y, cursor.z), true);
  bot._client.write("block_place", {
    hand: 0,
    location: referenceBlock.position,
    direction: blockFaceDirection(face),
    cursorX: cursor.x,
    cursorY: cursor.y,
    cursorZ: cursor.z,
    insideBlock: false,
    worldBorderHit: false,
    sequence: ++record.interactionSequence
  });
  bot.swingArm("right", true);
  for (let tick = 0; tick < 100; tick++) {
    await bot.waitForTicks(1);
    const placed = bot.blockAt(destination);
    if (placed && placed.name !== "air" && placed.name !== "cave_air") return;
  }
  throw new MinecraftCliError("BLOCK_PLACE_TIMEOUT", `No block update arrived for ${destination.x}, ${destination.y}, ${destination.z}.`, 504);
}

function blockFaceDirection(face: any) {
  if (face.y < 0) return 0;
  if (face.y > 0) return 1;
  if (face.z < 0) return 2;
  if (face.z > 0) return 3;
  if (face.x < 0) return 4;
  if (face.x > 0) return 5;
  throw new MinecraftCliError("INVALID_BLOCK_FACE", "Block face vector cannot be zero.");
}


function expectationOptions(options: any) {
  const contains = stringList(options.contains);
  const types = options.types ? stringList(options.types) : stringOption(options.type) ? [stringOption(options.type)!] : [];
  if (contains.length === 0 && types.length === 0) {
    throw new MinecraftCliError("EXPECTATION_REQUIRED", "Provide --type or at least one --contains value.");
  }
  return {
    types,
    contains,
    caseSensitive: Boolean(options.caseSensitive),
    afterSequence: normalizeEventSequence(options.afterSequence),
    timeoutTicks: normalizeTimeoutTicks(options.timeoutTicks ?? options.timeout ?? 0)
  };
}

function windowExpectationOptions(options: any) {
  const expected = {
    title: stringOption(options.title),
    titleContains: stringOption(options.titleContains),
    slot: numberOption(options.slot),
    item: stringOption(options.item),
    name: stringOption(options.name),
    lore: stringList(options.lore),
    caseSensitive: Boolean(options.caseSensitive),
    timeoutTicks: normalizeTimeoutTicks(options.timeoutTicks ?? options.timeout ?? 0)
  };
  if (
    expected.title === undefined &&
    expected.titleContains === undefined &&
    expected.slot === undefined &&
    expected.item === undefined &&
    expected.name === undefined &&
    expected.lore.length === 0
  ) {
    throw new MinecraftCliError("EXPECTATION_REQUIRED", "Provide a title, slot, item, name, or lore expectation.");
  }
  return expected;
}

function windowItemClickOptions(options: any) {
  const expected = {
    title: stringOption(options.title),
    titleContains: stringOption(options.titleContains),
    item: stringOption(options.item),
    name: stringOption(options.name),
    lore: stringList(options.lore),
    index: Math.max(0, Math.floor(Number(options.index ?? 0))),
    caseSensitive: Boolean(options.caseSensitive)
  };
  if (expected.item === undefined && expected.name === undefined && expected.lore.length === 0) {
    throw new MinecraftCliError("CLICK_CRITERIA_REQUIRED", "Provide --item, --name, or --lore so minecraft-cli knows what to click.");
  }
  return expected;
}

function inventoryExpectationOptions(options: any) {
  const expected = {
    slot: numberOption(options.slot),
    item: stringOption(options.item),
    name: stringOption(options.name),
    lore: stringList(options.lore),
    count: numberOption(options.count),
    caseSensitive: Boolean(options.caseSensitive),
    timeoutTicks: normalizeTimeoutTicks(options.timeoutTicks ?? options.timeout ?? 0)
  };
  if (expected.slot === undefined && expected.item === undefined && expected.name === undefined && expected.lore.length === 0) {
    throw new MinecraftCliError("EXPECTATION_REQUIRED", "Provide --slot, --item, --name, or --lore.");
  }
  return expected;
}

function normalizeTimeoutTicks(value: unknown) {
  const ticks = Number(value);
  if (!Number.isFinite(ticks)) return 0;
  return Math.max(0, Math.min(Math.floor(ticks), 20 * 120));
}

async function waitForExpectation(record: SessionRecord, timeoutTicks: number, evaluate: () => any) {
  let result = evaluate();
  const deadline = Date.now() + timeoutTicks * 50;
  while (!result.matched && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = evaluate();
  }
  return result;
}

function matchEventExpectation(record: SessionRecord, expected: any) {
  const events = record.events.slice().reverse();
  const afterFiltered = expected.afterSequence === undefined ? events : events.filter(event => event.sequence > expected.afterSequence);
  const filtered = expected.types.length > 0 ? afterFiltered.filter((event) => expected.types.includes(event.type)) : afterFiltered;
  const match = filtered.find((event) => {
    const text = eventSearchText(event);
    return expected.contains.every((needle: string) => textContains(text, needle, expected.caseSensitive));
  });
  if (match) {
    return {
      matched: true,
      expected,
      match
    };
  }
  return {
    matched: false,
    reason: "No recent session event matched the expectation.",
    expected,
    actual: filtered.slice(0, 20)
  };
}

function normalizeEventSequence(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const sequence = Number(value);
  if (!Number.isInteger(sequence) || sequence < 0) throw new MinecraftCliError("INVALID_EVENT_SEQUENCE", "Event sequence must be a non-negative integer.");
  return sequence;
}

function gameConnectionSummary(bot: Bot) {
  return {
    dimension: bot?.game?.dimension,
    gameMode: bot?.game?.gameMode,
    serverBrand: bot?.game?.serverBrand,
    position: vectorSummary(bot?.entity?.position)
  };
}

function matchWindowExpectation(record: SessionRecord, expected: any) {
  const window = record.bot?.currentWindow;
  const summary = window ? windowSummary(window) : undefined;
  if (!summary) {
    return {
      matched: false,
      reason: "No GUI/window is currently open.",
      expected,
      actual: snapshotSession(record)
    };
  }

  const title = String((summary as any).title ?? "");
  if (expected.title !== undefined && !textEquals(title, expected.title, expected.caseSensitive)) {
    return {
      matched: false,
      reason: "Open window title did not match.",
      expected,
      actual: summary
    };
  }
  if (expected.titleContains !== undefined && !textContains(title, expected.titleContains, expected.caseSensitive)) {
    return {
      matched: false,
      reason: "Open window title did not contain expected text.",
      expected,
      actual: summary
    };
  }

  const hasItemExpectation = expected.item !== undefined || expected.name !== undefined || expected.lore.length > 0;
  if (expected.slot === undefined && !hasItemExpectation) {
    return { matched: true, expected, match: summary };
  }

  const slots = Array.isArray((summary as any).slots) ? (summary as any).slots : [];
  const candidates = expected.slot === undefined ? slots : slots.filter((slot: any) => slot.slot === expected.slot);
  if (candidates.length === 0) {
    return {
      matched: false,
      reason: expected.slot === undefined ? "No non-empty window slots were available." : `Window slot ${expected.slot} was empty or missing.`,
      expected,
      actual: summary
    };
  }

  const match = hasItemExpectation ? candidates.find((item: any) => itemMatches(item, expected)) : candidates[0];
  if (!match) {
    return {
      matched: false,
      reason: "No window slot item matched the expectation.",
      expected,
      actual: candidates
    };
  }
  return {
    matched: true,
    expected,
    match: {
      window: summary,
      slot: match
    }
  };
}

function findWindowItemMatch(summary: any, expected: any) {
  if (!summary) return undefined;
  const title = String(summary.title ?? "");
  if (expected.title !== undefined && !textEquals(title, expected.title, expected.caseSensitive)) return undefined;
  if (expected.titleContains !== undefined && !textContains(title, expected.titleContains, expected.caseSensitive)) return undefined;
  const slots = Array.isArray(summary.slots) ? summary.slots : [];
  const matches = slots.filter((item: any) => itemMatches(item, expected));
  return matches[expected.index];
}

function matchInventoryExpectation(record: SessionRecord, expected: any) {
  const slots = Array.isArray(record.bot?.inventory?.slots) ? record.bot!.inventory.slots : [];
  const items = slots.map((item: any, slot: number) => (item ? { slot, ...itemSummary(item) } : undefined)).filter(Boolean);
  const candidates = expected.slot === undefined ? items : items.filter((item: any) => item.slot === expected.slot);
  if (candidates.length === 0) {
    return {
      matched: false,
      reason: expected.slot === undefined ? "No inventory items were available." : `Inventory slot ${expected.slot} was empty or missing.`,
      expected,
      actual: items
    };
  }

  const match = candidates.find((item: any) => itemMatches(item, expected));
  if (!match) {
    return {
      matched: false,
      reason: "No inventory item matched the expectation.",
      expected,
      actual: candidates
    };
  }
  return {
    matched: true,
    expected,
    match
  };
}

function expectationError(code: string, result: any) {
  return new MinecraftCliError(code, result.reason ?? "Expectation failed.", 409, {
    expected: result.expected,
    actual: result.actual
  });
}

function expectationMatchSummary(match: any): any {
  if (!match) return match;
  if (match.window && match.slot) {
    return {
      window: windowHeader(match.window),
      slot: conciseItemSummary(match.slot)
    };
  }
  if (match.id !== undefined && match.title !== undefined) {
    return windowHeader(match);
  }
  if (match.type !== undefined && (match.message !== undefined || match.time !== undefined)) {
    return {
      time: match.time,
      type: match.type,
      message: match.message,
      data: simplifyUnknown(match.data, 3)
    };
  }
  if (match.slot !== undefined && match.name !== undefined) return conciseItemSummary(match);
  return simplifyUnknown(match, 4);
}

function windowHeader(window: any) {
  return {
    id: window.id,
    type: window.type,
    title: window.title,
    slotCount: Array.isArray(window.slots) ? window.slots.length : 0
  };
}

function compactWindowSummary(window: any) {
  const summary = windowSummary(window);
  if (!summary) return undefined;
  return {
    ...windowHeader(summary),
    inventoryStart: summary.inventoryStart,
    inventoryEnd: summary.inventoryEnd,
    slots: Array.isArray(summary.slots) ? summary.slots.map(conciseItemSummary) : []
  };
}

function conciseItemSummary(item: any) {
  return {
    slot: item.slot,
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    customNameText: item.customNameText,
    loreText: item.loreText,
    componentTypes: item.componentTypes
  };
}

function itemMatches(item: any, expected: any) {
  if (!item) return false;
  if (expected.count !== undefined && Number(item.count ?? 0) < expected.count) return false;
  if (expected.item !== undefined && !textContains(itemSearchText(item), expected.item, expected.caseSensitive)) return false;
  if (expected.name !== undefined && !textContains(itemNameSearchText(item), expected.name, expected.caseSensitive)) return false;
  for (const lore of expected.lore ?? []) {
    if (!textContains(itemLoreSearchText(item), lore, expected.caseSensitive)) return false;
  }
  return true;
}

function itemSearchText(item: any) {
  return [
    item.name,
    item.displayName,
    item.customNameText,
    itemNameSearchText(item),
    itemLoreSearchText(item),
    ...(Array.isArray(item.componentTypes) ? item.componentTypes : [])
  ]
    .filter((value) => value !== undefined && value !== null)
    .join("\n");
}

function itemNameSearchText(item: any) {
  return [item.displayName, item.customNameText, item.customName, item.item_name]
    .map((value) => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)))
    .filter(Boolean)
    .join("\n");
}

function itemLoreSearchText(item: any) {
  const loreText = Array.isArray(item.loreText) ? item.loreText.join("\n") : item.loreText;
  return [loreText, item.lore]
    .map((value) => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)))
    .filter(Boolean)
    .join("\n");
}

function eventSearchText(event: SessionEvent) {
  return [event.type, event.message, event.data === undefined ? undefined : JSON.stringify(event.data)]
    .filter((value) => value !== undefined && value !== null)
    .join("\n");
}

function textContains(actual: string, expected: string, caseSensitive = false) {
  return caseSensitive ? actual.includes(expected) : actual.toLowerCase().includes(expected.toLowerCase());
}

function textEquals(actual: string, expected: string, caseSensitive = false) {
  return caseSensitive ? actual === expected : actual.toLowerCase() === expected.toLowerCase();
}

function stringOption(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function stringList(value: unknown) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.map((entry) => String(entry).trim()).filter(Boolean);
}

function queryOptions(url: URL) {
  return {
    type: url.searchParams.get("type") ?? undefined,
    contains: url.searchParams.getAll("contains"),
    caseSensitive: url.searchParams.get("caseSensitive") === "true",
    limit: url.searchParams.get("limit") ?? undefined,
    afterSequence: url.searchParams.get("after") ?? undefined
  };
}

function numberOption(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isInterestingPacket(packetName: string) {
  return /dialog|resource|custom_payload/.test(packetName);
}

function snapshotSession(record: SessionRecord): SessionSnapshot {
  const bot = record.bot;
  const position = bot?.entity?.position;
  const heldItem = bot?.heldItem ? itemSummary(bot.heldItem) : undefined;
  const inventorySlots = Array.isArray(bot?.inventory?.slots)
    ? bot.inventory.slots.map((item: any, slot: number) => item ? { slot, ...itemSummary(item) } : null)
    : undefined;
  const inventory = inventorySlots?.filter(Boolean) ?? undefined;
  const inventoryHash = inventorySlots
    ? crypto.createHash("sha256").update(JSON.stringify(inventorySlots)).digest("hex")
    : undefined;
  const openWindow = bot?.currentWindow ? windowSummary(bot.currentWindow) : undefined;
  const bossBars = bot?.bossBars ? Object.values(bot.bossBars).map(bossBarSummary) : undefined;
  const scoreboards = bot?.scoreboards ? Object.values(bot.scoreboards).map(scoreboardSummary) : undefined;
  const tablist = bot?.tablist ? tablistSummary(bot.tablist) : undefined;
  const entities = bot?.entities
    ? Object.values(bot.entities)
        .filter((entity: any) => entity !== bot.entity && entity.position && bot.entity?.position?.distanceTo(entity.position) <= 16)
        .slice(0, 30)
        .map((entity: any) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          username: entity.username,
          labels: entityRoleLabels(entity),
          position: vectorSummary(entity.position),
          distance: Number(bot.entity.position.distanceTo(entity.position).toFixed(2))
        }))
    : undefined;

  const players = bot?.players
    ? Object.values(bot.players)
        .map((player: any) => player.username)
        .filter(Boolean)
    : undefined;

  const snapshot = {
    name: record.name,
    username: record.username,
    auth: record.auth,
    ...(record.account ? { account: record.account } : {}),
    createdAt: record.createdAt,
    connected: record.connected,
    connecting: record.connecting,
    server: {
      host: record.host,
      port: record.port,
      version: record.version
    },
    ...(position ? { position: vectorSummary(position) } : {}),
    ...(bot?.entity
      ? {
          rotation: {
            yaw: Number((((bot.entity.yaw ?? 0) * 180) / Math.PI).toFixed(2)),
            pitch: Number((((bot.entity.pitch ?? 0) * 180) / Math.PI).toFixed(2))
          }
        }
      : {}),
    ...(bot ? { health: bot.health, food: bot.food } : {}),
    ...(bot?.game?.gameMode ? { gameMode: bot.game.gameMode } : {}),
    ...(bot?.game?.dimension ? { dimension: bot.game.dimension } : {}),
    ...(bot ? { selectedSlot: bot.quickBarSlot } : {}),
    ...(heldItem ? { heldItem } : {}),
    ...(inventory ? { inventory } : {}),
    ...(inventorySlots ? { inventorySlots, inventorySlotCount: inventorySlots.length, inventoryHash } : {}),
    ...(openWindow ? { openWindow } : {}),
    ...(bossBars && bossBars.length > 0 ? { bossBars } : {}),
    ...(scoreboards && scoreboards.length > 0 ? { scoreboards } : {}),
    ...(tablist ? { tablist } : {}),
    ...(entities ? { nearbyEntities: entities } : {}),
    ...(players ? { nearbyPlayers: players } : {}),
    recentEvents: record.events.slice(-30)
  };
  persistSessionSnapshot(record, snapshot);
  return snapshot;
}

function vectorSummary(vector: any): any {
  if (
    !vector ||
    !Number.isFinite(Number(vector.x)) ||
    !Number.isFinite(Number(vector.y)) ||
    !Number.isFinite(Number(vector.z))
  ) {
    return simplifyUnknown(vector, 2);
  }
  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3))
  };
}

function bossBarSummary(bossBar: any) {
  if (!bossBar) return undefined;
  return {
    entityUUID: bossBar.entityUUID,
    title: textFromComponent(bossBar.title) ?? bossBar.title?.toString?.() ?? String(bossBar.title ?? ""),
    health: bossBar.health,
    dividers: bossBar.dividers,
    color: bossBar.color,
    flags: {
      shouldDarkenSky: bossBar.shouldDarkenSky,
      isDragonBar: bossBar.isDragonBar,
      createFog: bossBar.createFog
    }
  };
}

function scoreboardSummary(scoreboard: any) {
  if (!scoreboard) return undefined;
  const items = typeof scoreboard.items === "function" ? scoreboard.items() : scoreboard.items;
  return {
    name: scoreboard.name,
    title: textFromComponent(scoreboard.title) ?? scoreboard.title?.toString?.() ?? String(scoreboard.title ?? ""),
    items: simplifyUnknown(items, 4)
  };
}

function tablistSummary(tablist: any) {
  if (!tablist) return undefined;
  const header = textFromComponent(tablist.header) ?? tablist.header?.toString?.();
  const footer = textFromComponent(tablist.footer) ?? tablist.footer?.toString?.();
  if (!header && !footer) return undefined;
  return {
    ...(header ? { header } : {}),
    ...(footer ? { footer } : {})
  };
}

function itemSummary(item: any) {
  const components = componentEntries(item);
  const legacyMeta = legacyItemMeta(item.nbt);
  const summary: Record<string, unknown> = {
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    slot: item.slot
  };
  for (const key of ["type", "metadata", "stackId", "durabilityUsed", "maxDurability"]) {
    if (item[key] !== undefined) summary[key] = item[key];
  }
  if (item.customName !== undefined) summary.customName = simplifyUnknown(item.customName);
  if (item.lore !== undefined) summary.lore = simplifyUnknown(item.lore);
  if (item.enchants !== undefined) summary.enchants = simplifyUnknown(item.enchants);
  if (components.length > 0) {
    summary.componentTypes = components.map(([type]) => type);
    const customName = findComponentText(components, ["custom_name", "item_name"]) ?? textFromComponent(item.customName);
    const lore = findLoreText(components) ?? (Array.isArray(item.lore) ? item.lore.map((line: any) => textFromComponent(line)).filter(Boolean) : undefined);
    if (customName) summary.customNameText = customName;
    if (lore && lore.length > 0) summary.loreText = lore;
    for (const key of ["custom_model_data", "enchantments", "custom_data", "rarity", "dyed_color"]) {
      const component = components.find(([type]) => type === key);
      if (component) summary[key] = simplifyUnknown(component[1], 6);
    }
  }
  const customNameText = (summary.customNameText as string | undefined) ?? legacyMeta.customName ?? parseComponentString(item.customName);
  const loreText = (summary.loreText as string[] | undefined) ?? legacyMeta.lore;
  if (customNameText) summary.customNameText = customNameText;
  if (loreText && loreText.length > 0) summary.loreText = loreText;
  if (item.nbt !== undefined) summary.nbt = simplifyUnknown(item.nbt, 6);
  return summary;
}

function legacyItemMeta(nbt: any) {
  const root = unwrapNbt(nbt);
  const display = unwrapNbt(root?.display);
  const nameValue = unwrapNbt(display?.Name);
  const loreValue = unwrapNbt(display?.Lore);
  const loreLines = Array.isArray(loreValue) ? loreValue : loreValue === undefined ? [] : [loreValue];
  return {
    customName: parseComponentString(nameValue),
    lore: loreLines.map(parseComponentString).filter((line): line is string => Boolean(line))
  };
}

function unwrapNbt(value: any): any {
  let current = value;
  for (let depth = 0; depth < 8 && current && typeof current === "object" && "value" in current; depth++) {
    current = current.value;
  }
  return current;
}

function parseComponentString(value: any): string | undefined {
  if (typeof value !== "string") return textFromComponent(value);
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return textFromComponent(JSON.parse(trimmed)) ?? value;
  } catch {
    try {
      return textFromComponent(JSON.parse(`[${trimmed}]`)) ?? value;
    } catch {
      return value;
    }
  }
}

function componentEntries(item: any): Array<[string, unknown]> {
  if (item?.componentMap instanceof Map) return [...item.componentMap.entries()].map(([key, value]) => [String(key), componentData(value)]);
  if (item?.componentMap && typeof item.componentMap === "object") {
    return Object.entries(item.componentMap).map(([key, value]) => [key, componentData(value)]);
  }
  if (Array.isArray(item?.components)) {
    return item.components
      .map((component: any) => [String(component?.type ?? ""), component?.data] as [string, unknown])
      .filter(([type]) => type.length > 0);
  }
  return [];
}

function componentData(component: any) {
  if (component && typeof component === "object" && "data" in component) return component.data;
  return component;
}

function findComponentText(components: Array<[string, unknown]>, names: string[]) {
  const component = components.find(([type]) => names.includes(type));
  return component ? textFromComponent(component[1]) : undefined;
}

function findLoreText(components: Array<[string, unknown]>) {
  const component = components.find(([type]) => type === "lore");
  if (!component) return undefined;
  const value = component[1];
  const lines = Array.isArray(value) ? value : [value];
  return lines.map((line) => textFromComponent(line)).filter((line): line is string => Boolean(line));
}

function textFromComponent(value: any): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromComponent).filter(Boolean).join("");
  if (typeof value !== "object") return String(value);

  if (typeof value.value === "string") return value.value;
  if (value.type === "string" && typeof value.value === "string") return value.value;
  if (value.type === "list") return textFromComponent(value.value);
  if (value.type === "compound") return textFromComponent(value.value);

  const text = textFromComponent(value.text);
  const extra = textFromComponent(value.extra);
  const combined = `${text ?? ""}${extra ?? ""}`;
  if (combined) return combined;

  if (value.data !== undefined) return textFromComponent(value.data);
  if (value.value !== undefined) return textFromComponent(value.value);
  return undefined;
}

function chatComponentSummary(message: any) {
  const raw = normalizeChatValue(message?.json ?? message);
  const interactions: Array<Record<string, unknown>> = [];
  collectChatInteractions(raw, interactions, []);
  return {
    text: textFromComponent(raw) ?? message?.toString?.() ?? String(message),
    interactions,
    raw: simplifyUnknown(raw, 7)
  };
}

function normalizeChatValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value?.toJSON === "function") {
    try {
      return normalizeChatValue(value.toJSON());
    } catch {
      // Continue with enumerable fields.
    }
  }
  if (Array.isArray(value)) return value.map(normalizeChatValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeChatValue(entry)]));
  }
  return value;
}

function collectChatInteractions(value: any, output: Array<Record<string, unknown>>, pathParts: Array<string | number>) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectChatInteractions(entry, output, [...pathParts, index]));
    return;
  }
  if (typeof value !== "object") return;

  const hoverEvent = value.hoverEvent ?? value.hover_event;
  const clickEvent = value.clickEvent ?? value.click_event;
  if (hoverEvent || clickEvent) {
    output.push({
      path: pathParts.join("."),
      text: textFromComponent(value),
      ...(hoverEvent ? { hoverEvent: simplifyUnknown(hoverEvent, 6) } : {}),
      ...(clickEvent ? { clickEvent: simplifyUnknown(clickEvent, 6) } : {})
    });
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "hoverEvent" || key === "hover_event" || key === "clickEvent" || key === "click_event") continue;
    if (typeof entry === "object" && entry !== null) collectChatInteractions(entry, output, [...pathParts, key]);
  }
}

function simplifyUnknown(value: unknown, depth = 4, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (Buffer.isBuffer(value)) return { type: "Buffer", hex: value.toString("hex").slice(0, 256), bytes: value.length };
  if (depth <= 0) return String(value);

  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => simplifyUnknown(item, depth - 1, seen));
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].slice(0, 80).map(([key, entryValue]) => [String(key), simplifyUnknown(entryValue, depth - 1, seen)])
    );
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value).slice(0, 120)) {
      const simplified = simplifyUnknown(entryValue, depth - 1, seen);
      if (simplified !== undefined) result[key] = simplified;
    }
    seen.delete(value);
    return result;
  }

  return String(value);
}

function windowSummary(window: any) {
  if (!window) return undefined;
  const slots = Array.isArray(window.slots)
    ? window.slots
        .map((item: any, slot: number) => (item ? { slot, ...itemSummary(item) } : undefined))
        .filter(Boolean)
    : [];
  return {
    id: window.id,
    type: window.type,
    title: stringifyWindowTitle(window.title),
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    slots
  };
}

function stringifyWindowTitle(title: any) {
  if (title === undefined || title === null) return undefined;
  if (typeof title === "string") {
    const trimmed = title.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return textFromComponent(JSON.parse(trimmed)) ?? title;
      } catch {
        // Some servers intentionally use a literal title beginning with a brace.
      }
    }
    return title;
  }
  if (typeof title.value === "string") return title.value;
  if (typeof title.text === "string") return title.text;
  if (Array.isArray(title.extra)) {
    const text = title.extra
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? part?.value ?? "")))
      .join("");
    if (text) return text;
  }
  if (typeof title?.toString === "function" && title.toString !== Object.prototype.toString) return title.toString();
  return JSON.stringify(title);
}

function resolveLookTarget(record: SessionRecord, options: any) {
  if (Number.isFinite(Number(options.x)) && Number.isFinite(Number(options.y)) && Number.isFinite(Number(options.z))) {
    const Vec3 = nodeRequire("vec3").Vec3;
    const position = new Vec3(Number(options.x), Number(options.y), Number(options.z));
    return {
      position,
      message: `Looked at ${position.x}, ${position.y}, ${position.z}.`,
      summary: { position: vectorSummary(position) }
    };
  }
  const entity: any = resolveEntityTarget(record, options);
  return {
    position: entityEyePosition(entity),
    message: `Looked at ${entity.name ?? entity.type ?? "entity"}#${entity.id}.`,
    summary: entitySummary(record.bot!, entity)
  };
}

function resolveEntityTarget(record: SessionRecord, options: any) {
  const bot = record.bot!;
  const maxDistance = Number.isFinite(Number(options.maxDistance)) ? Number(options.maxDistance) : 8;
  const entityId = Number(options.entityId);
  const wantedName = options.entity ? String(options.entity).toLowerCase() : undefined;
  const wantedUsername = options.username ? String(options.username).toLowerCase() : undefined;
  const wantedRole = options.role ? String(options.role).trim().toLowerCase() : undefined;

  let candidates = Object.values(bot.entities ?? {}).filter((entity: any) => entity && entity !== bot.entity && entity.position);
  if (Number.isFinite(entityId)) candidates = candidates.filter((entity: any) => entity.id === entityId);
  if (wantedName) {
    candidates = candidates.filter((entity: any) => {
      const name = String(entity.name ?? "").toLowerCase();
      const type = String(entity.type ?? "").toLowerCase();
      return name === wantedName || type === wantedName || name.includes(wantedName);
    });
  }
  if (wantedUsername) {
    candidates = candidates.filter((entity: any) => String(entity.username ?? "").toLowerCase() === wantedUsername);
  }
  if (wantedRole) {
    candidates = candidates.filter((entity: any) => entityRoleLabels(entity).some(label => label.toLowerCase().includes(wantedRole)));
  }
  candidates = candidates.filter((entity: any) => bot.entity.position.distanceTo(entity.position) <= maxDistance);
  candidates.sort((a: any, b: any) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));

  const target = candidates[0];
  if (!target) {
    throw new MinecraftCliError("ENTITY_NOT_FOUND", "No matching nearby entity was found.", 404, {
      maxDistance,
      entityId: Number.isFinite(entityId) ? entityId : undefined,
      entity: wantedName,
      username: wantedUsername,
      role: wantedRole
    });
  }
  return target;
}

function entityEyePosition(entity: any) {
  const height = Number.isFinite(Number(entity.height)) ? Number(entity.height) : 1.6;
  return entity.position.offset(0, height * 0.85, 0);
}

function entityClickPosition(entity: any) {
  const height = Number.isFinite(Number(entity.height)) ? Number(entity.height) : 1.6;
  return entity.position.offset(0, Math.max(0.25, Math.min(height * 0.5, 1.2)), 0);
}

function writeUseEntityPacket(bot: Bot, target: any, method: "normal" | "at", clickPosition?: any) {
  const base = {
    target: target.id,
    mouse: method === "normal" ? 0 : 2,
    hand: 0,
    sneaking: Boolean(bot.getControlState?.("sneak"))
  };
  if (method === "normal") {
    bot._client.write("use_entity", base);
    return;
  }
  bot._client.write("use_entity", {
    ...base,
    x: Number((clickPosition.x - target.position.x).toFixed(4)),
    y: Number((clickPosition.y - target.position.y).toFixed(4)),
    z: Number((clickPosition.z - target.position.z).toFixed(4))
  });
}

function entitySummary(bot: Bot, entity: any) {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    username: entity.username,
    labels: entityRoleLabels(entity),
    position: vectorSummary(entity.position),
    distance: Number(bot.entity.position.distanceTo(entity.position).toFixed(2))
  };
}

function entityRoleLabels(entity: any) {
  const labels: string[] = [];
  const add = (value: unknown) => {
    const text = typeof value === "string" ? value : textFromComponent(value);
    const normalized = text?.trim();
    if (normalized && !labels.some(label => label.toLowerCase() === normalized.toLowerCase())) labels.push(normalized);
  };
  for (const value of [entity.username, entity.name, entity.type, entity.mobType, entity.displayName, entity.customName]) add(value);
  const metadata = entity.metadata;
  const values = Array.isArray(metadata) ? metadata : metadata && typeof metadata === "object" ? Object.values(metadata) : [];
  for (const value of values) {
    if (typeof value === "string" || (value && typeof value === "object")) add(value);
  }
  return labels;
}

function addEvent(record: SessionRecord, type: string, message?: string, data?: unknown) {
  const previous = record.events.at(-1);
  if (type === "sound_effect" && previous?.type === type && previous.message === message) {
    const previousTime = Date.parse(previous.time);
    if (Number.isFinite(previousTime) && Date.now() - previousTime < 1000) return;
  }
  const event = {
    sequence: ++record.nextEventSequence,
    time: new Date().toISOString(),
    type,
    ...(message === undefined ? {} : { message }),
    ...(data === undefined ? {} : { data: simplifyUnknown(data, 6) })
  };
  record.events.push(event);
  if (record.events.length > 200) record.events.shift();
  persistSessionEvent(record, event);
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "session";
}

function sessionArtifactDir(record: SessionRecord) {
  return path.join(paths.sessions, safeFilePart(record.name));
}

function ensureSessionDirs(record: SessionRecord) {
  const root = sessionArtifactDir(record);
  for (const dir of [root, path.join(root, "json"), path.join(root, "screenshots"), path.join(root, "logs")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return root;
}

function persistSessionMetadata(record: SessionRecord) {
  const root = ensureSessionDirs(record);
  writeJsonAtomic(path.join(root, "metadata.json"), {
    name: record.name,
    username: record.username,
    auth: record.auth,
    ...(record.account ? { account: record.account } : {}),
    createdAt: record.createdAt,
    server: {
      host: record.host,
      port: record.port,
      version: record.version
    }
  });
}

function persistSessionSnapshot(record: SessionRecord, snapshot: unknown) {
  const root = ensureSessionDirs(record);
  writeJsonAtomic(path.join(root, "json", "latest-state.json"), snapshot);
  if (snapshot && typeof snapshot === "object") {
    persistSessionPart(record, "core", sessionStatePart(snapshot as SessionSnapshot, "core"));
  }
}

function persistSessionPart(record: SessionRecord, part: string, value: unknown) {
  const root = ensureSessionDirs(record);
  writeJsonAtomic(path.join(root, "json", `latest-${part}.json`), value);
}

function persistSessionEvent(record: SessionRecord, event: SessionEvent) {
  const root = ensureSessionDirs(record);
  const logFile = path.join(root, "logs", "events.jsonl");
  rotateLogFile(logFile, 10 * 1024 * 1024, 3);
  fs.appendFileSync(logFile, `${JSON.stringify(event)}\n`, "utf8");
  writeJsonAtomic(path.join(root, "json", "latest-event-buffer.json"), record.events);
}

function rotateLogFile(file: string, maxBytes: number, backups: number) {
  if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return;
  for (let index = backups; index >= 1; index--) {
    const source = index === 1 ? file : `${file}.${index - 1}`;
    const destination = `${file}.${index}`;
    if (!fs.existsSync(source)) continue;
    fs.rmSync(destination, { force: true });
    fs.renameSync(source, destination);
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

async function disconnectAllSessions(timeoutMs: number) {
  for (const record of sessions.values()) {
    if (record.bot) await disconnectSession(record.name, timeoutMs);
  }
}

async function stopDaemon(timeoutMs = 30_000) {
  if (shuttingDown) return { stopping: true };
  shuttingDown = true;
  await disconnectAllSessions(Math.min(timeoutMs, 20_000));

  const statePath = paths.daemonState;
  if (fs.existsSync(statePath)) fs.rmSync(statePath, { force: true });

  const result = {
    stopped: true,
    pid: process.pid
  };

  setTimeout(() => {
    httpServer?.close(() => process.exit(0));
  }, 50).unref();
  return result;
}

function waitForBotEvent(bot: Bot, event: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for bot event '${event}'.`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      bot.removeListener(event, onEvent);
      bot.removeListener("kicked", onError);
      bot.removeListener("error", onError);
      bot.removeListener("end", onError);
    };
    bot.once(event, onEvent);
    bot.once("kicked", onError);
    bot.once("error", onError);
    bot.once("end", onError);
  });
}
