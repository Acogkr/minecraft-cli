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
import { analyzePngChange, latestPng } from "./image-diff";
import { artifactStatus, pruneArtifacts } from "./artifacts";
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

function configureManagedVisualOptions(targetOptions: string, sourceOptions?: string) {
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
  fs.writeFileSync(targetOptions, optionsText, "utf8");
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

async function prepareVisualInstance(workspace: string, version: string, multiMcRoot: string, instanceId: string, port: number, token: string, server?: { host: string; port: number }) {
  const adapter = VISUAL_ADAPTERS[version as keyof typeof VISUAL_ADAPTERS];
  if (!adapter) {
    throw new MinecraftCliError("VISUAL_VERSION_UNSUPPORTED", `Visual control currently supports: ${VISUAL_SUPPORTED_VERSIONS.join(", ")}.`, 400);
  }
  const launcher = path.join(multiMcRoot, "MultiMC.exe");
  if (!fs.existsSync(launcher)) throw new MinecraftCliError("MULTIMC_NOT_FOUND", `MultiMC was not found at ${launcher}.`, 404);
  const projectRoot = path.join(packageRoot(), "fixtures", adapter.project);
  const sourceJar = path.join(projectRoot, "build", "libs", adapter.jar);
  if (!fs.existsSync(sourceJar)) {
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
  }
  const instanceRoot = path.join(multiMcRoot, "instances", instanceId);
  const createdInstance = !fs.existsSync(path.join(instanceRoot, "instance.cfg"));
  const gameRoot = path.join(instanceRoot, ".minecraft");
  const mods = path.join(gameRoot, "mods");
  fs.mkdirSync(mods, { recursive: true });
  pruneManagedInstanceFiles(path.join(gameRoot, "logs"), 5);
  pruneManagedInstanceFiles(path.join(gameRoot, "crash-reports"), 3);
  const sourceOptions = path.join(multiMcRoot, "instances", version, ".minecraft", "options.txt");
  const targetOptions = path.join(gameRoot, "options.txt");
  configureManagedVisualOptions(targetOptions, sourceOptions);
  fs.copyFileSync(sourceJar, path.join(mods, "minecraft-cli-control.jar"));
  writeJsonFile(path.join(gameRoot, "minecraft-cli-control.json"), { port, token, version, ...(server ? { serverHost: server.host, serverPort: server.port } : {}) });
  const intermediary = path.join(multiMcRoot, "libraries", "net", "fabricmc", "intermediary", version, `intermediary-${version}.jar`);
  await downloadIfMissing(`https://maven.fabricmc.net/net/fabricmc/intermediary/${version}/intermediary-${version}.jar`, intermediary);
  await prepareMultiMcFabricLoader(multiMcRoot, adapter.loader);
  const javaPath = adapter.java === 17 ? await ensureJava17Runtime(workspace) : undefined;
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
    "MinecraftWinWidth=960",
    "MinecraftWinHeight=540",
    ...(javaPath ? ["OverrideJava=true", `JavaPath=${javaPath.replace(/\\/g, "/")}`] : [])
  ].join("\n") + "\n", "utf8");
  return { launcher, instanceId, instanceRoot, sourceJar, javaRequired: adapter.java, adapter: adapter.project, createdInstance };
}

async function visualRequest(runtime: any, route: string, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      headers: { Authorization: runtime.token }, signal: controller.signal
    });
    const body = await response.json();
    if (!response.ok || !(body as any).ok) throw new MinecraftCliError("VISUAL_CONTROL_FAILED", (body as any).error ?? `HTTP ${response.status}`, 500);
    return body;
  } finally { clearTimeout(timer); }
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
        if (health.ok) return state;
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

