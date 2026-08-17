import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MinecraftCliError } from "./errors";

export type MinecraftAuthMode = "offline" | "microsoft";

export interface MicrosoftAccountProfile {
  account: string;
  profileName: string;
  profileId: string;
  signedInAt: string;
}

export function normalizeAuthMode(value: unknown): MinecraftAuthMode {
  const mode = String(value ?? "offline").trim().toLowerCase();
  if (mode !== "offline" && mode !== "microsoft") {
    throw new MinecraftCliError("INVALID_AUTH_MODE", "Auth mode must be 'offline' or 'microsoft'.", 400);
  }
  return mode;
}

export function normalizeAccountAlias(value: unknown) {
  const alias = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(alias)) {
    throw new MinecraftCliError("INVALID_ACCOUNT_ALIAS", "Account alias must be 1-64 letters, numbers, dots, underscores, or hyphens.", 400);
  }
  return alias;
}

export function authRoot() {
  return process.env.MINECRAFT_CLI_AUTH_ROOT
    ? path.resolve(process.env.MINECRAFT_CLI_AUTH_ROOT)
    : path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".minecraft-cli"), "minecraft-cli", "auth");
}

export function accountPaths(aliasValue: unknown) {
  const account = normalizeAccountAlias(aliasValue);
  const root = path.join(authRoot(), "accounts", account);
  return {
    account,
    root,
    cache: path.join(root, "cache"),
    profile: path.join(root, "profile.json")
  };
}

export function ensureAccountCache(aliasValue: unknown) {
  const paths = accountPaths(aliasValue);
  fs.mkdirSync(paths.cache, { recursive: true });
  try {
    fs.chmodSync(paths.root, 0o700);
    fs.chmodSync(paths.cache, 0o700);
  } catch {
    // Windows primarily protects this directory through the user's LocalAppData ACL.
  }
  return paths;
}

export function writeAccountProfile(profile: MicrosoftAccountProfile) {
  const paths = ensureAccountCache(profile.account);
  const temporary = `${paths.profile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, paths.profile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return profile;
}

export function readAccountProfile(aliasValue: unknown) {
  const paths = accountPaths(aliasValue);
  if (!fs.existsSync(paths.profile)) {
    throw new MinecraftCliError(
      "MICROSOFT_AUTH_REQUIRED",
      `Microsoft account '${paths.account}' is not signed in. Run: minecraft-cli auth login ${paths.account}`,
      401
    );
  }
  try {
    const profile = JSON.parse(fs.readFileSync(paths.profile, "utf8")) as MicrosoftAccountProfile;
    if (profile.account !== paths.account || !profile.profileName || !profile.profileId) throw new Error("invalid profile");
    return profile;
  } catch {
    throw new MinecraftCliError("MICROSOFT_AUTH_INVALID", `Stored profile for '${paths.account}' is invalid. Sign in again.`, 500);
  }
}

export function listAccountProfiles() {
  const accountsRoot = path.join(authRoot(), "accounts");
  if (!fs.existsSync(accountsRoot)) return [] as MicrosoftAccountProfile[];
  const profiles: MicrosoftAccountProfile[] = [];
  for (const entry of fs.readdirSync(accountsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      profiles.push(readAccountProfile(entry.name));
    } catch {
      // Ignore incomplete or damaged cache directories in the summary.
    }
  }
  return profiles.sort((left, right) => left.account.localeCompare(right.account));
}

export function removeAccount(aliasValue: unknown) {
  const paths = accountPaths(aliasValue);
  const existed = fs.existsSync(paths.root);
  fs.rmSync(paths.root, { recursive: true, force: true });
  for (const directory of [path.dirname(paths.root), authRoot()]) {
    try {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {
      // Another account or process may still be using the shared auth directory.
    }
  }
  return { account: paths.account, removed: existed };
}
