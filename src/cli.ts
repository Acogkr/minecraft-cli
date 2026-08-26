#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { MinecraftCliError, toErrorResponse } from "./errors";
import { requestDaemon, requestDaemonAt, readDaemonState, isProcessAlive, resolveDistDaemonPath, getFreePort } from "./ipc";
import { ensureBaseDirs, getPaths } from "./paths";
import { Authflow, Titles } from "prismarine-auth";
import { executeScenario } from "./scenario";
import { analyzePngChange, changedPngRegion, createContactSheet, cropPng, intersectRegions, latestPng, type ImageRegion } from "./image-diff";
import { artifactStatus, pruneArtifacts } from "./artifacts";
import { diffJson, redactSecrets } from "./json-utils";
import {
  ensureAccountCache,
  listAccountProfiles,
  normalizeAccountAlias,
  normalizeAuthMode,
  readAccountProfile,
  removeAccount,
  writeAccountProfile
} from "./auth-store";

interface OutputOptions {
  json?: boolean;
  compactJson?: boolean;
}

const program = new Command();
const VISUAL_CONTROL_PROTOCOL = 2;
const jsonRequested = process.argv.includes("--json");
if (jsonRequested) {
  process.argv = process.argv.filter((value, index) => index < 2 || value !== "--json");
}

program
  .name("minecraft-cli")
  .description("Agent-friendly Minecraft client session controller for external servers.")
  .option("--json", "emit machine-readable JSON", jsonRequested)
  .option("--compact", "omit large repeated session details from successful command responses", false)
  .option("--workspace <path>", "workspace root", process.cwd());

function collect(value: string, previous: string[]) {
  previous.push(value);
  return previous;
}

function printResponse(response: unknown, options?: OutputOptions) {
  const json = options?.json ?? true;
  const output = program.opts().compact ? compactCliResponse(response) : response;
  if (json) {
    const serialized = options?.compactJson || program.opts().compact
      ? JSON.stringify(output)
      : JSON.stringify(output, null, 2);
    fs.writeSync(1, `${serialized}\n`);
    return;
  }
  fs.writeSync(1, `${JSON.stringify(output)}\n`);
}

function compactCliResponse(value: any): any {
  if (Array.isArray(value)) return value.map(compactCliResponse);
  if (!value || typeof value !== "object" || value.ok === false) return value;
  if (value.name && value.server && Array.isArray(value.recentEvents)) {
    return {
      name: value.name,
      auth: value.auth,
      ...(value.account ? { account: value.account } : {}),
      connected: value.connected,
      connecting: value.connecting,
      server: value.server,
      position: value.position,
      health: value.health,
      food: value.food,
      heldItem: value.heldItem ? { name: value.heldItem.name, count: value.heldItem.count } : undefined,
      openWindow: value.openWindow ? { id: value.openWindow.id, type: value.openWindow.type, title: value.openWindow.title } : undefined,
      eventCount: value.recentEvents.length
    };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compactCliResponse(entry)]));
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "artifact";
}

function timestampFilePart() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureSessionArtifactDirs(workspace: string, sessionName: string) {
  const dirs = {
    root: path.join(getPaths(workspace).sessions, safeFilePart(sessionName)),
    json: path.join(getPaths(workspace).sessions, safeFilePart(sessionName), "json"),
    screenshots: path.join(getPaths(workspace).sessions, safeFilePart(sessionName), "screenshots")
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function writeJsonFile(file: string, value: unknown) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const CHECKPOINT_PARTS = ["core", "window", "ui", "hud", "entities", "inventory", "events"] as const;

function normalizeCheckpointLabel(value: unknown) {
  const label = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(label)) throw new MinecraftCliError("CHECKPOINT_LABEL_INVALID", "Checkpoint label must be 1-64 letters, numbers, dots, underscores, or hyphens.", 400);
  return label;
}

function checkpointDirectory(workspace: string, sessionName: string) {
  const dir = path.join(ensureSessionArtifactDirs(workspace, sessionName).root, "checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function checkpointPath(workspace: string, sessionName: string, label: string) {
  return path.join(checkpointDirectory(workspace, sessionName), `${normalizeCheckpointLabel(label)}.json`);
}

function parseCheckpointParts(value: unknown) {
  const parts = value === undefined
    ? [...CHECKPOINT_PARTS]
    : String(value).split(",").map(part => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some(part => !(CHECKPOINT_PARTS as readonly string[]).includes(part))) {
    throw new MinecraftCliError("CHECKPOINT_PART_INVALID", `Checkpoint parts must be comma-separated values from ${CHECKPOINT_PARTS.join(", ")}.`, 400);
  }
  return [...new Set(parts)];
}

async function captureCheckpoint(workspace: string, sessionName: string, label: string, requestedParts?: unknown) {
  const parts = parseCheckpointParts(requestedParts);
  const values: Record<string, unknown> = {};
  let eventCursor: number | undefined;
  for (const part of parts) {
    if (part === "events") {
      const eventState: any = await requestDaemonForCli("GET", `/session/${encodeURIComponent(sessionName)}/events?limit=1`);
      eventCursor = eventState.nextSequence;
      values.events = { nextSequence: eventState.nextSequence };
    } else {
      values[part] = await requestDaemonForCli("GET", `/session/${encodeURIComponent(sessionName)}/state?part=${encodeURIComponent(part)}`);
    }
  }
  const checkpoint = { version: 1, session: sessionName, label, capturedAt: new Date().toISOString(), parts: values, ...(eventCursor === undefined ? {} : { eventCursor }) };
  const file = checkpointPath(workspace, sessionName, label);
  writeJsonFile(file, redactSecrets(checkpoint));
  return { checkpoint, file };
}

function readCheckpoint(workspace: string, sessionName: string, label: string) {
  const file = checkpointPath(workspace, sessionName, label);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version !== 1 || value?.session !== sessionName || !value?.parts) throw new Error("schema mismatch");
    return { value, file };
  } catch (error) {
    throw new MinecraftCliError("CHECKPOINT_NOT_FOUND", `Could not read checkpoint '${label}': ${error instanceof Error ? error.message : String(error)}`, 404);
  }
}

async function compareCheckpoint(workspace: string, sessionName: string, label: string, requestedParts?: unknown) {
  const baseline = readCheckpoint(workspace, sessionName, label);
  const parts = requestedParts === undefined ? Object.keys(baseline.value.parts) : parseCheckpointParts(requestedParts);
  const partDiffs: Record<string, unknown> = {};
  let changeCount = 0;
  for (const part of parts) {
    if (!(part in baseline.value.parts)) throw new MinecraftCliError("CHECKPOINT_PART_MISSING", `Checkpoint '${label}' does not contain part '${part}'.`, 400);
    if (part === "events") {
      const after = Number(baseline.value.eventCursor ?? baseline.value.parts.events?.nextSequence ?? 0);
      const events: any = await requestDaemonForCli("GET", `/session/${encodeURIComponent(sessionName)}/events?after=${after}&limit=500`);
      const changed = events.events.length > 0;
      if (changed) {
        partDiffs.events = { changed: true, changeCount: events.events.length, afterSequence: after, nextSequence: events.nextSequence, events: events.events };
        changeCount += events.events.length;
      }
      continue;
    }
    const current = await requestDaemonForCli("GET", `/session/${encodeURIComponent(sessionName)}/state?part=${encodeURIComponent(part)}`);
    const difference: any = diffJson(baseline.value.parts[part], current, 500);
    if (difference.changed) {
      if (part === "inventory") {
        const slots = [...new Set(difference.changes.map((change: any) => /^\$\.slots\[(\d+)\]/.exec(change.path)?.[1]).filter(Boolean).map(Number))];
        difference.changedSlots = slots;
      }
      partDiffs[part] = difference;
      changeCount += difference.changeCount;
    }
  }
  return { session: sessionName, baseline: label, baselineFile: baseline.file, changed: changeCount > 0, changeCount, parts: partDiffs };
}

function multiMcMicrosoftProfile(multiMcRoot: string, value: unknown) {
  const requestedProfile = String(value ?? "").trim();
  if (requestedProfile && !/^[a-zA-Z0-9_]{3,16}$/.test(requestedProfile)) {
    throw new MinecraftCliError("INVALID_MICROSOFT_PROFILE", "The MultiMC Minecraft profile name is invalid.", 400);
  }
  const accountsFile = path.join(multiMcRoot, "accounts.json");
  try {
    const accounts = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
    const available = Array.isArray(accounts?.accounts)
      ? accounts.accounts.filter((account: any) => typeof account?.profile?.name === "string")
      : [];
    const selected = requestedProfile
      ? available.find((account: any) => account.profile.name === requestedProfile)
      : available.find((account: any) => account.active === true) ?? (available.length === 1 ? available[0] : undefined);
    if (!selected) throw new Error("profile not found");
    return String(selected.profile.name);
  } catch {
    throw new MinecraftCliError(
      "MULTIMC_ACCOUNT_NOT_FOUND",
      requestedProfile
        ? `MultiMC profile '${requestedProfile}' is not available.`
        : "MultiMC has no active Microsoft account. Sign in through MultiMC first.",
      404
    );
  }
}

function publicAccountProfile(profile: { account: string; profileName: string; signedInAt: string }) {
  return {
    account: profile.account,
    profileName: profile.profileName,
    signedInAt: profile.signedInAt
  };
}

function copyMicrosoftCodeToClipboard(userCode: string) {
  if (process.platform !== "win32" || !userCode) return false;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-Command",
    "Set-Clipboard -Value $env:MINECRAFT_CLI_AUTH_CODE"
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, MINECRAFT_CLI_AUTH_CODE: userCode }
  });
  return result.status === 0;
}

function openMicrosoftLoginBrowser(userCode: string, fallbackUri: string) {
  const loginUrl = userCode
    ? `https://www.microsoft.com/link?otc=${encodeURIComponent(userCode)}`
    : fallbackUri;
  let parsed: URL;
  try {
    parsed = new URL(loginUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || !/(^|\.)microsoft\.com$/i.test(parsed.hostname)) return false;
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "Start-Process -FilePath $env:MINECRAFT_CLI_AUTH_URL"
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, MINECRAFT_CLI_AUTH_URL: parsed.toString() }
    });
    return result.status === 0;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = spawnSync(command, [parsed.toString()], { encoding: "utf8" });
  return result.status === 0;
}

const VISUAL_ADAPTERS = {
  "1.20.1": {
    project: "control-mod-1.20.1",
    jar: "minecraft-cli-control-1.20.1-0.1.0.jar",
    java: 17,
    loader: "0.18.1"
  },
  "1.21.4": {
    project: "control-mod",
    jar: "minecraft-cli-control-0.1.0.jar",
    java: 21,
    loader: "0.18.1"
  },
  "1.21.11": {
    project: "control-mod-1.21.11",
    jar: "minecraft-cli-control-1.21.11-0.1.0.jar",
    java: 21,
    loader: "0.19.3"
  }
} as const;

const VISUAL_SUPPORTED_VERSIONS = Object.keys(VISUAL_ADAPTERS);
const VISUAL_INSTANCE_SLOTS = 8;
const VISUAL_INSTANCE_GROUP = "minecraft-cli";

function visualRuntimeFile(workspace: string, name: string) {
  return path.join(ensureSessionArtifactDirs(workspace, name).root, "visual-client.json");
}

function defaultMultiMcRoot() {
  return process.env.MULTIMC_ROOT ?? path.join(os.homedir(), "Documents", "bukkit", "MultiMC");
}

function packageRoot() {
  return path.resolve(__dirname, "..");
}

function dedicatedVisualInstancePids(instanceId: string, stop = false) {
  if (process.platform !== "win32") return [];
  const slashPattern = `*/instances/${instanceId}/*`;
  const backslashPattern = `*\\instances\\${instanceId}\\*`;
  const action = stop ? "Stop-Process -Id $_.ProcessId -Force;" : "";
  const script = `$patterns=@(${powerShellString(slashPattern)},${powerShellString(backslashPattern)}); $matched=@(); Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'javaw.exe' -or $_.Name -eq 'java.exe') -and ($_.CommandLine -like $patterns[0] -or $_.CommandLine -like $patterns[1]) } | ForEach-Object { ${action} $matched += $_.ProcessId }; $matched | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new MinecraftCliError("VISUAL_PROCESS_QUERY_FAILED", result.stderr || "Could not inspect the dedicated visual client.", 500);
  const text = result.stdout.trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function stopDedicatedVisualInstance(instanceId: string) {
  return dedicatedVisualInstancePids(instanceId, true);
}

function stopDuplicateVisualInstanceProcesses(instanceId: string, controlPort: number) {
  if (process.platform !== "win32") return [];
  const ownerResult = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$c=Get-NetTCPConnection -State Listen -LocalPort ${controlPort} -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}`
  ], { encoding: "utf8", windowsHide: true });
  const ownerPid = Number(ownerResult.stdout.trim());
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return [];
  const duplicates = dedicatedVisualInstancePids(instanceId).filter(pid => pid !== ownerPid);
  for (const pid of duplicates) {
    const stopped = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$p=Get-CimInstance Win32_Process -Filter ${powerShellString(`ProcessId=${pid}`)} -ErrorAction SilentlyContinue; if($p -and ($p.Name -eq 'javaw.exe' -or $p.Name -eq 'java.exe')){Stop-Process -Id $p.ProcessId -Force}`
    ], { encoding: "utf8", windowsHide: true });
    if (stopped.status !== 0) {
      throw new MinecraftCliError("VISUAL_DUPLICATE_CLEANUP_FAILED", `Could not stop duplicate visual client PID ${pid}.`, 500);
    }
  }
  return duplicates;
}

function stopMultiMcLauncherForRefresh(launcher: string) {
  if (process.platform !== "win32") return [];
  const script = `$launcher=${powerShellString(path.resolve(launcher))}; $matched=@(); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'MultiMC.exe' -and $_.ExecutablePath -eq $launcher } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $matched += $_.ProcessId }; $matched | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new MinecraftCliError("MULTIMC_REFRESH_FAILED", result.stderr || "Could not refresh MultiMC after creating visual slots.", 500);
  const text = result.stdout.trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function startMultiMcLauncher(launcher: string) {
  const child = spawn(launcher, [], {
    cwd: path.dirname(launcher),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function visualInstanceIds(version: string) {
  return Array.from({ length: VISUAL_INSTANCE_SLOTS }, (_, index) =>
    index === 0 ? `minecraft-cli-${version}` : `minecraft-cli-${version}-${index + 1}`
  );
}

function ensureManagedVisualGroup(multiMcRoot: string) {
  const instancesRoot = path.join(multiMcRoot, "instances");
  const groupFile = path.join(instancesRoot, "instgroups.json");
  let root: any = { formatVersion: "1", groups: {} };
  if (fs.existsSync(groupFile)) {
    try {
      root = JSON.parse(fs.readFileSync(groupFile, "utf8"));
    } catch {
      throw new MinecraftCliError("MULTIMC_GROUPS_INVALID", `Could not parse ${groupFile}.`, 500);
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root) || !root.groups || typeof root.groups !== "object" || Array.isArray(root.groups)) {
    throw new MinecraftCliError("MULTIMC_GROUPS_INVALID", `Invalid MultiMC group structure in ${groupFile}.`, 500);
  }

  const knownManagedIds = new Set(VISUAL_SUPPORTED_VERSIONS.flatMap(visualInstanceIds));
  const managedIds = new Set([...knownManagedIds]
    .filter(instanceId => fs.existsSync(path.join(instancesRoot, instanceId, "instance.cfg"))));
  let changed = root.formatVersion !== "1";
  root.formatVersion = "1";
  for (const [groupName, rawGroup] of Object.entries(root.groups)) {
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup) || !Array.isArray((rawGroup as any).instances)) {
      throw new MinecraftCliError("MULTIMC_GROUPS_INVALID", `Invalid MultiMC group '${groupName}' in ${groupFile}.`, 500);
    }
    if (groupName === VISUAL_INSTANCE_GROUP) continue;
    const instances = (rawGroup as any).instances as unknown[];
    const filtered = instances.filter(instanceId => typeof instanceId !== "string" || !managedIds.has(instanceId));
    if (filtered.length !== instances.length) {
      (rawGroup as any).instances = filtered;
      changed = true;
    }
  }

  const existingGroup = root.groups[VISUAL_INSTANCE_GROUP];
  if (existingGroup && (typeof existingGroup !== "object" || Array.isArray(existingGroup) || !Array.isArray(existingGroup.instances))) {
    throw new MinecraftCliError("MULTIMC_GROUPS_INVALID", `Invalid MultiMC group '${VISUAL_INSTANCE_GROUP}' in ${groupFile}.`, 500);
  }
  const currentInstances = existingGroup?.instances?.filter((value: unknown) => typeof value === "string") ?? [];
  const desiredInstances = [
    ...currentInstances.filter((instanceId: string) => !knownManagedIds.has(instanceId)),
    ...[...managedIds].sort()
  ];
  if (!existingGroup || JSON.stringify(currentInstances) !== JSON.stringify(desiredInstances)) {
    root.groups[VISUAL_INSTANCE_GROUP] = { ...(existingGroup ?? {}), hidden: existingGroup?.hidden === true, instances: desiredInstances };
    changed = true;
  }
  if (!changed) return false;

  fs.mkdirSync(instancesRoot, { recursive: true });
  const temporary = `${groupFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, groupFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

async function selectVisualInstanceId(workspace: string, name: string, version: string) {
  const existing = readVisualRuntimeIfExists(workspace, name);
  const candidates = visualInstanceIds(version);
  if (existing?.version === version && candidates.includes(existing.instanceId)) {
    const running = dedicatedVisualInstancePids(existing.instanceId);
    if (running.length === 0) return existing.instanceId;
    try {
      await visualRequest(existing, "/state", 1000);
      return existing.instanceId;
    } catch {
      // The slot was reused by a different visual session.
    }
  }
  const available = candidates.find(instanceId => dedicatedVisualInstancePids(instanceId).length === 0);
  if (!available) {
    throw new MinecraftCliError(
      "VISUAL_INSTANCE_LIMIT",
      `All ${VISUAL_INSTANCE_SLOTS} visual slots for Minecraft ${version} are in use. Stop a visual session first.`,
      409
    );
  }
  return available;
}

function selectAvailableVisualInstanceId(version: string) {
  const available = visualInstanceIds(version).find(instanceId => dedicatedVisualInstancePids(instanceId).length === 0);
  if (!available) {
    throw new MinecraftCliError(
      "VISUAL_INSTANCE_LIMIT",
      `All ${VISUAL_INSTANCE_SLOTS} visual slots for Minecraft ${version} are in use. Stop a visual session first.`,
      409
    );
  }
  return available;
}

async function withVisualAllocationLock<T>(multiMcRoot: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  const lockFile = path.join(multiMcRoot, ".minecraft-cli-visual.lock");
  const deadline = Date.now() + timeoutMs;
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lockFile, "wx");
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > 5 * 60_000 || !isProcessAlive(Number(lock.pid))) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        if (fs.existsSync(lockFile) && Date.now() - fs.statSync(lockFile).mtimeMs <= 5000) {
          if (Date.now() >= deadline) throw new MinecraftCliError("VISUAL_ALLOCATION_TIMEOUT", "Timed out waiting for another visual launch.", 409);
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new MinecraftCliError("VISUAL_ALLOCATION_TIMEOUT", "Timed out waiting for another visual launch.", 409);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  try {
    return await action();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockFile, { force: true });
  }
}

async function downloadIfMissing(url: string, destination: string) {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new MinecraftCliError("VISUAL_DEPENDENCY_DOWNLOAD_FAILED", `Could not download ${url}: HTTP ${response.status}`, 502);
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    let installed = true;
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) throw error;
      installed = false;
    }
    return installed;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function prepareMultiMcFabricLoader(multiMcRoot: string, loaderVersion: string) {
  const metadataFile = path.join(multiMcRoot, "meta", "net.fabricmc.fabric-loader", `${loaderVersion}.json`);
  await downloadIfMissing(`https://meta.multimc.org/v1/net.fabricmc.fabric-loader/${loaderVersion}.json`, metadataFile);
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  for (const library of metadata.libraries ?? []) {
    const artifact = library?.downloads?.artifact;
    const parts = String(library?.name ?? "").split(":");
    if (!artifact?.url || parts.length !== 3) continue;
    const fileName = new URL(artifact.url).pathname.split("/").pop();
    if (!fileName) continue;
    const destination = path.join(multiMcRoot, "libraries", ...parts[0].split("."), parts[1], parts[2], fileName);
    const downloaded = await downloadIfMissing(artifact.url, destination);
    if (artifact.sha1) {
      let actual = crypto.createHash("sha1").update(fs.readFileSync(destination)).digest("hex");
      if (actual !== artifact.sha1 && !downloaded) {
        fs.rmSync(destination, { force: true });
        await downloadIfMissing(artifact.url, destination);
        actual = crypto.createHash("sha1").update(fs.readFileSync(destination)).digest("hex");
      }
      if (actual !== artifact.sha1) throw new MinecraftCliError("VISUAL_DEPENDENCY_HASH_MISMATCH", `Invalid download: ${fileName}`, 502);
    }
  }
}

async function ensureJava17Runtime(workspace: string) {
  const runtimeRoot = path.join(getPaths(workspace).runtime, "temurin-17");
  const existing = findFile(runtimeRoot, "javaw.exe");
  if (existing) return existing;
  const archive = path.join(getPaths(workspace).root, "downloads", "temurin-17-jre.zip");
  await downloadIfMissing("https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse", archive);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const expanded = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `Expand-Archive -LiteralPath ${powerShellString(archive)} -DestinationPath ${powerShellString(runtimeRoot)} -Force`],
    { encoding: "utf8", windowsHide: true });
  if (expanded.status !== 0) throw new MinecraftCliError("JAVA_RUNTIME_INSTALL_FAILED", expanded.stderr || expanded.stdout, 500);
  const java = findFile(runtimeRoot, "javaw.exe");
  if (!java) throw new MinecraftCliError("JAVA_RUNTIME_INSTALL_FAILED", "Java 17 runtime did not contain javaw.exe.", 500);
  return java;
}