async function probeDaemon(state: NonNullable<ReturnType<typeof readDaemonState>>, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isProcessAlive(state.pid)) return false;
    try {
      const health = await requestDaemonAt(state.port, "GET", "/health", undefined, 1500, state.token);
      if (health.ok) return true;
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
  if (existing && await probeDaemon(existing)) {
    return { state: existing, started: false };
  }

  return withDaemonStartLock(workspace, async () => {
    const concurrent = readDaemonState(workspace);
    const daemonPath = resolveDistDaemonPath();
    if (!fs.existsSync(daemonPath)) {
      throw new MinecraftCliError("DAEMON_NOT_BUILT", "dist/daemon.js does not exist. Run npm run build first.", 500);
    }
    if (concurrent && await probeDaemon(concurrent)) {
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
  if (process.platform === "win32") {
    const script = [
      `Start-Process`,
      `-WindowStyle Hidden`,
      `-FilePath ${powerShellString(process.execPath)}`,
      `-WorkingDirectory ${powerShellString(workspace)}`,
      `-ArgumentList @(${powerShellString(daemonPath)}, '--workspace', ${powerShellString(workspace)})`
    ].join(" ");
    const launcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script], {
      cwd: workspace,
      stdio: "ignore",
      windowsHide: true
    });
    await waitForLauncher(launcher);
    return;
  }

  const child = spawn(process.execPath, [daemonPath, "--workspace", workspace], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function powerShellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function waitForLauncher(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new MinecraftCliError("DAEMON_LAUNCH_FAILED", `Daemon launcher exited with code ${code}.`, 500));
    });
  });
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
  .option("--part <part>", "core, inventory, entities, window, ui, or events")
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
  .action((name: string, options) => run(async () => {
    const workspace = getWorkspace();
    const multiMcRoot = path.resolve(options.multimc);
    await withVisualAllocationLock(multiMcRoot, 60_000, async () => {
      const instanceId = selectAvailableVisualInstanceId(options.version);
      const port = await getFreePort();
      const token = crypto.randomBytes(32).toString("hex");
      const prepared = await prepareVisualInstance(workspace, options.version, multiMcRoot, instanceId, port, token);
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
  .option("--timeout <ms>", "launch timeout", (value) => Number(value), 120_000)
  .action((name: string, options) => run(async () => {
    const workspace = getWorkspace();
    const multiMcRoot = path.resolve(options.multimc);
    const authMode = normalizeAuthMode(options.auth);
    const microsoftProfile = authMode === "microsoft"
      ? multiMcMicrosoftProfile(multiMcRoot, options.profile)
      : undefined;
    await withVisualAllocationLock(multiMcRoot, options.timeout + 60_000, async () => {
      const instanceId = await selectVisualInstanceId(workspace, name, options.version);
      const controlPort = await getFreePort();
      const token = crypto.randomBytes(32).toString("hex");
      const prepared = await prepareVisualInstance(workspace, options.version, multiMcRoot, instanceId, controlPort, token, { host: options.host, port: options.port });
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
        await waitForVisual(runtime, options.timeout);
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
        printResponse({ ok: true, data: { session: name, instance: prepared.instanceId, state, stoppedDuplicatePids } }, { json: program.opts().json });
      } catch (error) {
        stopDedicatedVisualInstance(prepared.instanceId);
        throw error;
      }
    });
  }));

visual.command("stop").argument("<name>").action((name: string) => run(async () => {
  const runtime = readVisualRuntime(getWorkspace(), name);
  await withVisualAllocationLock(runtime.instanceRoot ? path.dirname(path.dirname(runtime.instanceRoot)) : defaultMultiMcRoot(), 30_000, async () => {
    const stoppedPids = stopDedicatedVisualInstance(runtime.instanceId);
    writeJsonFile(visualRuntimeFile(getWorkspace(), name), {
      ...runtime,
      token: "",
      stoppedAt: new Date().toISOString()
    });
    printResponse({ ok: true, data: { session: name, instance: runtime.instanceId, stoppedPids } }, { json: program.opts().json });
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
  const state = await visualRequest(readVisualRuntime(getWorkspace(), name), "/state");
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

visual.command("screenshot").argument("<name>")
  .option("--label <label>", "file label", "visual")
  .option("--no-compare", "skip comparison with the previous session screenshot")
  .action((name: string, options) => run(async () => {
  const workspace = getWorkspace();
  const runtime = readVisualRuntime(workspace, name);
  const dirs = ensureSessionArtifactDirs(workspace, name);
  const previousScreenshot = options.compare ? latestPng(dirs.screenshots) : undefined;
  const stamp = timestampFilePart();
  const file = path.join(dirs.screenshots, `${stamp}-${safeFilePart(options.label)}.png`);
  const startedAt = Date.now();
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
  const metadata = { session: name, capturedAt: new Date().toISOString(), mode: "in_game_framebuffer", capture, imageAnalysis,
    performance: { durationMs: Date.now() - startedAt, analysisDurationMs: Date.now() - analysisStartedAt, screenshotBytes: size } };
  const metadataFile = path.join(dirs.json, `${stamp}-${safeFilePart(options.label)}.visual.json`);
  writeJsonFile(metadataFile, metadata);
  printResponse({ ok: true, data: { ...metadata, file, metadataFile } }, { json: program.opts().json });
}));

program
  .command("scenario")
  .description("Run a token-efficient JSON sequence of minecraft-cli commands.")
  .argument("<file>", "scenario JSON file")
  .option("--full", "return every compact step response instead of a summary", false)
  .option("--dry-run", "validate and list steps without running them", false)
  .action((file: string, options) => run(async () => {
    const response = executeScenario({
      file,
      workspace: getWorkspace(),
      cliFile: path.resolve(process.argv[1]),
      full: options.full,
      dryRun: options.dryRun
    });
    if (!response.ok) process.exitCode = 2;
    printResponse(response, { json: program.opts().json, compactJson: true });
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
