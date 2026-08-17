import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillName = "minecraft-plugin-test";
const source = path.join(root, ".codex", "skills", skillName);
const codexHome = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), ".codex");
const destination = path.join(codexHome, "skills", skillName);
const skillOnly = process.argv.includes("--skill-only");

if (!fs.existsSync(path.join(source, "SKILL.md"))) {
  throw new Error(`Skill source is missing: ${source}`);
}

if (!skillOnly) {
  const npmCli = process.env.npm_execpath;
  const runNpm = (npmArgs) => {
    const command = npmCli ? process.execPath : (process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm");
    const args = npmCli
      ? [npmCli, ...npmArgs]
      : (process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...npmArgs] : npmArgs);
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  runNpm(["run", "build"]);
  runNpm(["install", "--global", root]);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });

process.stdout.write(`${skillName} installed at ${destination}\n`);
if (!skillOnly) process.stdout.write("minecraft-cli installed globally\n");