function findFile(root: string, name: string): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return undefined;
}

function pruneManagedInstanceFiles(root: string, keep: number) {
  if (!fs.existsSync(root)) return;
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(root, entry.name);
      return { file, modified: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);
  for (const entry of files.slice(keep)) fs.rmSync(entry.file, { force: true });
}

function latestSourceMtime(root: string) {
  let latest = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "build" || entry.name === ".gradle") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
  }
  return latest;
}

interface VisualDisplaySettings {
  width: number;
  height: number;
  guiScale: number;
  fov: number;
}

function normalizeVisualDisplaySettings(options: any): VisualDisplaySettings {
  const settings = {
    width: Number(options.width ?? 960),
    height: Number(options.height ?? 540),
    guiScale: Number(options.guiScale ?? 0),
    fov: Number(options.fov ?? 70)
  };
  if (!Number.isInteger(settings.width) || settings.width < 320 || settings.width > 7680
    || !Number.isInteger(settings.height) || settings.height < 240 || settings.height > 4320) {
    throw new MinecraftCliError("VISUAL_FRAMEBUFFER_INVALID", "Framebuffer width/height must be integer pixels within 320x240 and 7680x4320.", 400);
  }
  if (!Number.isInteger(settings.guiScale) || settings.guiScale < 0 || settings.guiScale > 4) {
    throw new MinecraftCliError("VISUAL_GUI_SCALE_INVALID", "GUI scale must be an integer from 0 (auto) to 4.", 400);
  }
  if (!Number.isInteger(settings.fov) || settings.fov < 30 || settings.fov > 110) {
    throw new MinecraftCliError("VISUAL_FOV_INVALID", "FOV must be an integer from 30 to 110 degrees.", 400);
  }
  return settings;
}

function configureManagedVisualOptions(targetOptions: string, sourceOptions: string | undefined, settings: VisualDisplaySettings) {
  if (!fs.existsSync(targetOptions) && sourceOptions && fs.existsSync(sourceOptions)) {
    fs.copyFileSync(sourceOptions, targetOptions);
  }
  let optionsText = fs.existsSync(targetOptions) ? fs.readFileSync(targetOptions, "utf8") : "";
  const setOption = (key: string, value: string) => {
    const pattern = new RegExp(`^${key}:.*$`, "m");
    optionsText = pattern.test(optionsText)
      ? optionsText.replace(pattern, `${key}:${value}`)
      : `${optionsText.trimEnd()}${optionsText.trimEnd() ? "\n" : ""}${key}:${value}\n`;
  };
  setOption("tutorialStep", "none");
  setOption("skipMultiplayerWarning", "true");
  setOption("onboardAccessibility", "false");
  setOption("soundCategory_master", "0.0");
  setOption("guiScale", String(settings.guiScale));
  setOption("fov", String(settings.fov));
  fs.writeFileSync(targetOptions, optionsText, "utf8");
}

function visualRestoreFile(workspace: string, name: string) {
  return path.join(ensureSessionArtifactDirs(workspace, name).root, "visual-restore.json");
}

function restoreVisualEnvironment(workspace: string, name: string) {
  const file = visualRestoreFile(workspace, name);
  if (!fs.existsSync(file)) return { restored: false, removed: [] as string[] };
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const optionsFile = path.resolve(String(manifest.optionsFile));
  const gameRoot = path.resolve(String(manifest.gameRoot));
  if (path.dirname(optionsFile) !== gameRoot || path.basename(optionsFile) !== "options.txt") {
    throw new MinecraftCliError("VISUAL_RESTORE_INVALID", "Visual restore manifest points outside its managed game directory.", 500);
  }
  if (manifest.optionsExisted) fs.writeFileSync(optionsFile, String(manifest.optionsText ?? ""), "utf8");
  else fs.rmSync(optionsFile, { force: true });
  const resourceRoot = path.join(gameRoot, "resourcepacks");
  const removed: string[] = [];
  for (const raw of Array.isArray(manifest.installedFiles) ? manifest.installedFiles : []) {
    const candidate = path.resolve(String(raw));
    if (path.dirname(candidate) !== resourceRoot) continue;
    fs.rmSync(candidate, { force: true });
    removed.push(candidate);
  }
  fs.rmSync(file, { force: true });
  return { restored: true, removed };
}

function installVisualResourcePack(gameRoot: string, zipFile: string, requestedUuid?: string) {
  const source = path.resolve(zipFile);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile() || path.extname(source).toLowerCase() !== ".zip") {
    throw new MinecraftCliError("VISUAL_RESOURCE_PACK_INVALID", "Resource pack must be an existing ZIP file.", 400, { file: source });
  }
  const archive = fs.readFileSync(source);
  const signature = archive.subarray(0, 4).toString("hex");
  if (!new Set(["504b0304", "504b0506", "504b0708"]).has(signature)) {
    throw new MinecraftCliError("VISUAL_RESOURCE_PACK_INVALID", "Resource pack does not have a valid ZIP signature.", 400, { file: source });
  }
  const uuid = requestedUuid?.trim() || crypto.randomUUID();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(uuid)) {
    throw new MinecraftCliError("VISUAL_RESOURCE_PACK_UUID_INVALID", "Pack UUID must be 1-80 letters, numbers, dots, underscores, or hyphens.", 400);
  }
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const resourceRoot = path.join(gameRoot, "resourcepacks");
  fs.mkdirSync(resourceRoot, { recursive: true });
  const fileName = `minecraft-cli-${safeFilePart(uuid)}-${sha256.slice(0, 12)}.zip`;
  const destination = path.join(resourceRoot, fileName);
  fs.copyFileSync(source, destination);
  return { uuid, sha256, source, file: destination, packId: `file/${fileName}`, status: "installed" };
}

function relativeFiles(root: string) {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function pruneLegacyVisualPlaceholders(multiMcRoot: string) {
  const instancesRoot = path.resolve(multiMcRoot, "instances");
  const expectedFiles = [
    ".minecraft/minecraft-cli-control.json",
    ".minecraft/mods/minecraft-cli-control.jar",
    ".minecraft/options.txt",
    "instance.cfg",
    "mmc-pack.json"
  ];
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const version of VISUAL_SUPPORTED_VERSIONS) {
    for (const instanceId of visualInstanceIds(version).slice(1)) {
      const instanceRoot = path.resolve(instancesRoot, instanceId);
      if (path.dirname(instanceRoot) !== instancesRoot || !fs.existsSync(instanceRoot)) continue;
      if (dedicatedVisualInstancePids(instanceId).length > 0) {
        skipped.push(instanceId);
        continue;
      }
      const files = relativeFiles(instanceRoot);
      if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
        skipped.push(instanceId);
        continue;
      }
      fs.rmSync(instanceRoot, { recursive: true, force: true });
      removed.push(instanceId);
    }
  }
  return { removed, skipped };
}

async function prepareVisualInstance(workspace: string, sessionName: string, version: string, multiMcRoot: string, instanceId: string, port: number, token: string,
  settings: VisualDisplaySettings, server?: { host: string; port: number }, resourcePack?: { file: string; uuid?: string }) {
  const adapter = VISUAL_ADAPTERS[version as keyof typeof VISUAL_ADAPTERS];
  if (!adapter) {
    throw new MinecraftCliError("VISUAL_VERSION_UNSUPPORTED", `Visual control currently supports: ${VISUAL_SUPPORTED_VERSIONS.join(", ")}.`, 400);
  }
  const launcher = path.join(multiMcRoot, "MultiMC.exe");
  if (!fs.existsSync(launcher)) throw new MinecraftCliError("MULTIMC_NOT_FOUND", `MultiMC was not found at ${launcher}.`, 404);
  const projectRoot = path.join(packageRoot(), "fixtures", adapter.project);
  const sourceJar = path.join(projectRoot, "build", "libs", adapter.jar);
  const jarIsStale = !fs.existsSync(sourceJar) || latestSourceMtime(path.join(projectRoot, "src")) > fs.statSync(sourceJar).mtimeMs
    || ["build.gradle", "gradle.properties", "settings.gradle"].some(file => {
      const candidate = path.join(projectRoot, file);
      return fs.existsSync(candidate) && fs.statSync(candidate).mtimeMs > fs.statSync(sourceJar).mtimeMs;
    });
  if (jarIsStale) {
    const wrapper = path.join(projectRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    const executable = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "sh";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", wrapper, "build"]
      : [wrapper, "build"];
    const build = spawnSync(executable, args, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    });
    if (build.status !== 0) {
      const message = build.error?.message || build.stderr || build.stdout || `Gradle exited with status ${build.status}`;
      throw new MinecraftCliError("CONTROL_MOD_BUILD_FAILED", message, 500);
    }
    if (!fs.existsSync(sourceJar)) throw new MinecraftCliError("CONTROL_MOD_BUILD_FAILED", `Control adapter build did not create ${sourceJar}.`, 500);
  }
  const intermediary = path.join(multiMcRoot, "libraries", "net", "fabricmc", "intermediary", version, `intermediary-${version}.jar`);
  await downloadIfMissing(`https://maven.fabricmc.net/net/fabricmc/intermediary/${version}/intermediary-${version}.jar`, intermediary);
  await prepareMultiMcFabricLoader(multiMcRoot, adapter.loader);
  const javaPath = adapter.java === 17 ? await ensureJava17Runtime(workspace) : undefined;
  const instanceRoot = path.join(multiMcRoot, "instances", instanceId);
  const createdInstance = !fs.existsSync(path.join(instanceRoot, "instance.cfg"));
  const gameRoot = path.join(instanceRoot, ".minecraft");
  const mods = path.join(gameRoot, "mods");
  fs.mkdirSync(mods, { recursive: true });
  pruneManagedInstanceFiles(path.join(gameRoot, "logs"), 5);
  pruneManagedInstanceFiles(path.join(gameRoot, "crash-reports"), 3);
  const sourceOptions = path.join(multiMcRoot, "instances", version, ".minecraft", "options.txt");
  const targetOptions = path.join(gameRoot, "options.txt");
  restoreVisualEnvironment(workspace, sessionName);
  const restoreManifest: any = {
    version: 1,
    gameRoot,
    optionsFile: targetOptions,
    optionsExisted: fs.existsSync(targetOptions),
    optionsText: fs.existsSync(targetOptions) ? fs.readFileSync(targetOptions, "utf8") : "",
    installedFiles: []
  };
  configureManagedVisualOptions(targetOptions, sourceOptions, settings);
  let installedResourcePack: any;
  if (resourcePack) {
    installedResourcePack = installVisualResourcePack(gameRoot, resourcePack.file, resourcePack.uuid);
    restoreManifest.installedFiles.push(installedResourcePack.file);
    let optionsText = fs.readFileSync(targetOptions, "utf8");
    const selected = (() => {
      const match = /^resourcePacks:(.*)$/m.exec(optionsText);
      if (!match) return ["vanilla", installedResourcePack.packId];
      try {
        const values = JSON.parse(match[1]);
        return [...new Set([...(Array.isArray(values) ? values : ["vanilla"]), installedResourcePack.packId])];
      } catch {
        return ["vanilla", installedResourcePack.packId];
      }
    })();
    optionsText = /^resourcePacks:.*$/m.test(optionsText)
      ? optionsText.replace(/^resourcePacks:.*$/m, `resourcePacks:${JSON.stringify(selected)}`)
      : `${optionsText.trimEnd()}\nresourcePacks:${JSON.stringify(selected)}\n`;
    fs.writeFileSync(targetOptions, optionsText, "utf8");
  }
  writeJsonFile(visualRestoreFile(workspace, sessionName), restoreManifest);
  fs.copyFileSync(sourceJar, path.join(mods, "minecraft-cli-control.jar"));
  writeJsonFile(path.join(gameRoot, "minecraft-cli-control.json"), { port, token, version, ...(server ? { serverHost: server.host, serverPort: server.port } : {}) });
  writeJsonFile(path.join(instanceRoot, "mmc-pack.json"), {
    formatVersion: 1,
    components: [
      ...(version === "1.20.1" ? [{ uid: "org.lwjgl3", version: "3.3.1", dependencyOnly: true }] : []),
      { uid: "net.minecraft", version, important: true },
      { uid: "net.fabricmc.intermediary", version, dependencyOnly: true },
      { uid: "net.fabricmc.fabric-loader", version: adapter.loader }
    ]
  });
  fs.writeFileSync(path.join(instanceRoot, "instance.cfg"), [
    "InstanceType=OneSix",
    `name=${instanceId}`,
    "OverrideJavaArgs=false",
    "OverrideMemory=true",
    "MinMemAlloc=512",
    "MaxMemAlloc=2048",
    "OverrideWindow=true",
    "LaunchMaximized=false",
    `MinecraftWinWidth=${settings.width}`,
    `MinecraftWinHeight=${settings.height}`,
    ...(javaPath ? ["OverrideJava=true", `JavaPath=${javaPath.replace(/\\/g, "/")}`] : [])
  ].join("\n") + "\n", "utf8");
  return { launcher, instanceId, instanceRoot, sourceJar, javaRequired: adapter.java, adapter: adapter.project, createdInstance,
    displaySettings: settings, ...(installedResourcePack ? { resourcePack: installedResourcePack } : {}) };
}

