import fs from "node:fs";
import path from "node:path";
import type { RuntimePaths } from "./types";

export function getPaths(workspace = process.cwd()): RuntimePaths {
  const root = path.join(workspace, ".minecraft-cli");
  return {
    workspace,
    root,
    logs: path.join(root, "logs"),
    sessions: path.join(root, "sessions"),
    runtime: path.join(root, "runtime"),
    daemonState: path.join(root, "runtime", "daemon.json")
  };
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
