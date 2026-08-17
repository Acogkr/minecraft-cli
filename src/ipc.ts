import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { MinecraftCliError } from "./errors";
import { getPaths } from "./paths";
import type { CliResponse, DaemonStateFile } from "./types";

export const DEFAULT_DAEMON_TIMEOUT_MS = 30_000;

export async function getFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new MinecraftCliError("PORT_DISCOVERY_FAILED", "Could not discover a free local port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export async function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function readDaemonState(workspace = process.cwd()): DaemonStateFile | null {
  const paths = getPaths(workspace);
  if (!fs.existsSync(paths.daemonState)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.daemonState, "utf8")) as DaemonStateFile;
  } catch {
    return null;
  }
}

export async function requestDaemon<T = unknown>(
  workspace: string,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = DEFAULT_DAEMON_TIMEOUT_MS
): Promise<CliResponse<T>> {
  const state = readDaemonState(workspace);
  if (!state) {
    throw new MinecraftCliError("DAEMON_UNAVAILABLE", "minecraft-cli daemon is not running.", 503);
  }

  return requestDaemonAt<T>(state.port, method, route, body, timeoutMs, state.token);
}

export async function requestDaemonAt<T = unknown>(
  port: number,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = DEFAULT_DAEMON_TIMEOUT_MS,
  token?: string
): Promise<CliResponse<T>> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: token } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length
              }
            : {})
        },
        timeout: timeoutMs
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(
              new MinecraftCliError("DAEMON_BAD_RESPONSE", "Daemon returned non-JSON data.", 502, {
                statusCode: response.statusCode,
                body: raw,
                parseError: error instanceof Error ? error.message : String(error)
              })
            );
          }
        });
      }
    );

    request.once("timeout", () => {
      request.destroy(new MinecraftCliError("DAEMON_TIMEOUT", `Daemon request timed out after ${timeoutMs}ms.`, 504));
    });
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveDistDaemonPath() {
  return path.join(__dirname, "daemon.js");
}