interface VisualEntitySummary {
  id: number;
  uuid: string;
  type: string;
  name?: string;
  displayName?: string;
  customName?: string;
  distance: number;
  textDisplay?: {
    text: string;
    position: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    seeThrough: boolean;
    viewRange: number;
    visible: boolean;
    angularErrorDegrees: number;
    selectionConeDegrees: number;
    screenBounds?: { x: number; y: number; width: number; height: number; pixelWidth: number; pixelHeight: number };
  };
}

interface VisualEntitySnapshot {
  snapshotId: number;
  entities: VisualEntitySummary[];
}

function normalizeVisualEntityType(type: string) {
  const normalized = type.trim().toLowerCase();
  const separator = Math.max(normalized.lastIndexOf(":"), normalized.lastIndexOf("."));
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
}

function parseVisualEntitySnapshot(value: any): VisualEntitySnapshot {
  const snapshotId = Number(value?.snapshotId);
  if (!Number.isSafeInteger(snapshotId) || snapshotId < 1 || !Array.isArray(value?.entities)) {
    throw new MinecraftCliError("VISUAL_ENTITY_SNAPSHOT_INVALID", "The visual bridge returned an invalid entity snapshot.", 502);
  }
  const entities = value.entities.map((entity: any) => {
    const parsed: VisualEntitySummary = {
      id: Number(entity?.id),
      uuid: typeof entity?.uuid === "string" ? entity.uuid : "",
      type: typeof entity?.type === "string" ? entity.type : "",
      distance: Number(entity?.distance),
      ...(typeof entity?.name === "string" ? { name: entity.name } : {}),
      ...(typeof entity?.displayName === "string" ? { displayName: entity.displayName } : {}),
      ...(typeof entity?.customName === "string" ? { customName: entity.customName } : {}),
      ...(entity?.textDisplay && typeof entity.textDisplay === "object" ? { textDisplay: entity.textDisplay } : {})
    };
    if (!Number.isInteger(parsed.id) || parsed.id < 0 || !parsed.uuid || !parsed.type || !Number.isFinite(parsed.distance) || parsed.distance < 0) {
      throw new MinecraftCliError("VISUAL_ENTITY_SNAPSHOT_INVALID", "The visual bridge returned a malformed entity entry.", 502, { entity });
    }
    return parsed;
  });
  return { snapshotId, entities };
}

async function visualRequest(runtime: any, route: string, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      headers: { Authorization: runtime.token }, signal: controller.signal
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let body: any;
    try { body = text ? JSON.parse(text) : undefined; }
    catch {
      if (response.status === 404) throw new MinecraftCliError("VISUAL_ROUTE_UNAVAILABLE", `The running control adapter does not provide ${route}. Stop and relaunch the visual session to install the current adapter.`, 409,
        { route, status: response.status, contentType, responsePreview: text.slice(0, 200) });
      throw new MinecraftCliError("VISUAL_CONTROL_RESPONSE_INVALID", `The visual control adapter returned non-JSON for ${route}.`, 502,
        { route, status: response.status, contentType, responsePreview: text.slice(0, 200) });
    }
    if (!response.ok || !body?.ok) {
      const code = response.status === 404 ? "VISUAL_ROUTE_UNAVAILABLE" : "VISUAL_CONTROL_FAILED";
      throw new MinecraftCliError(code, typeof body?.error === "string" ? body.error : `Visual control request failed with HTTP ${response.status}.`, response.status === 404 ? 409 : 500,
        { route, status: response.status, adapterError: body?.error });
    }
    return body;
  } finally { clearTimeout(timer); }
}

async function requireVisualCapability(runtime: any, capability: string) {
  const state: any = await visualRequest(runtime, "/state", 2000);
  if (Number(state.controlProtocol) !== VISUAL_CONTROL_PROTOCOL) {
    throw new MinecraftCliError("VISUAL_CONTROL_ADAPTER_STALE", "The running visual session uses an older control adapter. Stop and relaunch it before using this command.", 409,
      { expectedProtocol: VISUAL_CONTROL_PROTOCOL, actualProtocol: state.controlProtocol ?? null, version: state.version, capability });
  }
  if (state.capabilities?.[capability] !== true) {
    throw new MinecraftCliError("VISUAL_CAPABILITY_UNAVAILABLE", `The running visual adapter does not support ${capability}.`, 409,
      { capability, version: state.version, capabilities: state.capabilities ?? {} });
  }
  return state;
}

async function waitForVisual(runtime: any, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return await visualRequest(runtime, "/health", 1000); }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw new MinecraftCliError("VISUAL_CLIENT_START_TIMEOUT", "Visual client control API did not become ready.", 504, {
    lastError: lastError instanceof Error ? lastError.message : String(lastError)
  });
}

async function waitForVisualConnection(runtime: any, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let state: any;
  while (Date.now() < deadline) {
    state = await visualRequest(runtime, "/state", 2000);
    if (state.connected) return state;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new MinecraftCliError("VISUAL_SERVER_CONNECT_TIMEOUT", "Visual client started but did not connect to the target server.", 504, { state });
}

function getWorkspace() {
  return getPaths(program.opts().workspace).workspace;
}

async function waitForDaemon(workspace: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const state = readDaemonState(workspace);
    if (state && isProcessAlive(state.pid)) {
      try {
        const health = await requestDaemonAt(state.port, "GET", "/health", undefined, 1000, state.token);
        if (daemonHealthMatches(state, workspace, health)) return state;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new MinecraftCliError("DAEMON_START_TIMEOUT", "Daemon did not become ready in time.", 504, {
    timeoutMs,
    lastError: lastError instanceof Error ? lastError.message : lastError
  });
}

function daemonHealthMatches(state: NonNullable<ReturnType<typeof readDaemonState>>, workspace: string, health: any) {
  if (!health?.ok || Number(health.data?.pid) !== state.pid) return false;
  if (typeof state.workspace !== "string" || typeof health.data?.workspace !== "string") return false;
  const expected = getPaths(workspace).workspace;
  const recorded = getPaths(state.workspace).workspace;
  const reported = getPaths(health.data.workspace).workspace;
  return process.platform === "win32"
    ? recorded.toLowerCase() === expected.toLowerCase() && reported.toLowerCase() === expected.toLowerCase()
    : recorded === expected && reported === expected;
}

async function probeDaemon(state: NonNullable<ReturnType<typeof readDaemonState>>, workspace: string, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isProcessAlive(state.pid)) return false;
    try {
      const health = await requestDaemonAt(state.port, "GET", "/health", undefined, 1500, state.token);
      if (daemonHealthMatches(state, workspace, health)) return true;
    } catch {
      // Retry before deciding that a live process is stale.
    }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function retireUnresponsiveDaemon(workspace: string, state: NonNullable<ReturnType<typeof readDaemonState>>, daemonPath: string) {
  try {
    await requestDaemonAt(state.port, "POST", "/daemon/stop", { timeoutMs: 3000 }, 4000, state.token);
  } catch {
    // Fall through to verified process cleanup.
  }
  for (let attempt = 0; attempt < 10 && isProcessAlive(state.pid); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!isProcessAlive(state.pid)) return;
  if (process.platform !== "win32") {
    throw new MinecraftCliError("DAEMON_UNRESPONSIVE", "The existing daemon is alive but unresponsive. Stop it before retrying.", 503);
  }
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter ${powerShellString(`ProcessId=${state.pid}`)}`,
    `$daemon=${powerShellString(path.resolve(daemonPath))}`,
    `$workspace=${powerShellString(path.resolve(workspace))}`,
    `if($p -and $p.Name -like 'node*' -and $p.CommandLine.IndexOf($daemon,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $p.CommandLine.IndexOf($workspace,[StringComparison]::OrdinalIgnoreCase) -ge 0){Stop-Process -Id $p.ProcessId -Force; exit 0}`,
    "exit 3"
  ].join("; ");
  const stopped = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true
  });
  if (stopped.status !== 0) {
    throw new MinecraftCliError("DAEMON_UNRESPONSIVE", "The existing daemon could not be verified for safe replacement.", 503);
  }
}

async function ensureDaemon(workspace: string): Promise<{ state: NonNullable<ReturnType<typeof readDaemonState>>; started: boolean }> {
  ensureBaseDirs(getPaths(workspace));
  const existing = readDaemonState(workspace);
  if (existing && await probeDaemon(existing, workspace)) {
    return { state: existing, started: false };
  }

  return withDaemonStartLock(workspace, async () => {
    const concurrent = readDaemonState(workspace);
    const daemonPath = resolveDistDaemonPath();
    if (!fs.existsSync(daemonPath)) {
      throw new MinecraftCliError("DAEMON_NOT_BUILT", "dist/daemon.js does not exist. Run npm run build first.", 500);
    }
    if (concurrent && await probeDaemon(concurrent, workspace)) {
      return { state: concurrent, started: false };
    }
    if (concurrent && isProcessAlive(concurrent.pid)) {
      await retireUnresponsiveDaemon(workspace, concurrent, daemonPath);
    }

    await launchDaemonProcess(workspace, daemonPath);
    const state = await waitForDaemon(workspace, 30_000);
    return { state, started: true };
  });
}

async function withDaemonStartLock<T>(workspace: string, action: () => Promise<T>): Promise<T> {
  const lockFile = path.join(getPaths(workspace).runtime, "daemon-start.lock");
  const deadline = Date.now() + 35_000;
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lockFile, "wx");
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        if (!isProcessAlive(Number(lock.pid)) || Date.now() - fs.statSync(lockFile).mtimeMs > 60_000) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        if (fs.existsSync(lockFile) && Date.now() - fs.statSync(lockFile).mtimeMs <= 5000) {
          if (Date.now() >= deadline) throw new MinecraftCliError("DAEMON_START_LOCK_TIMEOUT", "Timed out waiting for another daemon start.", 504);
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new MinecraftCliError("DAEMON_START_LOCK_TIMEOUT", "Timed out waiting for another daemon start.", 504);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    return await action();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockFile, { force: true });
  }
}

async function launchDaemonProcess(workspace: string, daemonPath: string) {
  const child = spawn(process.execPath, [daemonPath, "--workspace", workspace], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}

function powerShellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function callDaemon<T>(method: string, route: string, body?: unknown, timeoutMs?: number) {
  const workspace = getWorkspace();
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    await ensureDaemon(workspace);
    const response = await requestDaemon<T>(workspace, method, route, body, timeoutMs);
    if (!(response as any).ok) {
      process.exitCode = (response as any).error.code === "INTERNAL_ERROR" ? 1 : 2;
    }
    printResponse(response, { json: program.opts().json });
  } finally {
    clearInterval(keepAlive);
  }
}

async function requestDaemonForCli<T>(method: string, route: string, body?: unknown, timeoutMs?: number) {
  const workspace = getWorkspace();
  await ensureDaemon(workspace);
  const response = await requestDaemon<T>(workspace, method, route, body, timeoutMs);
  if (!(response as any).ok) {
    throw new MinecraftCliError(
      (response as any).error?.code ?? "DAEMON_REQUEST_FAILED",
      (response as any).error?.message ?? "Daemon request failed.",
      500,
      (response as any).error?.details
    );
  }
  return (response as any).data as T;
}

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    process.exitCode = error instanceof MinecraftCliError && error.status >= 500 ? 1 : 2;
    printResponse(toErrorResponse(error), { json: program.opts().json });
  }
}

program
  .command("status")
  .description("Show daemon and client session status.")
  .action(() => run(async () => callDaemon("GET", "/status")));

const auth = program.command("auth").description("Manage reusable Microsoft authentication.");

auth
  .command("login")
  .description("Sign in with a Microsoft device code and cache the result outside the project.")
  .argument("<account>", "local account alias, such as main")
  .option("--no-browser", "do not open the Microsoft sign-in page")
  .option("--no-clipboard", "do not copy the device code to the clipboard")
  .action((accountValue: string, options) => run(async () => {
    const account = normalizeAccountAlias(accountValue);
    const paths = ensureAccountCache(account);
    let prompted = false;
    const flow = new Authflow(account, paths.cache, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo",
      flow: "live"
    }, (code: any) => {
      prompted = true;
      const verificationUri = String(code.verification_uri ?? "https://www.microsoft.com/link");
      const userCode = String(code.user_code ?? "");
      const copied = options.clipboard ? copyMicrosoftCodeToClipboard(userCode) : false;
      const browserOpened = options.browser ? openMicrosoftLoginBrowser(userCode, verificationUri) : false;
      fs.writeSync(2, [
        "",
        "Microsoft sign-in required",
        browserOpened ? "Browser: opened with the device code" : `Open: ${verificationUri}`,
        `Code: ${userCode}${copied ? " (copied to clipboard)" : ""}`,
        ""
      ].join("\n") + "\n");
    });
    const result = await flow.getMinecraftJavaToken({
      fetchEntitlements: true,
      fetchProfile: true,
      fetchCertificates: true
    });
    if (!result.profile?.name || !result.profile?.id) {
      throw new MinecraftCliError("MICROSOFT_PROFILE_MISSING", "The signed-in account does not have a Minecraft Java profile.", 403);
    }
    const signedInAt = new Date().toISOString();
    const profile = writeAccountProfile({
      account,
      profileName: result.profile.name,
      profileId: result.profile.id,
      signedInAt
    });
    printResponse({
      ok: true,
      data: {
        ...publicAccountProfile(profile),
        reusedCache: !prompted
      }
    }, { json: program.opts().json });
  }));

auth
  .command("status")
  .description("Show signed-in account aliases without exposing cached tokens.")
  .argument("[account]", "optional local account alias")
  .action((accountValue?: string) => run(async () => {
    const profiles = accountValue ? [readAccountProfile(accountValue)] : listAccountProfiles();
    printResponse({ ok: true, data: { accounts: profiles.map(publicAccountProfile) } }, { json: program.opts().json });
  }));

auth
  .command("logout")
  .description("Delete one locally cached Microsoft account.")
  .argument("<account>", "local account alias")
  .action((accountValue: string) => run(async () => {
    printResponse({ ok: true, data: removeAccount(accountValue) }, { json: program.opts().json });
  }));

const daemon = program.command("daemon").description("Manage the local persistent controller.");

daemon
  .command("start")
  .description("Start the local controller daemon.")
  .option("--foreground", "run in the foreground", false)
  .action((options) =>
    run(async () => {
      const workspace = getWorkspace();
      ensureBaseDirs(getPaths(workspace));
      if (options.foreground) {
        const daemonPath = resolveDistDaemonPath();
        const child = spawn(process.execPath, [daemonPath, "--workspace", workspace], {
          cwd: workspace,
          stdio: "inherit",
          windowsHide: true
        });
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new MinecraftCliError("DAEMON_EXITED", `Daemon exited with code ${code}.`, 500));
          });
        });
        return;
      }

      const daemon = await ensureDaemon(workspace);
      printResponse({ ok: true, data: daemon.state }, { json: program.opts().json });
    })
  );

daemon
  .command("stop")
  .description("Stop the local controller daemon and disconnect sessions.")
  .option("--timeout <ms>", "stop timeout", (value) => Number(value), 30_000)
  .action((options) => run(async () => callDaemon("POST", "/daemon/stop", { timeoutMs: options.timeout }, options.timeout + 5000)));

const session = program.command("session").description("Manage persistent Minecraft client sessions.");

session
  .command("create")
  .description("Create a named offline or Microsoft-authenticated client session.")
  .argument("<name>", "stable session handle")
  .option("--auth <mode>", "offline or microsoft", "offline")
  .option("--account <account>", "Microsoft account alias created by auth login")
  .option("--username <username>", "offline Minecraft username")
  .option("--host <host>", "server host or IP address", "127.0.0.1")
  .option("--port <port>", "server port", (value) => Number(value), 25565)
  .option("--version <version>", "Minecraft protocol version", "1.21.4")
  .option("--timeout <ms>", "connect timeout when --connect is used", (value) => Number(value), 60_000)
  .option("--connect", "connect immediately", false)
  .action((name: string, options) =>
    run(async () =>
      callDaemon(
        "POST",
        "/session/create",
        {
          name,
          auth: options.auth,
          account: options.account,
          username: options.username,
          host: options.host,
          port: options.port,
          version: options.version,
          timeoutMs: options.timeout,
          connect: options.connect
        },
        Math.max(120_000, options.timeout + 5000)
      )
    )
  );

session
  .command("connect")
  .description("Connect a session to its configured external server.")
  .argument("<name>")
  .option("--host <host>", "override server host or IP address")
  .option("--port <port>", "override server port", (value) => Number(value))
  .option("--version <version>", "override Minecraft protocol version")
  .option("--timeout <ms>", "connect timeout", (value) => Number(value), 60_000)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/connect`, options, options.timeout + 5000))
  );

session.command("disconnect").description("Disconnect a session.").argument("<name>").option("--timeout <ms>", "disconnect timeout", (value) => Number(value), 20_000).action(
  (name: string, options) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/disconnect`, options, options.timeout + 5000))
);

session.command("destroy").description("Disconnect and remove a session.").argument("<name>").action((name: string) =>
  run(async () => callDaemon("DELETE", `/session/${encodeURIComponent(name)}`))
);

session.command("list").description("List sessions.").action(() => run(async () => callDaemon("GET", "/session")));

session.command("state").description("Show one session state or a token-efficient part.").argument("<name>")
  .option("--part <part>", "core, inventory, entities, window, ui, hud, or events")
  .action((name: string, options) => run(async () => {
    const query = options.part ? `?part=${encodeURIComponent(options.part)}` : "";
    await callDaemon("GET", `/session/${encodeURIComponent(name)}/state${query}`);
  }));

session
  .command("chat")
  .description("Send normal player chat.")
  .argument("<name>")
  .argument("<message...>")
  .action((name: string, message: string[]) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/chat`, { message: message.join(" ") })));

