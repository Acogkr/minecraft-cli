import fs from "node:fs";
import path from "node:path";
import { MinecraftCliError } from "./errors";

interface RetentionOptions {
  olderThanDays: number;
  keepScreenshots: number;
  keepJson: number;
  keepRuns: number;
  apply: boolean;
}

interface Candidate {
  file: string;
  kind: "screenshot" | "json" | "run";
  bytes: number;
  modifiedAt: string;
}

export function artifactStatus(workspace: string) {
  const root = path.join(workspace, ".minecraft-cli");
  const areas = ["sessions", "runs", "logs", "runtime", "downloads"].map(name => directoryStats(path.join(root, name), name));
  const sessionsRoot = path.join(root, "sessions");
  const sessions = fs.existsSync(sessionsRoot)
    ? fs.readdirSync(sessionsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => directoryStats(path.join(sessionsRoot, entry.name), entry.name))
        .sort((left, right) => right.bytes - left.bytes)
    : [];
  return {
    root,
    totalBytes: areas.reduce((sum, area) => sum + area.bytes, 0),
    totalFiles: areas.reduce((sum, area) => sum + area.files, 0),
    areas,
    sessions: sessions.slice(0, 20)
  };
}

export function pruneArtifacts(workspace: string, options: RetentionOptions) {
  validateRetentionOptions(options);
  const root = path.resolve(workspace, ".minecraft-cli");
  const cutoff = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000;
  const candidates: Candidate[] = [];
  const sessionsRoot = path.join(root, "sessions");
  if (fs.existsSync(sessionsRoot)) {
    for (const session of fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      collectOldFiles(path.join(sessionsRoot, session.name, "screenshots"), "screenshot", options.keepScreenshots, cutoff, () => true, candidates);
      collectOldFiles(path.join(sessionsRoot, session.name, "json"), "json", options.keepJson, cutoff, isHistoricalJson, candidates);
    }
  }
  collectOldFiles(path.join(root, "runs"), "run", options.keepRuns, cutoff, file => file.toLowerCase().endsWith(".json"), candidates);

  const reportDir = path.join(root, "runs");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, `${timestampFilePart()}-artifact-prune.json`);
  const removed: string[] = [];
  if (options.apply) {
    for (const candidate of candidates) {
      assertInsideRoot(candidate.file, root);
      fs.rmSync(candidate.file, { force: true });
      removed.push(candidate.file);
    }
  }
  const summary = {
    applied: options.apply,
    cutoff: new Date(cutoff).toISOString(),
    retention: {
      olderThanDays: options.olderThanDays,
      keepScreenshots: options.keepScreenshots,
      keepJson: options.keepJson,
      keepRuns: options.keepRuns
    },
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    removed: removed.length,
    removedBytes: options.apply ? candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) : 0,
    reportFile
  };
  fs.writeFileSync(reportFile, `${JSON.stringify({ ...summary, files: candidates }, null, 2)}\n`, "utf8");
  return summary;
}

function collectOldFiles(
  directory: string,
  kind: Candidate["kind"],
  keep: number,
  cutoff: number,
  include: (name: string) => boolean,
  output: Candidate[]
) {
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && include(entry.name))
    .map(entry => {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file);
      return { file, stat };
    })
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  for (const entry of files.slice(keep)) {
    if (entry.stat.mtimeMs >= cutoff) continue;
    output.push({ file: entry.file, kind, bytes: entry.stat.size, modifiedAt: entry.stat.mtime.toISOString() });
  }
}

function isHistoricalJson(name: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(name) && name.toLowerCase().endsWith(".json");
}

function directoryStats(directory: string, name: string) {
  if (!fs.existsSync(directory)) return { name, files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) {
        files++;
        bytes += fs.statSync(target).size;
      }
    }
  }
  return { name, files, bytes };
}

function validateRetentionOptions(options: RetentionOptions) {
  for (const [name, value] of Object.entries(options)) {
    if (name === "apply") continue;
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
      throw new MinecraftCliError("ARTIFACT_RETENTION_INVALID", `${name} must be a non-negative integer.`, 400);
    }
  }
  if (options.olderThanDays < 1) throw new MinecraftCliError("ARTIFACT_RETENTION_INVALID", "olderThanDays must be at least 1.", 400);
}

function assertInsideRoot(file: string, root: string) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new MinecraftCliError("ARTIFACT_PATH_UNSAFE", `Refusing to remove file outside artifact root: ${resolved}`, 500);
}

function timestampFilePart() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
