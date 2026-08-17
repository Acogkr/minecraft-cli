export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OkResponse<T = Record<string, unknown>> {
  ok: true;
  data: T;
}

export interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type CliResponse<T = Record<string, unknown>> = OkResponse<T> | ErrorResponse;

export interface RuntimePaths {
  workspace: string;
  root: string;
  logs: string;
  sessions: string;
  runtime: string;
  daemonState: string;
}

export interface DaemonStateFile {
  pid: number;
  port: number;
  token: string;
  workspace: string;
  startedAt: string;
}

export interface SessionSnapshot {
  name: string;
  username: string;
  auth: "offline" | "microsoft";
  account?: string;
  createdAt: string;
  connected: boolean;
  connecting: boolean;
  server: {
    host: string;
    port: number;
    version: string;
  };
  position?: {
    x: number;
    y: number;
    z: number;
  };
  rotation?: {
    yaw: number;
    pitch: number;
  };
  health?: number;
  food?: number;
  gameMode?: string;
  dimension?: string;
  selectedSlot?: number;
  heldItem?: unknown;
  inventory?: unknown[];
  openWindow?: unknown;
  bossBars?: unknown[];
  scoreboards?: unknown[];
  tablist?: unknown;
  nearbyEntities?: unknown[];
  nearbyPlayers?: string[];
  recentEvents: SessionEvent[];
}

export interface SessionEvent {
  sequence: number;
  time: string;
  type: string;
  message?: string;
  data?: unknown;
}