session
  .command("command")
  .description("Run a slash command as the selected player.")
  .allowUnknownOption(true)
  .argument("<name>")
  .argument("<command...>")
  .action((name: string, command: string[]) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/command`, { command: command.join(" ") })));

session
  .command("move")
  .description("Apply movement controls for a bounded number of ticks.")
  .argument("<name>")
  .option("--forward", "walk forward", false)
  .option("--back", "walk backward", false)
  .option("--left", "strafe left", false)
  .option("--right", "strafe right", false)
  .option("--jump", "jump", false)
  .option("--sprint", "sprint", false)
  .option("--sneak", "sneak", false)
  .option("--ticks <ticks>", "duration in game ticks", (value) => Number(value), 20)
  .action((name: string, options) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/move`, options, (options.ticks * 50) + 10_000)));

session
  .command("select-slot")
  .description("Select a hotbar slot.")
  .argument("<name>")
  .requiredOption("--slot <slot>", "hotbar slot 0-8", (value) => Number(value))
  .action((name: string, options) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/select-slot`, options)));

session
  .command("equip-item")
  .description("Equip an inventory item to hand, off-hand, or armor slot.")
  .argument("<name>")
  .option("--item <item>", "item id/name text to find, such as stone")
  .option("--slot <slot>", "inventory/window slot id to equip", (value) => Number(value))
  .option("--destination <destination>", "hand, off-hand, head, torso, legs, or feet", "hand")
  .option("--ticks <ticks>", "ticks to wait after equipping", (value) => Number(value), 5)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/equip-item`, options, options.ticks * 50 + 10_000))
  );

session
  .command("look")
  .description("Rotate the selected player.")
  .argument("<name>")
  .requiredOption("--yaw <degrees>", "yaw in degrees", Number)
  .requiredOption("--pitch <degrees>", "pitch in degrees", Number)
  .action((name: string, options) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/look`, options)));

session
  .command("look-at")
  .description("Look at a nearby entity or coordinate.")
  .argument("<name>")
  .option("--entity-id <id>", "target entity id", Number)
  .option("--entity <name>", "target entity name, such as villager")
  .option("--username <username>", "target player username")
  .option("--role <text>", "visible/custom name or role text, such as archer")
  .option("--nearest", "use the nearest matching entity", false)
  .option("--x <x>", "target x coordinate", Number)
  .option("--y <y>", "target y coordinate", Number)
  .option("--z <z>", "target z coordinate", Number)
  .option("--max-distance <blocks>", "maximum entity search distance", Number, 8)
  .action((name: string, options) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/look-at`, options)));

session
  .command("interact")
  .description("Right-click a nearby entity.")
  .argument("<name>")
  .option("--entity-id <id>", "target entity id", Number)
  .option("--entity <name>", "target entity name, such as villager")
  .option("--username <username>", "target player username")
  .option("--role <text>", "visible/custom name or role text, such as archer")
  .option("--nearest", "use the nearest matching entity", false)
  .option("--max-distance <blocks>", "maximum entity search distance", Number, 8)
  .option("--method <method>", "entity interaction method: normal, at, or both", "at")
  .option("--ticks <ticks>", "ticks to wait after interaction", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/interact`, options, options.ticks * 50 + 10_000))
  );

session
  .command("use-on")
  .description("Use the currently held item on a nearby entity.")
  .argument("<name>")
  .option("--entity-id <id>", "target entity id", Number)
  .option("--entity <name>", "target entity name, such as pig")
  .option("--username <username>", "target player username")
  .option("--role <text>", "visible/custom name or role text, such as archer")
  .option("--nearest", "use the nearest matching entity", false)
  .option("--max-distance <blocks>", "maximum entity search distance", Number, 8)
  .option("--ticks <ticks>", "ticks to wait after using the item", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/use-on`, options, options.ticks * 50 + 10_000))
  );

session.command("wait").description("Wait game ticks for a selected player.").argument("<name>").option("--ticks <ticks>", "ticks", (value) => Number(value), 20).action(
  (name: string, options) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/wait`, options, (options.ticks * 50) + 10_000))
);

session
  .command("use-item")
  .description("Use the currently held item.")
  .argument("<name>")
  .option("--offhand", "use offhand item", false)
  .option("--air", "look upward before using, avoiding block/entity raycasts", false)
  .option("--ticks <ticks>", "ticks to hold/use before releasing", (value) => Number(value), 10)
  .option("--keep-active", "do not send deactivate after waiting", false)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/use-item`, options, options.ticks * 50 + 10_000))
  );

session
  .command("activate-block")
  .description("Right-click a block at coordinates or under the crosshair.")
  .argument("<name>")
  .option("--x <x>", "block x coordinate", Number)
  .option("--y <y>", "block y coordinate", Number)
  .option("--z <z>", "block z coordinate", Number)
  .option("--cursor", "use the block currently under the crosshair", false)
  .option("--max-distance <blocks>", "cursor search distance", Number, 5)
  .option("--ticks <ticks>", "ticks to wait after activation", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/activate-block`, options, options.ticks * 50 + 10_000))
  );

session
  .command("dig-block")
  .description("Break a block at coordinates or under the crosshair.")
  .argument("<name>")
  .option("--x <x>", "block x coordinate", Number)
  .option("--y <y>", "block y coordinate", Number)
  .option("--z <z>", "block z coordinate", Number)
  .option("--cursor", "use the block currently under the crosshair", false)
  .option("--max-distance <blocks>", "cursor search distance", Number, 5)
  .option("--ticks <ticks>", "ticks to wait after digging", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/dig-block`, options, options.ticks * 50 + 30_000))
  );

session
  .command("place-block")
  .description("Place the held block against a reference block.")
  .argument("<name>")
  .requiredOption("--x <x>", "reference block x coordinate", Number)
  .requiredOption("--y <y>", "reference block y coordinate", Number)
  .requiredOption("--z <z>", "reference block z coordinate", Number)
  .option("--face <face>", "placement face: up, down, north, south, east, or west", "up")
  .option("--ticks <ticks>", "ticks to wait after placing", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/place-block`, options, options.ticks * 50 + 30_000))
  );

session
  .command("attack")
  .description("Attack a nearby entity.")
  .argument("<name>")
  .option("--entity-id <id>", "target entity id", Number)
  .option("--entity <name>", "target entity name, such as pig")
  .option("--username <username>", "target player username")
  .option("--role <text>", "visible/custom name or role text, such as archer")
  .option("--nearest", "use the nearest matching entity", false)
  .option("--max-distance <blocks>", "maximum entity search distance", Number, 8)
  .option("--ticks <ticks>", "ticks to wait after attacking", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/attack`, options, options.ticks * 50 + 10_000))
  );

session
  .command("toss-item")
  .description("Drop items from the currently held stack.")
  .argument("<name>")
  .option("--count <count>", "number of items to drop", (value) => Number(value), 1)
  .option("--ticks <ticks>", "ticks to wait after dropping", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/toss-item`, options, options.ticks * 50 + 10_000))
  );

session
  .command("swing-arm")
  .description("Send a hand swing animation.")
  .argument("<name>")
  .option("--hand <hand>", "left or right", "right")
  .option("--ticks <ticks>", "ticks to wait after swinging", (value) => Number(value), 5)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/swing-arm`, options, options.ticks * 50 + 10_000))
  );

session
  .command("respawn")
  .description("Request respawn for the selected session.")
  .argument("<name>")
  .option("--ticks <ticks>", "ticks to wait after respawn", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/respawn`, options, options.ticks * 50 + 10_000))
  );

session
  .command("click-slot")
  .description("Click a slot in the currently open GUI/window.")
  .argument("<name>")
  .requiredOption("--slot <slot>", "window slot index", (value) => Number(value))
  .option("--button <button>", "left, right, or middle", "left")
  .option("--mode <mode>", "normal, shift, number, or drop", "normal")
  .option("--ticks <ticks>", "ticks to wait after the click", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/click-slot`, options, options.ticks * 50 + 10_000))
  );

session
  .command("click-item")
  .description("Find and click an item in the currently open GUI/window.")
  .argument("<name>")
  .option("--title <title>", "exact window title")
  .option("--title-contains <text>", "window title substring")
  .option("--item <item>", "item id/display text to find")
  .option("--name <text>", "custom/display name text to find")
  .option("--lore <text>", "lore text to find; repeatable", collect, [])
  .option("--index <index>", "zero-based match index when several items match", (value) => Number(value), 0)
  .option("--button <button>", "left, right, or middle", "left")
  .option("--mode <mode>", "normal, shift, number, or drop", "normal")
  .option("--case-sensitive", "match case exactly", false)
  .option("--ticks <ticks>", "ticks to wait after the click", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/click-item`, options, options.ticks * 50 + 10_000))
  );

session
  .command("close-window")
  .description("Close the currently open GUI/window, like pressing ESC.")
  .argument("<name>")
  .option("--ticks <ticks>", "ticks to wait after closing", (value) => Number(value), 20)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/close-window`, options, options.ticks * 50 + 10_000))
  );

session
  .command("expect-event")
  .description("Assert that a recent session event contains expected text.")
  .argument("<name>")
  .option("--type <type>", "event type to search, such as message or title")
  .option("--contains <text>", "text that must appear; repeatable", collect, [])
  .option("--case-sensitive", "match case exactly", false)
  .option("--after <sequence>", "only match events after this sequence", (value) => Number(value))
  .option("--timeout-ticks <ticks>", "ticks to wait for the expectation", (value) => Number(value), 0)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/expect-event`, { ...options, afterSequence: options.after }, options.timeoutTicks * 50 + 10_000))
  );

session
  .command("expect-transition")
  .description("Wait for a proxy/backend transition and verify the client reconnects stably.")
  .argument("<name>")
  .requiredOption("--after <sequence>", "event sequence captured before triggering the move", (value) => Number(value))
  .option("--to-dimension <dimension>", "expected destination dimension text")
  .option("--brand <brand>", "expected server brand text")
  .option("--contains <text>", "other transition text to require; repeatable", collect, [])
  .option("--timeout-ticks <ticks>", "maximum transition wait", (value) => Number(value), 200)
  .option("--stable-ticks <ticks>", "connected ticks required after transition", (value) => Number(value), 10)
  .action((name: string, options) => run(async () => {
    if (!Number.isInteger(options.after) || options.after < 0) throw new MinecraftCliError("INVALID_EVENT_SEQUENCE", "Event sequence must be a non-negative integer.", 400);
    const contains = [...(options.contains ?? []), ...(options.toDimension ? [options.toDimension] : []), ...(options.brand ? [options.brand] : [])];
    const transition = await requestDaemonForCli("POST", `/session/${encodeURIComponent(name)}/expect-event`, {
      types: ["server_transition", "game_change", "spawn"],
      contains,
      afterSequence: options.after,
      timeoutTicks: options.timeoutTicks
    }, options.timeoutTicks * 50 + 10_000);
    const deadline = Date.now() + options.timeoutTicks * 50;
    let core: any;
    while (Date.now() <= deadline) {
      core = await requestDaemonForCli("GET", `/session/${encodeURIComponent(name)}/state?part=core`);
      if (core.connected && !core.connecting) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!core?.connected || core.connecting) throw new MinecraftCliError("TRANSITION_CONNECTION_UNSTABLE", "Transition event arrived but the destination connection did not stabilize.", 504, { transition, core });
    if (options.stableTicks > 0) await requestDaemonForCli("POST", `/session/${encodeURIComponent(name)}/wait`, { ticks: options.stableTicks }, options.stableTicks * 50 + 10_000);
    printResponse({ ok: true, data: { matched: true, transition, destination: core, stableTicks: options.stableTicks } }, { json: program.opts().json });
  }));

session
  .command("events")
  .description("List recent session events, optionally filtered.")
  .argument("<name>")
  .option("--type <type>", "event type to list")
  .option("--contains <text>", "text that must appear; repeatable", collect, [])
  .option("--case-sensitive", "match case exactly", false)
  .option("--limit <count>", "maximum events to return", (value) => Number(value), 30)
  .option("--after <sequence>", "return only events after this sequence", (value) => Number(value))
  .action((name: string, options) =>
    run(async () => {
      const query = new URLSearchParams();
      if (options.type) query.set("type", options.type);
      for (const value of options.contains ?? []) query.append("contains", value);
      if (options.caseSensitive) query.set("caseSensitive", "true");
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.after !== undefined) query.set("after", String(options.after));
      const suffix = query.toString() ? `?${query.toString()}` : "";
      await callDaemon("GET", `/session/${encodeURIComponent(name)}/events${suffix}`);
    })
  );

session
  .command("clear-events")
  .description("Clear the recent event buffer for a session.")
  .argument("<name>")
  .action((name: string) => run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/clear-events`)));

session
  .command("expect-chat")
  .description("Assert that recent chat/system text contains expected text.")
  .argument("<name>")
  .option("--contains <text>", "text that must appear; repeatable", collect, [])
  .option("--case-sensitive", "match case exactly", false)
  .option("--timeout-ticks <ticks>", "ticks to wait for the expectation", (value) => Number(value), 0)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/expect-chat`, options, options.timeoutTicks * 50 + 10_000))
  );

session
  .command("expect-window")
  .description("Assert that the current GUI/window matches expected title or slot contents.")
  .argument("<name>")
  .option("--title <title>", "exact window title")
  .option("--title-contains <text>", "window title substring")
  .option("--slot <slot>", "window slot to inspect", (value) => Number(value))
  .option("--item <item>", "item id/display text expected in the slot or any slot")
  .option("--name <text>", "custom/display name text expected")
  .option("--lore <text>", "lore text expected; repeatable", collect, [])
  .option("--case-sensitive", "match case exactly", false)
  .option("--timeout-ticks <ticks>", "ticks to wait for the expectation", (value) => Number(value), 0)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/expect-window`, options, options.timeoutTicks * 50 + 10_000))
  );

session
  .command("expect-inventory")
  .description("Assert that inventory contains an expected item.")
  .argument("<name>")
  .option("--slot <slot>", "inventory/window slot to inspect", (value) => Number(value))
  .option("--item <item>", "item id/display text expected")
  .option("--name <text>", "custom/display name text expected")
  .option("--lore <text>", "lore text expected; repeatable", collect, [])
  .option("--count <count>", "minimum stack count expected", (value) => Number(value))
  .option("--case-sensitive", "match case exactly", false)
  .option("--timeout-ticks <ticks>", "ticks to wait for the expectation", (value) => Number(value), 0)
  .action((name: string, options) =>
    run(async () => callDaemon("POST", `/session/${encodeURIComponent(name)}/expect-inventory`, options, options.timeoutTicks * 50 + 10_000))
  );

session
  .command("save-state")
  .description("Save the current session state JSON under the session artifact folder.")
  .argument("<name>")
  .option("--label <label>", "file label", "state")
  .action((name: string, options) =>
    run(async () => {
      const workspace = getWorkspace();
      const dirs = ensureSessionArtifactDirs(workspace, name);
      const state = await requestDaemonForCli("GET", `/session/${encodeURIComponent(name)}/state`);
      const file = path.join(dirs.json, `${timestampFilePart()}-${safeFilePart(options.label)}.json`);
      writeJsonFile(file, state);
      printResponse({ ok: true, data: { session: name, file, state } }, { json: program.opts().json });
    })
  );

