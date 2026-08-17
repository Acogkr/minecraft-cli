import fs from "node:fs";
import path from "node:path";
import type { RuntimePaths } from "./types";

export function getPaths(workspace = process.cwd()): RuntimePaths {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const root = path.join(normalizedWorkspace, ".minecraft-cli");
  return {
    workspace: normalizedWorkspace,
    root,
    logs: path.join(root, "logs"),
    sessions: path.join(root, "sessions"),
    runtime: path.join(root, "runtime"),
    daemonState: path.join(root, "runtime", "daemon.json")
  };
}

export function normalizeWorkspace(workspace = process.cwd()) {
  const resolved = path.resolve(workspace);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function ensureBaseDirs(paths: RuntimePaths) {
  for (const dir of [
    paths.root,
    paths.logs,
    paths.sessions,
    paths.runtime
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