session
  .command("checkpoint")
  .description("Save named core, window, UI, HUD, entity, inventory, and event baselines.")
  .argument("<name>")
  .requiredOption("--label <label>", "stable checkpoint name")
  .option("--parts <parts>", "comma-separated checkpoint parts")
  .action((name: string, options) => run(async () => {
    const workspace = getWorkspace();
    const label = normalizeCheckpointLabel(options.label);
    const { checkpoint, file } = await captureCheckpoint(workspace, name, label, options.parts);
    printResponse({ ok: true, data: { session: name, label, parts: Object.keys(checkpoint.parts), eventCursor: checkpoint.eventCursor, file } }, { json: program.opts().json, compactJson: true });
  }));

session
  .command("diff")
  .description("Return only state and event changes since a named checkpoint.")
  .argument("<name>")
  .requiredOption("--baseline <label>", "checkpoint name")
  .option("--parts <parts>", "comma-separated parts to compare")
  .option("--assert-unchanged", "fail when any selected value changed", false)
  .action((name: string, options) => run(async () => {
    const workspace = getWorkspace();
    const label = normalizeCheckpointLabel(options.baseline);
    const comparison: any = await compareCheckpoint(workspace, name, label, options.parts);
    const dirs = ensureSessionArtifactDirs(workspace, name);
    const reportFile = path.join(dirs.json, `${timestampFilePart()}-${safeFilePart(label)}.state-diff.json`);
    writeJsonFile(reportFile, redactSecrets(comparison));
    if (comparison.changed && options.assertUnchanged) {
      throw new MinecraftCliError("CHECKPOINT_CHANGED", `Session '${name}' changed since checkpoint '${label}'.`, 409, { reportFile, changeCount: comparison.changeCount, parts: Object.keys(comparison.parts) });
    }
    if (!comparison.changed) {
      printResponse({ ok: true, data: { session: name, baseline: label, changed: false, changeCount: 0, reportFile } }, { json: program.opts().json, compactJson: true });
      return;
    }
    const compactParts = Object.fromEntries(Object.entries(comparison.parts).map(([part, value]: [string, any]) => [part, {
      ...value,
      ...(Array.isArray(value.changes) ? { changes: value.changes.slice(0, 50) } : {}),
      ...(Array.isArray(value.events) ? { events: value.events.slice(0, 50) } : {})
    }]));
    printResponse({ ok: true, data: { ...comparison, parts: compactParts, reportFile } }, { json: program.opts().json, compactJson: true });
  }));

session
  .command("checkpoint-list")
  .description("List named checkpoints for one session.")
  .argument("<name>")
  .action((name: string) => run(async () => {
    const dir = checkpointDirectory(getWorkspace(), name);
    const checkpoints = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name.slice(0, -5)).sort();
    printResponse({ ok: true, data: { session: name, count: checkpoints.length, checkpoints } }, { json: program.opts().json, compactJson: true });
  }));

session
  .command("checkpoint-delete")
  .description("Delete one named session checkpoint.")
  .argument("<name>")
  .requiredOption("--label <label>", "checkpoint name")
  .action((name: string, options) => run(async () => {
    const label = normalizeCheckpointLabel(options.label);
    const file = checkpointPath(getWorkspace(), name, label);
    if (!fs.existsSync(file)) throw new MinecraftCliError("CHECKPOINT_NOT_FOUND", `Checkpoint '${label}' does not exist.`, 404);
    fs.rmSync(file, { force: true });
    printResponse({ ok: true, data: { session: name, label, deleted: true } }, { json: program.opts().json, compactJson: true });
  }));

session
  .command("inventory-checkpoint")
  .description("Save an exact all-slot inventory snapshot for later comparison.")
  .argument("<name>")
  .option("--label <label>", "file label", "inventory")
  .action((name: string, options) => run(async () => {
    const workspace = getWorkspace();
    const dirs = ensureSessionArtifactDirs(workspace, name);
    const snapshot: any = await requestDaemonForCli("GET", `/session/${encodeURIComponent(name)}/state?part=inventory`);
    const file = path.join(dirs.json, `${timestampFilePart()}-${safeFilePart(options.label)}.inventory.json`);
    writeJsonFile(file, snapshot);
    printResponse({ ok: true, data: { session: name, file, hash: snapshot.hash, slotCount: snapshot.slotCount } }, { json: program.opts().json });
  }));

session
  .command("compare-inventory")
  .description("Compare every inventory slot and item metadata with a saved checkpoint.")
  .argument("<name>")
  .requiredOption("--baseline <file>", "inventory checkpoint JSON file")
  .option("--allow-changes", "return a successful diff instead of asserting equality", false)
  .action((name: string, options) => run(async () => {
    const baselineFile = path.resolve(options.baseline);
    let baseline: any;
    try {
      baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    } catch (error) {
      throw new MinecraftCliError("INVENTORY_BASELINE_INVALID", `Could not read inventory baseline: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
    if (!Array.isArray(baseline?.slots) || typeof baseline?.hash !== "string") {
      throw new MinecraftCliError("INVENTORY_BASELINE_INVALID", "Baseline must be created by session inventory-checkpoint.", 400);
    }
    const current: any = await requestDaemonForCli("GET", `/session/${encodeURIComponent(name)}/state?part=inventory`);
    const maxSlots = Math.max(baseline.slots.length, current.slots.length);
    const changes = [];
    for (let slot = 0; slot < maxSlots; slot++) {
      const before = baseline.slots[slot] ?? null;
      const after = current.slots[slot] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ slot, before, after });
    }
    const workspace = getWorkspace();
    const dirs = ensureSessionArtifactDirs(workspace, name);
    const reportFile = path.join(dirs.json, `${timestampFilePart()}-inventory-diff.json`);
    const comparison = {
      session: name,
      matched: changes.length === 0,
      baselineFile,
      baselineHash: baseline.hash,
      currentHash: current.hash,
      baselineSlotCount: baseline.slots.length,
      currentSlotCount: current.slots.length,
      changeCount: changes.length,
      changes
    };
    writeJsonFile(reportFile, comparison);
    if (changes.length > 0 && !options.allowChanges) {
      throw new MinecraftCliError("INVENTORY_CHANGED", "Inventory no longer matches the saved checkpoint.", 409, {
        reportFile,
        baselineHash: baseline.hash,
        currentHash: current.hash,
        changeCount: changes.length,
        changes: changes.slice(0, 20)
      });
    }
    printResponse({ ok: true, data: { ...comparison, reportFile, changes: changes.slice(0, 20) } }, { json: program.opts().json });
  }));

session
  .command("screenshot")
  .description("Capture a real Minecraft window into the session screenshot folder.")
  .argument("<name>")
  .option("--label <label>", "file label", "screen")
  .option("--window-title <title>", "window title substring to capture")
  .option("--hover-slot <slot>", "move the mouse over a chest-style GUI slot before capture", (value) => Number(value))
  .option("--mouse-x <x>", "absolute screen mouse x before capture", (value) => Number(value))
  .option("--mouse-y <y>", "absolute screen mouse y before capture", (value) => Number(value))
  .option("--open-chat", "open the Minecraft chat overlay before capture", false)
  .option("--resume-game", "press Escape once to close a pause/chat overlay before the trigger", false)
  .option("--hover-chat-line <line>", "hover a visible chat line counted upward from the input", (value) => Number(value))
  .option("--click-hover", "left-click after positioning the hover cursor", false)
  .option("--trigger-command <command>", "run a Mineflayer player command before capture")
  .option("--expect-type <type>", "wait for this session event type before capture")
  .option("--expect-contains <text>", "wait for matching event text before capture")
  .option("--wait-ticks <ticks>", "wait after the trigger before capture", (value) => Number(value), 10)
  .option("--native", "use Minecraft's own F2 screenshot and copy it into the session folder", false)
  .option("--save-state", "also save session state JSON next to screenshot metadata", true)
  .action((name: string, options) =>
    run(async () => {
      if (process.platform !== "win32") {
        throw new MinecraftCliError("SCREENSHOT_UNSUPPORTED", "Window screenshot capture is currently implemented for Windows.", 501);
      }
      const workspace = getWorkspace();
      const dirs = ensureSessionArtifactDirs(workspace, name);
      const startedAt = Date.now();
      let trigger: unknown;
      let expectation: unknown;
      if (options.triggerCommand) {
        trigger = await requestDaemonForCli("POST", `/session/${encodeURIComponent(name)}/command`, {
          command: options.triggerCommand
        });
      }
      if (options.expectType || options.expectContains) {
        expectation = await requestDaemonForCli(
          "POST",
          `/session/${encodeURIComponent(name)}/expect-event`,
          {
            type: options.expectType,
            contains: options.expectContains ? [options.expectContains] : [],
            timeoutTicks: 100
          },
          15_000
        );
      }
      if (options.triggerCommand) {
        await requestDaemonForCli("POST", `/session/${encodeURIComponent(name)}/wait`, {
          ticks: Math.max(1, Math.min(Number(options.waitTicks), 200))
        });
      }
      const state: any = await requestDaemonForCli("GET", `/session/${encodeURIComponent(name)}/state`);
      const label = safeFilePart(options.label);
      const timestamp = timestampFilePart();
      const file = path.join(dirs.screenshots, `${timestamp}-${label}.png`);
      const metadataFile = path.join(dirs.json, `${timestamp}-${label}.screenshot.json`);
      const title = String(options.windowTitle ?? `Minecraft ${state.server?.version ?? ""}`).trim();
      const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class McCliWindowShot {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static bool ForceForeground(IntPtr hWnd) {
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    bool attached = foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
    try {
      ShowWindow(hWnd, 9);
      BringWindowToTop(hWnd);
      return SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
$title = ${powerShellString(title)}
$out = ${powerShellString(file)}
$hoverSlot = ${Number.isFinite(Number(options.hoverSlot)) ? Math.floor(Number(options.hoverSlot)) : -1}
$mouseX = ${Number.isFinite(Number(options.mouseX)) ? Math.floor(Number(options.mouseX)) : -1}
$mouseY = ${Number.isFinite(Number(options.mouseY)) ? Math.floor(Number(options.mouseY)) : -1}
$openChat = ${options.openChat ? "$true" : "$false"}
$resumeGame = ${options.resumeGame ? "$true" : "$false"}
$hoverChatLine = ${Number.isFinite(Number(options.hoverChatLine)) ? Math.max(0, Math.floor(Number(options.hoverChatLine))) : -1}
$clickHover = ${options.clickHover ? "$true" : "$false"}
$native = ${options.native ? "$true" : "$false"}
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
if (-not $p) { throw "Minecraft window matching '$title' was not found." }
Get-Process | Where-Object { $_.Id -ne $p.Id -and $_.MainWindowTitle -like '*Minecraft*' } | ForEach-Object {
  [McCliWindowShot]::ShowWindow($_.MainWindowHandle, 6) | Out-Null
}
[McCliWindowShot]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
$shell = New-Object -ComObject WScript.Shell
$activated = $false
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  [McCliWindowShot]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [McCliWindowShot]::ForceForeground($p.MainWindowHandle) | Out-Null
  [McCliWindowShot]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void]$shell.AppActivate($p.Id)
  Start-Sleep -Milliseconds 250
  if ([McCliWindowShot]::GetForegroundWindow() -eq $p.MainWindowHandle) { $activated = $true; break }
}
if (-not $activated) { throw "Minecraft window could not be activated." }
[McCliWindowShot]::SetWindowPos($p.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
if ([McCliWindowShot]::GetForegroundWindow() -ne $p.MainWindowHandle) {
  throw "Minecraft window is not the foreground window."
}
if ($resumeGame) {
  [McCliWindowShot]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
  [McCliWindowShot]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 600
}
$r = New-Object McCliWindowShot+RECT
[McCliWindowShot]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($openChat) {
  [McCliWindowShot]::keybd_event(0x54, 0, 0, [UIntPtr]::Zero)
  [McCliWindowShot]::keybd_event(0x54, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}
if ($mouseX -ge 0 -and $mouseY -ge 0) {
  [McCliWindowShot]::SetCursorPos($mouseX, $mouseY) | Out-Null
  Start-Sleep -Milliseconds 700
} elseif ($hoverSlot -ge 0) {
  $clientTop = $r.Top + 31
  $clientHeight = $h - 31
  $scale = [Math]::Floor([Math]::Min($w / 320, $clientHeight / 240))
  if ($scale -lt 1) { $scale = 1 }
  if ($scale -gt 4) { $scale = 4 }
  $guiWidth = 176 * $scale
  $guiHeight = 166 * $scale
  $guiLeft = $r.Left + (($w - $guiWidth) / 2)
  $guiTop = $clientTop + (($clientHeight - $guiHeight) / 2)
  $col = $hoverSlot % 9
  $row = [Math]::Floor($hoverSlot / 9)
  $x = [int]($guiLeft + (8 + ($col * 18) + 9) * $scale)
  $y = [int]($guiTop + (18 + ($row * 18) + 9) * $scale)
  [McCliWindowShot]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 900
} elseif ($hoverChatLine -ge 0) {
  $clientTop = $r.Top + 31
  $x = [int]($r.Left + [Math]::Max(80, $w * 0.18))
  $y = [int]($clientTop + $h - 72 - ($hoverChatLine * 18))
  [McCliWindowShot]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 900
}
if ($clickHover) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class McCliMouseClick {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
  [McCliMouseClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [McCliMouseClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 800
}
if ($native) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class McCliKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
  $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)"
  $match = [regex]::Match($procInfo.CommandLine, '-Djava\\.library\\.path=([^ ]+)')
  if (-not $match.Success) { throw "Could not find Minecraft instance path for native screenshot." }
  $nativePath = $match.Groups[1].Value -replace '/', '\\'
  $instanceRoot = Split-Path -Parent $nativePath
  $screenshotsDir = Join-Path $instanceRoot '.minecraft\\screenshots'
  New-Item -ItemType Directory -Force -Path $screenshotsDir | Out-Null
  $before = Get-ChildItem -LiteralPath $screenshotsDir -Filter '*.png' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $beforeHash = if ($before) { (Get-FileHash -LiteralPath $before.FullName -Algorithm SHA256).Hash } else { $null }
  $shell.SendKeys('{F2}')
  Start-Sleep -Seconds 2
  $shot = Get-ChildItem -LiteralPath $screenshotsDir -Filter '*.png' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $shot) { throw "Minecraft did not create a native screenshot." }
  if ($before -and $shot.FullName -eq $before.FullName) {
    $afterHash = (Get-FileHash -LiteralPath $shot.FullName -Algorithm SHA256).Hash
    if ($afterHash -eq $beforeHash) {
      [McCliKeys]::keybd_event(0x71, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 100
      [McCliKeys]::keybd_event(0x71, 0, 2, [UIntPtr]::Zero)
      Start-Sleep -Seconds 2
      $shot = Get-ChildItem -LiteralPath $screenshotsDir -Filter '*.png' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      $afterHash = (Get-FileHash -LiteralPath $shot.FullName -Algorithm SHA256).Hash
      if ($afterHash -eq $beforeHash) { throw "Minecraft native screenshot did not update after retry." }
    }
  }
  Copy-Item -LiteralPath $shot.FullName -Destination $out -Force
  $image = [System.Drawing.Image]::FromFile($out)
  $sample = New-Object 'System.Collections.Generic.HashSet[string]'
  for ($sx = 0; $sx -lt $image.Width; $sx += [Math]::Max(1, [int]($image.Width / 32))) {
    for ($sy = 0; $sy -lt $image.Height; $sy += [Math]::Max(1, [int]($image.Height / 18))) {
      [void]$sample.Add(([System.Drawing.Bitmap]$image).GetPixel($sx, $sy).ToArgb().ToString())
    }
  }
  $nativeResult = [pscustomobject]@{ file = $out; width = $image.Width; height = $image.Height; title = $p.MainWindowTitle; pid = $p.Id; nativeFile = $shot.FullName; mode = 'native'; uniqueSampleColors = $sample.Count; visuallyNonBlank = ($sample.Count -ge 8) }
  $image.Dispose()
  $nativeResult | ConvertTo-Json
  [McCliWindowShot]::SetWindowPos($p.MainWindowHandle, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
  exit 0
}
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, [System.Drawing.Size]::new($w, $h))
$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$sample = New-Object 'System.Collections.Generic.HashSet[string]'
for ($sx = 0; $sx -lt $bmp.Width; $sx += [Math]::Max(1, [int]($bmp.Width / 32))) {
  for ($sy = 0; $sy -lt $bmp.Height; $sy += [Math]::Max(1, [int]($bmp.Height / 18))) {
    [void]$sample.Add($bmp.GetPixel($sx, $sy).ToArgb().ToString())
  }
}
$bmp.Dispose()
[McCliWindowShot]::SetWindowPos($p.MainWindowHandle, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
[pscustomobject]@{ file = $out; width = $w; height = $h; title = $p.MainWindowTitle; pid = $p.Id; mode = 'window'; uniqueSampleColors = $sample.Count; visuallyNonBlank = ($sample.Count -ge 8) } | ConvertTo-Json
`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        cwd: workspace,
        encoding: "utf8",
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new MinecraftCliError("SCREENSHOT_FAILED", result.stderr.trim() || result.stdout.trim() || "Screenshot capture failed.", 500);
      }
      const capture = JSON.parse(result.stdout.trim());
      const metadata = {
        session: name,
        capturedAt: new Date().toISOString(),
        label,
        screenshot: capture,
        trigger,
        expectation,
        performance: {
          durationMs: Date.now() - startedAt,
          screenshotBytes: fs.statSync(file).size
        },
        state: options.saveState ? state : undefined
      };
      if (capture.visuallyNonBlank === false) {
        throw new MinecraftCliError("SCREENSHOT_BLANK", "Screenshot pixel validation detected a blank image.", 500, capture);
      }
      writeJsonFile(metadataFile, metadata);
      if (options.saveState) {
        writeJsonFile(path.join(dirs.json, `${timestamp}-${label}.state.json`), state);
      }
      printResponse({ ok: true, data: { ...metadata, metadataFile } }, { json: program.opts().json });
    })
  );

const visual = program.command("visual").description("Control a dedicated rendered Minecraft client in the background.");

visual
  .command("prune")
  .description("Remove unused placeholder slots created by older minecraft-cli versions.")
  .option("--multimc <path>", "MultiMC root", defaultMultiMcRoot())
  .action((options) => run(async () => {
    const multiMcRoot = path.resolve(options.multimc);
    await withVisualAllocationLock(multiMcRoot, 30_000, async () => {
      const launcher = path.join(multiMcRoot, "MultiMC.exe");
      if (!fs.existsSync(launcher)) throw new MinecraftCliError("MULTIMC_NOT_FOUND", `MultiMC was not found at ${launcher}.`, 404);
      const result = pruneLegacyVisualPlaceholders(multiMcRoot);
      const groupChanged = ensureManagedVisualGroup(multiMcRoot);
      const refreshedLauncherPids = result.removed.length > 0 || groupChanged
        ? stopMultiMcLauncherForRefresh(launcher)
        : [];
      if (refreshedLauncherPids.length > 0) startMultiMcLauncher(launcher);
      printResponse({ ok: true, data: { ...result, groupChanged, refreshedLauncherPids } }, { json: program.opts().json });
    });
  }));

visual
  .command("prepare")
  .argument("<name>")
  .option("--version <version>", "Minecraft version", "1.21.4")
  .option("--multimc <path>", "MultiMC root", defaultMultiMcRoot())
  .option("--width <pixels>", "framebuffer/window width", (value) => Number(value), 960)
  .option("--height <pixels>", "framebuffer/window height", (value) => Number(value), 540)
  .option("--gui-scale <scale>", "GUI scale 0 (auto) to 4", (value) => Number(value), 0)
  .option("--fov <degrees>", "field of view from 30 to 110", (value) => Number(value), 70)
  .option("--resource-pack <zip>", "session-only resource pack ZIP")
  .option("--pack-uuid <id>", "stable resource pack identifier")
  .action((name: string, options) => run(async () => {
    const workspace = getWorkspace();
    const multiMcRoot = path.resolve(options.multimc);
    const displaySettings = normalizeVisualDisplaySettings(options);
    if (options.packUuid && !options.resourcePack) throw new MinecraftCliError("VISUAL_RESOURCE_PACK_INVALID", "--pack-uuid requires --resource-pack.", 400);
    await withVisualAllocationLock(multiMcRoot, 60_000, async () => {
      const instanceId = selectAvailableVisualInstanceId(options.version);
      const port = await getFreePort();
      const token = crypto.randomBytes(32).toString("hex");
      const prepared = await prepareVisualInstance(workspace, name, options.version, multiMcRoot, instanceId, port, token, displaySettings, undefined,
        options.resourcePack ? { file: options.resourcePack, uuid: options.packUuid } : undefined);
      const groupChanged = ensureManagedVisualGroup(multiMcRoot);
      const refreshedLauncherPids = prepared.createdInstance || groupChanged
        ? stopMultiMcLauncherForRefresh(prepared.launcher)
        : [];
      if (refreshedLauncherPids.length > 0) startMultiMcLauncher(prepared.launcher);
      const runtime = { name, version: options.version, port, token, ...prepared, preparedAt: new Date().toISOString() };
      writeJsonFile(visualRuntimeFile(workspace, name), runtime);
      printResponse({ ok: true, data: { ...runtime, instanceGroup: VISUAL_INSTANCE_GROUP, groupChanged, refreshedLauncherPids, token: "[stored]" } }, { json: program.opts().json });
    });
  }));

visual
  .command("launch")
  .argument("<name>")
  .requiredOption("--host <host>")
  .requiredOption("--port <port>", "server port", (value) => Number(value))
  .option("--auth <mode>", "offline or microsoft", "offline")
  .option("--profile <profile>", "optional MultiMC profile override")
  .option("--username <username>", "offline username", "MinecraftCliVisual")
  .option("--version <version>", "Minecraft version", "1.21.4")
  .option("--multimc <path>", "MultiMC root", defaultMultiMcRoot())
  .option("--width <pixels>", "framebuffer/window width", (value) => Number(value), 960)
  .option("--height <pixels>", "framebuffer/window height", (value) => Number(value), 540)
  .option("--gui-scale <scale>", "GUI scale 0 (auto) to 4", (value) => Number(value), 0)
  .option("--fov <degrees>", "field of view from 30 to 110", (value) => Number(value), 70)
  .option("--resource-pack <zip>", "session-only resource pack ZIP")
  .option("--pack-uuid <id>", "stable resource pack identifier")
  .option("--timeout <ms>", "launch timeout", (value) => Number(value), 120_000)
  .action((name: string, options) => run(async () => {
    const workspace = getWorkspace();
    const multiMcRoot = path.resolve(options.multimc);
    const authMode = normalizeAuthMode(options.auth);
    const displaySettings = normalizeVisualDisplaySettings(options);
    if (options.packUuid && !options.resourcePack) throw new MinecraftCliError("VISUAL_RESOURCE_PACK_INVALID", "--pack-uuid requires --resource-pack.", 400);
    const microsoftProfile = authMode === "microsoft"
      ? multiMcMicrosoftProfile(multiMcRoot, options.profile)
      : undefined;
    await withVisualAllocationLock(multiMcRoot, options.timeout + 60_000, async () => {
      const instanceId = await selectVisualInstanceId(workspace, name, options.version);
      const controlPort = await getFreePort();
      const token = crypto.randomBytes(32).toString("hex");
      const prepared = await prepareVisualInstance(workspace, name, options.version, multiMcRoot, instanceId, controlPort, token, displaySettings,
        { host: options.host, port: options.port }, options.resourcePack ? { file: options.resourcePack, uuid: options.packUuid } : undefined);
      const groupChanged = ensureManagedVisualGroup(multiMcRoot);
      if (prepared.createdInstance || groupChanged) {
        stopMultiMcLauncherForRefresh(prepared.launcher);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const runtime: any = { name, version: options.version, port: controlPort, token, ...prepared, auth: authMode,
        ...(authMode === "microsoft" ? { profile: microsoftProfile } : { username: options.username }),
        server: { host: options.host, port: options.port }, launchedAt: new Date().toISOString() };
      writeJsonFile(visualRuntimeFile(workspace, name), runtime);
      stopDedicatedVisualInstance(prepared.instanceId);
      const launchArgs = authMode === "microsoft"
        ? ["--launch", prepared.instanceId, "--profile", microsoftProfile!]
        : ["--launch", prepared.instanceId, "--offline", "--name", options.username];
      const child = spawn(prepared.launcher, launchArgs, {
        cwd: path.dirname(prepared.launcher), detached: true, stdio: "ignore", windowsHide: true
      });
      child.unref();
      try {
        const health: any = await waitForVisual(runtime, options.timeout);
        if (Number(health.controlProtocol) !== VISUAL_CONTROL_PROTOCOL) {
          throw new MinecraftCliError("VISUAL_CONTROL_ADAPTER_STALE", "The launched client did not load the current control adapter.", 409,
            { expectedProtocol: VISUAL_CONTROL_PROTOCOL, actualProtocol: health.controlProtocol ?? null, adapter: prepared.adapter, sourceJar: prepared.sourceJar });
        }
        await waitForVisualConnection(runtime, options.timeout);
        const stoppedDuplicatePids = stopDuplicateVisualInstanceProcesses(prepared.instanceId, controlPort);
        const screenDeadline = Date.now() + Math.min(options.timeout, 15_000);
        let state: any;
        let stableGameReads = 0;
        while (Date.now() < screenDeadline) {
          state = await visualRequest(runtime, "/state");
          if (state.screen === "game") {
            stableGameReads++;
            if (stableGameReads >= 2) break;
          } else {
            stableGameReads = 0;
            await visualRequest(runtime, "/screen/close");
          }
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        if (state?.screen !== "game" || stableGameReads < 2) throw new MinecraftCliError("VISUAL_SCREEN_NOT_READY", "Visual client did not reach a stable playable screen.", 500, { state });
        const resourcePack = prepared.resourcePack ? {
          ...prepared.resourcePack,
          status: Array.isArray(state?.resourcePacks?.selected) && state.resourcePacks.selected.includes(prepared.resourcePack.packId) ? "active" : "not_active"
        } : undefined;
        printResponse({ ok: true, data: { session: name, instance: prepared.instanceId, state, stoppedDuplicatePids,
          requestedDisplay: displaySettings, ...(resourcePack ? { resourcePack } : {}) } }, { json: program.opts().json });
      } catch (error) {
        stopDedicatedVisualInstance(prepared.instanceId);
        restoreVisualEnvironment(workspace, name);
        throw error;
      }
    });
  }));

visual.command("stop").argument("<name>").action((name: string) => run(async () => {
  const runtime = readVisualRuntime(getWorkspace(), name);
  await withVisualAllocationLock(runtime.instanceRoot ? path.dirname(path.dirname(runtime.instanceRoot)) : defaultMultiMcRoot(), 30_000, async () => {
    const stoppedPids = stopDedicatedVisualInstance(runtime.instanceId);
    const restore = restoreVisualEnvironment(getWorkspace(), name);
    writeJsonFile(visualRuntimeFile(getWorkspace(), name), {
      ...runtime,
      token: "",
      stoppedAt: new Date().toISOString()
    });
    printResponse({ ok: true, data: { session: name, instance: runtime.instanceId, stoppedPids, restore } }, { json: program.opts().json });
  });
}));

function readVisualRuntimeIfExists(workspace: string, name: string) {
  const file = visualRuntimeFile(workspace, name);
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return undefined; }
}

function readVisualRuntime(workspace: string, name: string) {
  const runtime = readVisualRuntimeIfExists(workspace, name);
  if (!runtime) throw new MinecraftCliError("VISUAL_SESSION_NOT_FOUND", `Visual session '${name}' is not prepared.`, 404);
  return runtime;
}

visual.command("state").argument("<name>").action((name: string) => run(async () => {
  const runtime = readVisualRuntime(getWorkspace(), name);
  const state = await visualRequest(runtime, "/state");
  const resourcePack = runtime.resourcePack ? {
    uuid: runtime.resourcePack.uuid,
    sha256: runtime.resourcePack.sha256,
    packId: runtime.resourcePack.packId,
    status: Array.isArray(state?.resourcePacks?.selected) && state.resourcePacks.selected.includes(runtime.resourcePack.packId) ? "active" : "not_active"
  } : undefined;
  printResponse({ ok: true, data: { ...state, requestedDisplay: runtime.displaySettings, ...(resourcePack ? { managedResourcePack: resourcePack } : {}) } }, { json: program.opts().json });
}));

visual.command("rotate").description("Rotate the player without using the system mouse.")
  .argument("<name>")
  .requiredOption("--yaw <degrees>", "absolute or relative yaw", (value) => Number(value))
  .requiredOption("--pitch <degrees>", "absolute or relative pitch", (value) => Number(value))
  .option("--relative", "apply yaw/pitch as deltas", false)
  .action((name: string, options) => run(async () => {
    if (!Number.isFinite(options.yaw) || !Number.isFinite(options.pitch)) throw new MinecraftCliError("VISUAL_ROTATION_INVALID", "Yaw and pitch must be finite numbers.", 400);
    const runtime = readVisualRuntime(getWorkspace(), name);
    await requireVisualCapability(runtime, "rotation");
    const query = new URLSearchParams({ yaw: String(options.yaw), pitch: String(options.pitch), relative: String(Boolean(options.relative)) });
    const state = await visualRequest(runtime, `/world/rotate?${query}`);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("perspective").description("Set first-person or third-person camera perspective.")
  .argument("<name>")
  .requiredOption("--mode <mode>", "first, third-back, or third-front")
  .action((name: string, options) => run(async () => {
    if (!["first", "third-back", "third-front"].includes(options.mode)) throw new MinecraftCliError("VISUAL_PERSPECTIVE_INVALID", "Perspective must be first, third-back, or third-front.", 400);
    const runtime = readVisualRuntime(getWorkspace(), name);
    await requireVisualCapability(runtime, "perspective");
    const state = await visualRequest(runtime, `/world/perspective?mode=${encodeURIComponent(options.mode)}`);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("close-screen").argument("<name>").action((name: string) => run(async () => {
  const state = await visualRequest(readVisualRuntime(getWorkspace(), name), "/screen/close");
  printResponse({ ok: true, data: state }, { json: program.opts().json });
}));

visual.command("open-chat").argument("<name>").action((name: string) => run(async () => {
  const state = await visualRequest(readVisualRuntime(getWorkspace(), name), "/screen/chat");
  printResponse({ ok: true, data: state }, { json: program.opts().json });
}));

visual.command("click-slot").argument("<name>").requiredOption("--slot <slot>", "container slot", (value) => Number(value)).action((name: string, options) => run(async () => {
  const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/click-slot?slot=${encodeURIComponent(options.slot)}`);
  printResponse({ ok: true, data: state }, { json: program.opts().json });
}));

visual.command("hover-slot").argument("<name>").requiredOption("--slot <slot>", "container slot", (value) => Number(value)).action((name: string, options) => run(async () => {
  const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/hover-slot?slot=${encodeURIComponent(options.slot)}`);
  printResponse({ ok: true, data: state }, { json: program.opts().json });
}));

visual.command("hover-chat").argument("<name>").option("--line <line>", "chat line counted upward from the input", (value) => Number(value), 0).action((name: string, options) => run(async () => {
  const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/hover-chat?line=${encodeURIComponent(options.line)}`);
  printResponse({ ok: true, data: state }, { json: program.opts().json });
}));

visual.command("click-hover").argument("<name>").action((name: string) => run(async () => {
  const state = await visualRequest(readVisualRuntime(getWorkspace(), name), "/screen/click");
  printResponse({ ok: true, data: state }, { json: program.opts().json });
}));

visual.command("move-cursor").argument("<name>")
  .requiredOption("--x <x>", "GUI-scaled x coordinate", (value) => Number(value))
  .requiredOption("--y <y>", "GUI-scaled y coordinate", (value) => Number(value))
  .action((name: string, options) => run(async () => {
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/move-cursor?x=${encodeURIComponent(options.x)}&y=${encodeURIComponent(options.y)}`);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("click").argument("<name>")
  .requiredOption("--x <x>", "GUI-scaled x coordinate", (value) => Number(value))
  .requiredOption("--y <y>", "GUI-scaled y coordinate", (value) => Number(value))
  .option("--button <button>", "0 left, 1 right, 2 middle", (value) => Number(value), 0)
  .action((name: string, options) => run(async () => {
    const route = `/screen/click-at?x=${encodeURIComponent(options.x)}&y=${encodeURIComponent(options.y)}&button=${encodeURIComponent(options.button)}`;
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), route);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("elements").description("List visible Minecraft screen widgets with text and GUI-scaled bounds.")
  .argument("<name>")
  .action((name: string) => run(async () => {
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), "/screen/elements");
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("actions").description("List active screen buttons with stable action ids and indexes.")
  .argument("<name>")
  .action((name: string) => run(async () => {
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), "/screen/actions");
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("click-action").description("Click a screen or native Dialog button by action id or button index.")
  .argument("<name>")
  .option("--action-id <id>", "action id returned by visual actions")
  .option("--index <index>", "zero-based active button index", (value) => Number(value))
  .action((name: string, options) => run(async () => {
    if (!options.actionId && (!Number.isInteger(options.index) || options.index < 0)) throw new MinecraftCliError("VISUAL_ACTION_REQUIRED", "Provide --action-id or a non-negative --index.", 400);
    const query = new URLSearchParams();
    if (options.actionId) query.set("actionId", options.actionId);
    if (options.index !== undefined) query.set("index", String(options.index));
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/click-action?${query}`);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("entities").description("List entities visible to the rendered client.")
  .argument("<name>")
  .action((name: string) => run(async () => {
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), "/world/entities");
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("text-displays").description("Snapshot TextDisplay labels with projected pixel bounds.")
  .argument("<name>")
  .option("--text <text>", "plain-text substring filter")
  .action((name: string, options) => run(async () => {
    const runtime = readVisualRuntime(getWorkspace(), name);
    await requireVisualCapability(runtime, "textDisplayProjection");
    const snapshot = parseVisualEntitySnapshot(await visualRequest(runtime, "/world/entities"));
    const needle = options.text ? String(options.text).toLowerCase() : undefined;
    const textDisplays = snapshot.entities.filter(entity => entity.textDisplay && (!needle || entity.textDisplay.text.toLowerCase().includes(needle)));
    printResponse({ ok: true, data: { snapshotId: snapshot.snapshotId, count: textDisplays.length, textDisplays } }, { json: program.opts().json, compactJson: true });
  }));

visual.command("interact-role").description("Right-click the nearest rendered entity matching visible role text.")
  .argument("<name>")
  .requiredOption("--role <text>", "custom name, display name, type, or entity tag")
  .option("--index <index>", "zero-based role match index", (value) => Number(value), 0)
  .option("--max-distance <blocks>", "maximum client-side distance", (value) => Number(value), 8)
  .action((name: string, options) => run(async () => {
    if (!Number.isInteger(options.index) || options.index < 0 || !Number.isFinite(options.maxDistance) || options.maxDistance <= 0 || options.maxDistance > 128) throw new MinecraftCliError("VISUAL_ENTITY_SELECTOR_INVALID", "Role index or max distance is invalid.", 400);
    const query = new URLSearchParams({ role: options.role, index: String(options.index), maxDistance: String(options.maxDistance) });
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/world/interact-role?${query}`);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("interact-entity").description("Right-click an entity selected from a fresh rendered-entity snapshot without moving the system mouse.")
  .argument("<name>")
  .option("--entity-id <id>", "exact entity id from the latest visual entities view", (value) => Number(value))
  .option("--nearest-type <type>", "select a rendered entity type such as player or minecraft:player")
  .option("--index <index>", "zero-based distance-sorted type match", (value) => Number(value), 0)
  .option("--max-distance <blocks>", "maximum current client-side distance", (value) => Number(value), 8)
  .action((name: string, options) => run(async () => {
    const hasEntityId = options.entityId !== undefined;
    const hasNearestType = typeof options.nearestType === "string" && options.nearestType.trim().length > 0;
    if (hasEntityId === hasNearestType) {
      throw new MinecraftCliError("VISUAL_ENTITY_SELECTOR_INVALID", "Provide exactly one of --entity-id or --nearest-type.", 400);
    }
    if ((hasEntityId && (!Number.isInteger(options.entityId) || options.entityId < 0))
      || !Number.isInteger(options.index) || options.index < 0
      || !Number.isFinite(options.maxDistance) || options.maxDistance <= 0 || options.maxDistance > 128) {
      throw new MinecraftCliError("VISUAL_ENTITY_SELECTOR_INVALID", "Entity id, type index, or max distance is invalid.", 400);
    }

    const runtime = readVisualRuntime(getWorkspace(), name);
    const snapshot = parseVisualEntitySnapshot(await visualRequest(runtime, "/world/entities"));
    let selected: VisualEntitySummary;
    let selector: Record<string, unknown>;
    if (hasEntityId) {
      const match = snapshot.entities.find(entity => entity.id === options.entityId);
      if (!match) {
        throw new MinecraftCliError("VISUAL_ENTITY_NOT_IN_SNAPSHOT", `Entity id ${options.entityId} was not present in the freshly captured snapshot.`, 404, { snapshotId: snapshot.snapshotId });
      }
      selected = match;
      selector = { entityId: options.entityId };
    } else {
      const requestedType = normalizeVisualEntityType(options.nearestType);
      const matches = snapshot.entities
        .filter(entity => normalizeVisualEntityType(entity.type) === requestedType)
        .sort((left, right) => left.distance - right.distance || left.id - right.id);
      if (options.index >= matches.length) {
        throw new MinecraftCliError("VISUAL_ENTITY_TYPE_NOT_FOUND", `No rendered ${options.nearestType} entity exists at index ${options.index}.`, 404, { snapshotId: snapshot.snapshotId, matches: matches.length });
      }
      selected = matches[options.index];
      selector = { nearestType: options.nearestType, index: options.index };
    }
    if (selected.distance > options.maxDistance) {
      throw new MinecraftCliError("VISUAL_ENTITY_OUT_OF_RANGE", `Entity ${selected.id} is ${selected.distance.toFixed(2)} blocks away, beyond max distance ${options.maxDistance}.`, 409, { snapshotId: snapshot.snapshotId, entity: selected });
    }

    const query = new URLSearchParams({
      snapshotId: String(snapshot.snapshotId),
      entityId: String(selected.id),
      expectedType: selected.type,
      maxDistance: String(options.maxDistance)
    });
    const result = await visualRequest(runtime, `/world/interact-entity?${query}`);
    printResponse({ ok: true, data: { session: name, snapshotId: snapshot.snapshotId, selector, entity: selected, result } }, { json: program.opts().json });
  }));

for (const target of [
  { command: "click-element", route: "click-element", description: "Click an active visible screen widget by its displayed text." },
  { command: "hover-element", route: "hover-element", description: "Move the virtual cursor over an active visible screen widget by its displayed text." }
]) {
  visual.command(target.command).description(target.description)
    .argument("<name>")
    .argument("<text...>")
    .option("--index <index>", "zero-based match index", (value) => Number(value), 0)
    .option("--exact", "require the complete displayed text", false)
    .action((name: string, text: string[], options) => run(async () => {
      if (!Number.isInteger(options.index) || options.index < 0) throw new MinecraftCliError("VISUAL_ELEMENT_INDEX_INVALID", "Index must be a non-negative integer.", 400);
      const query = new URLSearchParams({ text: text.join(" "), index: String(options.index) });
      if (options.exact) query.set("exact", "true");
      const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/${target.route}?${query.toString()}`);
      printResponse({ ok: true, data: state }, { json: program.opts().json });
    }));
}

visual.command("type-text").description("Type text into the focused in-game screen control without using the system keyboard.")
  .argument("<name>")
  .argument("<text...>")
  .action((name: string, text: string[]) => run(async () => {
    const value = text.join(" ");
    if (value.length > 4096) throw new MinecraftCliError("VISUAL_TEXT_TOO_LONG", "Text must be at most 4096 characters.", 400);
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/type?text=${encodeURIComponent(value)}`);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("press-key").description("Press a navigation or editing key in the current in-game screen.")
  .argument("<name>")
  .argument("<key>", "enter, tab, backspace, delete, escape, arrows, home, end, page-up, page-down, or space")
  .option("--modifiers <mask>", "GLFW modifier mask: shift 1, control 2, alt 4", (value) => Number(value), 0)
  .action((name: string, key: string, options) => run(async () => {
    if (!Number.isInteger(options.modifiers) || options.modifiers < 0 || options.modifiers > 7) {
      throw new MinecraftCliError("VISUAL_MODIFIERS_INVALID", "Modifiers must be an integer from 0 to 7.", 400);
    }
    const route = `/screen/key?key=${encodeURIComponent(key)}&modifiers=${encodeURIComponent(options.modifiers)}`;
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), route);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

visual.command("scroll").description("Scroll the current in-game screen at the virtual cursor or screen center.")
  .argument("<name>")
  .requiredOption("--delta <delta>", "vertical scroll amount from -100 to 100", (value) => Number(value))
  .action((name: string, options) => run(async () => {
    if (!Number.isFinite(options.delta) || options.delta === 0 || Math.abs(options.delta) > 100) {
      throw new MinecraftCliError("VISUAL_SCROLL_INVALID", "Delta must be between -100 and 100 and not zero.", 400);
    }
    const state = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/scroll?delta=${encodeURIComponent(options.delta)}`);
    printResponse({ ok: true, data: state }, { json: program.opts().json });
  }));

function visualInterestRegions(kind: string, state: any, elements: any, width: number, height: number): ImageRegion[] {
  const scaleX = width / Math.max(1, Number(state?.guiWidth ?? width));
  const scaleY = height / Math.max(1, Number(state?.guiHeight ?? height));
  const cursorX = Number(state?.virtualCursor?.x ?? width / 2);
  const cursorY = Number(state?.virtualCursor?.y ?? height / 2);
  const widgets = Array.isArray(elements?.elements) ? elements.elements.filter((element: any) => element.visible !== false && element.width > 0 && element.height >= 0) : [];
  const widgetRegion: ImageRegion = widgets.length > 0 ? {
    x: Math.min(...widgets.map((element: any) => element.x)) * scaleX - 24,
    y: Math.min(...widgets.map((element: any) => element.y)) * scaleY - 24,
    width: (Math.max(...widgets.map((element: any) => element.x + element.width)) - Math.min(...widgets.map((element: any) => element.x))) * scaleX + 48,
    height: (Math.max(...widgets.map((element: any) => element.y + element.height)) - Math.min(...widgets.map((element: any) => element.y))) * scaleY + 48,
    label: kind === "dialog" ? "dialog" : "gui"
  } : { x: width * 0.08, y: height * 0.05, width: width * 0.84, height: height * 0.9, label: kind === "dialog" ? "dialog" : "gui" };
  switch (kind) {
    case "gui":
    case "dialog": return [widgetRegion];
    case "tooltip": return [{ x: cursorX - 80, y: cursorY - 180, width: Math.min(440, width), height: Math.min(300, height), label: "tooltip" }];
    case "chat": return [{ x: 0, y: height * 0.42, width: width * 0.72, height: height * 0.58, label: "chat" }];
    case "hud": return [
      { x: 0, y: 0, width, height: height * 0.3, label: "hud-top" },
      { x: width * 0.2, y: height * 0.25, width: width * 0.6, height: height * 0.5, label: "hud-center" },
      { x: width * 0.68, y: 0, width: width * 0.32, height: height * 0.8, label: "hud-right" },
      { x: width * 0.18, y: height * 0.68, width: width * 0.64, height: height * 0.32, label: "hud-bottom" }
    ];
    case "full": return [{ x: 0, y: 0, width, height, label: "full" }];
    case "auto": return state?.screen && state.screen !== "game" ? [widgetRegion] : [];
    default: throw new MinecraftCliError("VISUAL_REGION_INVALID", "Region must be auto, gui, tooltip, chat, dialog, hud, or full.", 400);
  }
}

visual.command("screenshot").argument("<name>")
  .option("--label <label>", "file label", "visual")
  .option("--region <region>", "auto, gui, tooltip, chat, dialog, hud, or full", "auto")
  .option("--crop-padding <pixels>", "changed-region padding", (value) => Number(value), 12)
  .option("--contact-sheet", "combine multiple crops into one PNG", false)
  .option("--no-compare", "skip comparison with the previous session screenshot")
  .action((name: string, options) => run(async () => {
  const workspace = getWorkspace();
  const runtime = readVisualRuntime(workspace, name);
  const dirs = ensureSessionArtifactDirs(workspace, name);
  const previousScreenshot = options.compare ? latestPng(dirs.screenshots) : undefined;
  const stamp = timestampFilePart();
  const file = path.join(dirs.screenshots, `${stamp}-${safeFilePart(options.label)}.png`);
  const startedAt = Date.now();
  if (!Number.isInteger(options.cropPadding) || options.cropPadding < 0 || options.cropPadding > 256) throw new MinecraftCliError("VISUAL_CROP_PADDING_INVALID", "Crop padding must be an integer from 0 to 256.", 400);
  const visualState: any = await visualRequest(runtime, "/state");
  let screenElements: any;
  if (visualState.screen !== "game") {
    try { screenElements = await visualRequest(runtime, "/screen/elements"); }
    catch { screenElements = undefined; }
  }
  const capture = await visualRequest(runtime, `/screenshot?path=${encodeURIComponent(file)}`, 20_000);
  const deadline = Date.now() + 10_000;
  let size = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) size = fs.statSync(file).size;
    if (size > 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (size === 0) throw new MinecraftCliError("VISUAL_SCREENSHOT_MISSING", "The client reported a screenshot but no complete file was created.", 500);
  const analysisStartedAt = Date.now();
  let imageAnalysis: unknown;
  try {
    imageAnalysis = analyzePngChange(file, previousScreenshot);
  } catch (error) {
    imageAnalysis = { error: error instanceof Error ? error.message : String(error) };
  }
  let cropAnalysis: any;
  try {
    const change: any = options.compare ? changedPngRegion(file, previousScreenshot, options.cropPadding) : { comparable: false, changed: true };
    const interest = visualInterestRegions(options.region, visualState, screenElements, Number(capture.width), Number(capture.height));
    let regions = interest;
    if (options.region === "auto" && regions.length === 0 && change.region) regions = [{ ...change.region, label: "changed" }];
    if (change.comparable && !change.changed) regions = [];
    else if (change.region && interest.length > 0) regions = interest.map(region => intersectRegions(region, change.region)).filter(Boolean) as ImageRegion[];
    const cropDir = path.join(dirs.screenshots, "crops");
    const crops = regions.map((region, index) => cropPng(file, path.join(cropDir, `${stamp}-${safeFilePart(options.label)}-${safeFilePart(region.label ?? String(index + 1))}.png`), region));
    const contactSheet = options.contactSheet && crops.length > 1
      ? createContactSheet(crops.map(crop => crop.file), path.join(cropDir, `${stamp}-${safeFilePart(options.label)}-contact-sheet.png`))
      : undefined;
    cropAnalysis = { region: options.region, change, generated: crops.length > 0, crops, ...(contactSheet ? { contactSheet } : {}) };
  } catch (error) {
    cropAnalysis = { region: options.region, generated: false, error: error instanceof Error ? error.message : String(error) };
  }
  const metadata = { session: name, capturedAt: new Date().toISOString(), mode: "in_game_framebuffer", capture, visualState, imageAnalysis, cropAnalysis,
    performance: { durationMs: Date.now() - startedAt, analysisDurationMs: Date.now() - analysisStartedAt, screenshotBytes: size } };
  const metadataFile = path.join(dirs.json, `${stamp}-${safeFilePart(options.label)}.visual.json`);
  writeJsonFile(metadataFile, metadata);
  printResponse({ ok: true, data: { ...metadata, file, metadataFile } }, { json: program.opts().json });
}));

async function actorCapabilityState(name: string) {
  const workspace = getWorkspace();
  let visualState: any;
  let visualReason = "not_prepared";
  const runtime = readVisualRuntimeIfExists(workspace, name);
  if (runtime?.token) {
    try {
      visualState = await visualRequest(runtime, "/state", 2000);
      visualReason = visualState.connected ? "available" : "not_connected";
    } catch (error) {
      visualReason = error instanceof Error ? error.message : String(error);
    }
  }
  let headlessState: any;
  let headlessReason = "daemon_not_running";
  const daemon = readDaemonState(workspace);
  if (daemon && isProcessAlive(daemon.pid)) {
    try {
      const response: any = await requestDaemonAt(daemon.port, "GET", `/session/${encodeURIComponent(name)}/state?part=core`, undefined, 2000, daemon.token);
      if (response.ok) { headlessState = response.data; headlessReason = response.data.connected ? "available" : "not_connected"; }
      else headlessReason = response.error?.code ?? "session_unavailable";
    } catch (error) {
      headlessReason = error instanceof Error ? error.message : String(error);
    }
  }
  const visualAvailable = Boolean(visualState?.connected && visualState?.capabilities?.npcRoleInteraction);
  const headlessAvailable = Boolean(headlessState?.connected);
  return {
    name,
    transports: {
      visual: { available: visualAvailable, reason: visualReason, version: runtime?.version, screen: visualState?.screen, capabilities: visualState?.capabilities ?? {} },
      headless: { available: headlessAvailable, reason: headlessReason, version: headlessState?.server?.version }
    },
    capabilities: {
      npcRoleInteraction: visualAvailable ? { available: true, transport: "visual" } : headlessAvailable ? { available: true, transport: "headless" } : { available: false, reason: "no_connected_transport" },
      directEntityInteraction: visualState?.connected && visualState?.capabilities?.directEntityInteraction ? { available: true, transport: "visual" } : { available: false, reason: "visual_transport_required" },
      screenActions: visualState?.connected && visualState?.capabilities?.screenActions ? { available: true, transport: "visual" } : { available: false, reason: "visual_transport_required" },
      nativeDialog: visualState?.connected && visualState?.capabilities?.nativeDialog ? { available: true, transport: "visual" } : { available: false, reason: runtime?.version === "1.21.11" ? "visual_transport_unavailable" : "requires_visual_1.21.11" },
      framebuffer: visualState?.connected && visualState?.capabilities?.framebuffer ? { available: true, transport: "visual" } : { available: false, reason: "visual_transport_required" },
      textDisplayTargeting: visualState?.connected && visualState?.capabilities?.textDisplayProjection ? { available: true, transport: "visual" } : { available: false, reason: visualReason === "available" ? "adapter_does_not_support_text_display_projection" : visualReason },
      perspective: visualState?.connected && visualState?.capabilities?.perspective ? { available: true, transport: "visual" } : { available: false, reason: visualReason }
    }
  };
}

const actor = program.command("actor").description("Use one capability-aware role across headless and rendered transports.");

actor.command("capabilities").argument("<name>").action((name: string) => run(async () => {
  printResponse({ ok: true, data: await actorCapabilityState(name) }, { json: program.opts().json, compactJson: true });
}));

actor.command("interact-role").description("Right-click a role using visual transport first, then headless fallback.")
  .argument("<name>")
  .requiredOption("--role <text>")
  .option("--index <index>", "zero-based role match", (value) => Number(value), 0)
  .option("--max-distance <blocks>", "maximum distance", (value) => Number(value), 8)
  .action((name: string, options) => run(async () => {
    const capabilities: any = await actorCapabilityState(name);
    const selected = capabilities.capabilities.npcRoleInteraction;
    if (!selected.available) throw new MinecraftCliError("ACTOR_CAPABILITY_UNAVAILABLE", "No connected transport can interact with an NPC role.", 409, capabilities);
    if (selected.transport === "visual") {
      const runtime = readVisualRuntime(getWorkspace(), name);
      const query = new URLSearchParams({ role: options.role, index: String(options.index), maxDistance: String(options.maxDistance) });
      const result = await visualRequest(runtime, `/world/interact-role?${query}`);
      printResponse({ ok: true, data: { actor: name, transport: "visual", result } }, { json: program.opts().json, compactJson: true });
      return;
    }
    const result = await requestDaemonForCli("POST", `/session/${encodeURIComponent(name)}/interact`, { role: options.role, nearest: true, maxDistance: options.maxDistance, method: "at" });
    printResponse({ ok: true, data: { actor: name, transport: "headless", result } }, { json: program.opts().json, compactJson: true });
  }));

actor.command("actions").description("List actionable buttons on the rendered actor's current screen.")
  .argument("<name>")
  .action((name: string) => run(async () => {
    const capabilities: any = await actorCapabilityState(name);
    if (!capabilities.capabilities.screenActions.available) throw new MinecraftCliError("ACTOR_CAPABILITY_UNAVAILABLE", "Screen actions require a connected visual actor.", 409, capabilities);
    const result = await visualRequest(readVisualRuntime(getWorkspace(), name), "/screen/actions");
    printResponse({ ok: true, data: { actor: name, transport: "visual", nativeDialog: capabilities.capabilities.nativeDialog.available, result } }, { json: program.opts().json, compactJson: true });
  }));

actor.command("click-action").description("Click a rendered screen or native Dialog button by action id or index.")
  .argument("<name>")
  .option("--action-id <id>")
  .option("--index <index>", "zero-based active button index", (value) => Number(value))
  .action((name: string, options) => run(async () => {
    const capabilities: any = await actorCapabilityState(name);
    if (!capabilities.capabilities.screenActions.available) throw new MinecraftCliError("ACTOR_CAPABILITY_UNAVAILABLE", "Dialog and screen actions require a connected visual actor.", 409, capabilities);
    if (!options.actionId && (!Number.isInteger(options.index) || options.index < 0)) throw new MinecraftCliError("ACTOR_ACTION_REQUIRED", "Provide --action-id or a non-negative --index.", 400);
    const query = new URLSearchParams();
    if (options.actionId) query.set("actionId", options.actionId);
    if (options.index !== undefined) query.set("index", String(options.index));
    const result = await visualRequest(readVisualRuntime(getWorkspace(), name), `/screen/click-action?${query}`);
    printResponse({ ok: true, data: { actor: name, transport: "visual", nativeDialog: capabilities.capabilities.nativeDialog.available, result } }, { json: program.opts().json, compactJson: true });
  }));

actor.command("aim-text").description("Aim at a visible TextDisplay by plain text and optionally right-click.")
  .argument("<name>")
  .requiredOption("--text <text>", "plain TextDisplay text or substring")
  .option("--index <index>", "zero-based nearest matching label", (value) => Number(value), 0)
  .option("--max-angular-miss <degrees>", "maximum angular correction", (value) => Number(value), 180)
  .option("--min-pixel-height <pixels>", "minimum projected label height", (value) => Number(value), 0)
  .option("--max-pixel-height <pixels>", "maximum projected label height", (value) => Number(value), 100000)
  .option("--click", "right-click after aiming", false)
  .option("--expect-dialog", "wait for a screen/dialog after clicking", false)
  .action((name: string, options) => run(async () => {
    if (!Number.isInteger(options.index) || options.index < 0 || !Number.isFinite(options.maxAngularMiss) || options.maxAngularMiss < 0 || options.maxAngularMiss > 180
      || !Number.isFinite(options.minPixelHeight) || !Number.isFinite(options.maxPixelHeight) || options.minPixelHeight < 0 || options.maxPixelHeight < options.minPixelHeight) {
      throw new MinecraftCliError("TEXT_DISPLAY_SELECTOR_INVALID", "TextDisplay index, angular miss, or pixel bounds are invalid.", 400);
    }
    const capabilities: any = await actorCapabilityState(name);
    if (!capabilities.capabilities.textDisplayTargeting.available) throw new MinecraftCliError("ACTOR_CAPABILITY_UNAVAILABLE", "TextDisplay targeting requires a compatible connected visual actor.", 409, capabilities);
    const runtime = readVisualRuntime(getWorkspace(), name);
    const query = new URLSearchParams({ text: options.text, index: String(options.index), maxAngularMiss: String(options.maxAngularMiss),
      minPixelHeight: String(options.minPixelHeight), maxPixelHeight: String(options.maxPixelHeight) });
    const result = await visualRequest(runtime, `/world/aim-text?${query}`);
    const clicked = Boolean(options.click || options.expectDialog);
    let clickResult: any;
    if (clicked) {
      await new Promise(resolve => setTimeout(resolve, 100));
      clickResult = await visualRequest(runtime, "/world/use-item");
    }
    let dialogOpened = false;
    let finalState: any = result;
    if (options.expectDialog) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        finalState = await visualRequest(runtime, "/state");
        if (finalState.screen !== "game") { dialogOpened = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!dialogOpened) throw new MinecraftCliError("TEXT_DISPLAY_DIALOG_NOT_OPENED", "TextDisplay selection did not open a screen within 5 seconds.", 409, { result, finalState });
    }
    printResponse({ ok: true, data: { actor: name, transport: "visual", result, clicked, ...(clickResult ? { clickResult } : {}), dialogOpened, finalState } }, { json: program.opts().json, compactJson: true });
  }));

async function captureVisualFrame(workspace: string, name: string, label: string) {
  const runtime = readVisualRuntime(workspace, name);
  const dirs = ensureSessionArtifactDirs(workspace, name);
  const file = path.join(dirs.screenshots, `${timestampFilePart()}-${safeFilePart(label)}.png`);
  const requestedAtMs = Date.now();
  const capture = await visualRequest(runtime, `/screenshot?path=${encodeURIComponent(file)}`, 20_000);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new MinecraftCliError("VISUAL_SCREENSHOT_MISSING", `Visual frame for '${name}' was not created.`, 500);
  return { session: name, file, requestedAtMs, capture, state: await visualRequest(runtime, "/state") };
}

actor.command("capture-pair").description("Capture the same moment from Microsoft-authenticated actor and observer visual sessions.")
  .argument("<actorName>")
  .requiredOption("--observer <name>", "second Microsoft visual session")
  .option("--label <label>", "capture label", "motion")
  .option("--actor-perspective <mode>", "first, third-back, or third-front", "first")
  .option("--observer-perspective <mode>", "first, third-back, or third-front", "third-back")
  .action((actorName: string, options) => run(async () => {
    if (actorName === options.observer) throw new MinecraftCliError("ACTOR_PAIR_INVALID", "Actor and observer must be different visual sessions.", 400);
    for (const mode of [options.actorPerspective, options.observerPerspective]) {
      if (!["first", "third-back", "third-front"].includes(mode)) throw new MinecraftCliError("VISUAL_PERSPECTIVE_INVALID", "Pair perspectives must be first, third-back, or third-front.", 400);
    }
    const workspace = getWorkspace();
    const actorRuntime = readVisualRuntimeIfExists(workspace, actorName);
    const observerRuntime = readVisualRuntimeIfExists(workspace, options.observer);
    if (actorRuntime?.auth !== "microsoft" || observerRuntime?.auth !== "microsoft") {
      throw new MinecraftCliError("ACTOR_CAPABILITY_UNAVAILABLE", "Dual actor/observer capture requires two distinct Microsoft-authenticated visual sessions.", 409,
        { capability: "dualVisualCapture", actor: actorRuntime?.auth ?? "unavailable", observer: observerRuntime?.auth ?? "unavailable" });
    }
    const [actorState, observerState] = await Promise.all([
      visualRequest(actorRuntime, `/world/perspective?mode=${encodeURIComponent(options.actorPerspective)}`),
      visualRequest(observerRuntime, `/world/perspective?mode=${encodeURIComponent(options.observerPerspective)}`)
    ]);
    if (!actorState.connected || !observerState.connected) throw new MinecraftCliError("ACTOR_CAPABILITY_UNAVAILABLE", "Both visual sessions must be connected before pair capture.", 409);
    const capturedAt = new Date().toISOString();
    const [actorFrame, observerFrame] = await Promise.all([
      captureVisualFrame(workspace, actorName, `${options.label}-actor`),
      captureVisualFrame(workspace, options.observer, `${options.label}-observer`)
    ]);
    const captureSkewMs = Math.abs(actorFrame.requestedAtMs - observerFrame.requestedAtMs);
    printResponse({ ok: true, data: { capability: "dualVisualCapture", capturedAt, captureSkewMs, actor: actorFrame, observer: observerFrame } }, { json: program.opts().json, compactJson: true });
  }));

program
  .command("scenario")
  .description("Run a token-efficient JSON sequence of minecraft-cli commands.")
  .argument("<file>", "scenario JSON file")
  .option("--full", "return every compact step response instead of a summary", false)
  .option("--dry-run", "validate and list steps without running them", false)
  .action((file: string, options) => run(async () => {
    const response = await executeScenario({
      file,
      workspace: getWorkspace(),
      cliFile: path.resolve(process.argv[1]),
      full: options.full,
      dryRun: options.dryRun
    });
    if (!response.ok) process.exitCode = 2;
    printResponse(response, { json: program.opts().json, compactJson: true });
  }));

const probe = program.command("probe").description("Inspect the optional localhost Paper test probe.");

function readProbeRuntime() {
  const file = path.join(getPaths(getWorkspace()).runtime, "probe.json");
  if (!fs.existsSync(file)) return { available: false as const, reason: "not_configured", file };
  let runtime: any;
  try { runtime = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { available: false as const, reason: "runtime_invalid", file }; }
  if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || typeof runtime.token !== "string") {
    return { available: false as const, reason: "runtime_invalid", file };
  }
  return { available: true as const, file, runtime };
}

async function requestProbe(method: string, route: string, body?: unknown, softUnavailable = false) {
  const configured = readProbeRuntime();
  if (!configured.available) {
    if (softUnavailable) return { available: false, reason: configured.reason, file: configured.file };
    throw new MinecraftCliError("PAPER_PROBE_UNAVAILABLE", `Paper Probe is unavailable: ${configured.reason}.`, 503, { reason: configured.reason });
  }
  const { runtime } = configured;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: runtime.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const responseBody: any = await response.json();
    if (!response.ok || !responseBody?.ok) throw new MinecraftCliError("PAPER_PROBE_REQUEST_FAILED", responseBody?.error ?? `Probe returned HTTP ${response.status}.`, 502, redactSecrets(responseBody));
    return { available: true, endpoint: `127.0.0.1:${runtime.port}`, ...redactSecrets(responseBody) as any };
  } catch (error) {
    if (softUnavailable) return { available: false, reason: "unreachable", endpoint: `127.0.0.1:${runtime.port}`, error: error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

probe.command("status").description("Report probe availability without failing when it is not installed.").action(() => run(async () => {
  const result = await requestProbe("GET", "/health", undefined, true);
  printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
}));

probe.command("events").description("Read structured probe observations after a sequence cursor.")
  .option("--after <sequence>", "only observations after this sequence", (value) => Number(value), 0)
  .option("--limit <count>", "maximum observations", (value) => Number(value), 100)
  .option("--correlation <id>", "scenario correlation id")
  .action((options) => run(async () => {
    const query = new URLSearchParams({ after: String(options.after), limit: String(options.limit) });
    if (options.correlation) query.set("correlation", options.correlation);
    const result = await requestProbe("GET", `/events?${query}`);
    printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
  }));

probe.command("correlate").description("Associate one player UUID with a scenario id.")
  .requiredOption("--player-uuid <uuid>")
  .requiredOption("--scenario <id>")
  .action((options) => run(async () => {
    const result = await requestProbe("POST", "/correlation", { playerUuid: options.playerUuid, scenarioId: options.scenario });
    printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
  }));

probe.command("command").description("Dispatch a player command and return permission and dispatch results.")
  .requiredOption("--player-uuid <uuid>")
  .requiredOption("--command <command>")
  .option("--permission <node>")
  .action((options) => run(async () => {
    const result = await requestProbe("POST", "/command", { playerUuid: options.playerUuid, command: options.command, permission: options.permission });
    printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
  }));

probe.command("snapshot").description("Capture restorable player test state in probe memory.")
  .requiredOption("--player-uuid <uuid>")
  .action((options) => run(async () => {
    const result = await requestProbe("POST", "/snapshot", { playerUuid: options.playerUuid });
    printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
  }));

probe.command("restore").description("Restore and consume one probe player snapshot.")
  .requiredOption("--snapshot <id>")
  .action((options) => run(async () => {
    const result = await requestProbe("POST", "/restore", { snapshotId: options.snapshot });
    printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
  }));

probe.command("permissions").description("Set permission attachments owned only by the test probe.")
  .requiredOption("--player-uuid <uuid>")
  .option("--allow <node>", "permission to allow; repeatable", collect, [])
  .option("--deny <node>", "permission to deny; repeatable", collect, [])
  .action((options) => run(async () => {
    const permissions = Object.fromEntries([...(options.allow ?? []).map((node: string) => [node, true]), ...(options.deny ?? []).map((node: string) => [node, false])]);
    const result = await requestProbe("POST", "/permissions", { playerUuid: options.playerUuid, permissions });
    printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
  }));

probe.command("diagnostics").description("Read TPS/MSPT only for failure diagnostics.").action(() => run(async () => {
  const result = await requestProbe("GET", "/diagnostics", undefined, true);
  printResponse({ ok: true, data: result }, { json: program.opts().json, compactJson: true });
}));

const artifacts = program.command("artifacts").description("Inspect and safely prune generated test evidence.");

artifacts.command("status").description("Show artifact file counts and sizes without starting the daemon.").action(() => run(async () => {
  printResponse({ ok: true, data: artifactStatus(getWorkspace()) }, { json: program.opts().json });
}));

artifacts.command("prune").description("Preview or remove old generated screenshots, saved JSON, and scenario reports.")
  .option("--older-than-days <days>", "only consider files older than this", (value) => Number(value), 30)
  .option("--keep-screenshots <count>", "always keep this many newest screenshots per session", (value) => Number(value), 20)
  .option("--keep-json <count>", "always keep this many newest historical JSON files per session", (value) => Number(value), 50)
  .option("--keep-runs <count>", "always keep this many newest scenario reports", (value) => Number(value), 50)
  .option("--apply", "remove candidates; without this flag only preview", false)
  .action((options) => run(async () => {
    const response = pruneArtifacts(getWorkspace(), {
      olderThanDays: options.olderThanDays,
      keepScreenshots: options.keepScreenshots,
      keepJson: options.keepJson,
      keepRuns: options.keepRuns,
      apply: options.apply
    });
    printResponse({ ok: true, data: response }, { json: program.opts().json, compactJson: true });
  }));

program
  .command("cleanup")
  .description("Disconnect sessions and stop daemon.")
  .option("--timeout <ms>", "cleanup timeout", (value) => Number(value), 45_000)
  .action((options) => run(async () => {
    const workspace = getWorkspace();
    const state = readDaemonState(workspace);
    if (!state || !isProcessAlive(state.pid)) {
      fs.rmSync(getPaths(workspace).daemonState, { force: true });
      printResponse({ ok: true, data: { stopped: false, reason: "not_running" } }, { json: program.opts().json });
      return;
    }
    try {
      const response = await requestDaemonAt(state.port, "POST", "/daemon/stop", { timeoutMs: options.timeout }, options.timeout + 5000, state.token);
      printResponse(response, { json: program.opts().json });
    } catch {
      await retireUnresponsiveDaemon(workspace, state, resolveDistDaemonPath());
      fs.rmSync(getPaths(workspace).daemonState, { force: true });
      printResponse({ ok: true, data: { stopped: true, pid: state.pid, forced: true } }, { json: program.opts().json });
    }
  }));

program.parseAsync(process.argv).catch((error) => {
  process.exitCode = error instanceof MinecraftCliError && error.status >= 500 ? 1 : 2;
  printResponse(toErrorResponse(error), { json: program.opts().json });
});
