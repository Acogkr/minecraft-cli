import { createRequire } from "node:module";

export type ParticleStatus = "all" | "decreased" | "minimal";

export interface ClientSettingsPacket {
  locale: string;
  viewDistance: number;
  chatFlags: number;
  chatColors: boolean;
  skinParts: number;
  mainHand: number;
  enableTextFiltering: boolean;
  enableServerListing: boolean;
  particleStatus: ParticleStatus;
}

type ProtocolClient = {
  state?: string;
  write: (name: string, params?: unknown) => unknown;
  writeRaw?: (buffer: Buffer) => unknown;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  once?: (event: string, listener: (...args: any[]) => void) => unknown;
  listeners?: (event: string) => Function[];
  removeListener?: (event: string, listener: Function) => unknown;
};

const nodeRequire = createRequire(__filename);
const minecraftProtocol = nodeRequire("minecraft-protocol");
const patchedClients = new WeakSet<object>();

export const VANILLA_CLIENT_SETTINGS_1_21_11: Readonly<ClientSettingsPacket> = Object.freeze({
  locale: "en_us",
  viewDistance: 10,
  chatFlags: 0,
  chatColors: true,
  skinParts: 0x7f,
  mainHand: 1,
  enableTextFiltering: false,
  enableServerListing: true,
  particleStatus: "all"
});

export function clientSettingsForVersion(version: string): ClientSettingsPacket | undefined {
  if (!requiresParticleStatus(version)) return undefined;
  return { ...VANILLA_CLIENT_SETTINGS_1_21_11 };
}

export function normalizeClientSettingsPacket(
  version: string,
  packetName: string,
  params: unknown
): unknown {
  if (packetName !== "settings" || !requiresParticleStatus(version)) return params;

  const input = isRecord(params) ? params : {};
  return {
    locale: normalizeLocale(input.locale),
    viewDistance: boundedInteger(input.viewDistance, 2, 32, VANILLA_CLIENT_SETTINGS_1_21_11.viewDistance),
    chatFlags: boundedInteger(input.chatFlags, 0, 2, VANILLA_CLIENT_SETTINGS_1_21_11.chatFlags),
    chatColors: booleanOrDefault(input.chatColors, VANILLA_CLIENT_SETTINGS_1_21_11.chatColors),
    skinParts: boundedInteger(input.skinParts, 0, 0x7f, VANILLA_CLIENT_SETTINGS_1_21_11.skinParts),
    mainHand: boundedInteger(input.mainHand, 0, 1, VANILLA_CLIENT_SETTINGS_1_21_11.mainHand),
    enableTextFiltering: booleanOrDefault(
      input.enableTextFiltering,
      VANILLA_CLIENT_SETTINGS_1_21_11.enableTextFiltering
    ),
    enableServerListing: booleanOrDefault(
      input.enableServerListing,
      VANILLA_CLIENT_SETTINGS_1_21_11.enableServerListing
    ),
    particleStatus: normalizeParticleStatus(input.particleStatus)
  } satisfies ClientSettingsPacket;
}

export function installClientSettingsPacketAdapter(client: ProtocolClient | undefined, version: string): boolean {
  if (!client || typeof client.write !== "function" || !requiresParticleStatus(version)) return false;
  if (patchedClients.has(client)) return true;

  const originalWrite = client.write.bind(client);
  const configurationSerializer = minecraftProtocol.createSerializer({
    state: minecraftProtocol.states.CONFIGURATION,
    isServer: false,
    version
  });
  const playSerializer = minecraftProtocol.createSerializer({
    state: minecraftProtocol.states.PLAY,
    isServer: false,
    version
  });
  client.write = (name: string, params?: unknown) => {
    const normalized = normalizeClientSettingsPacket(version, name, params);
    if (name === "settings" && client.state === minecraftProtocol.states.CONFIGURATION && client.writeRaw) {
      // Keep reconfiguration settings on a serializer whose state cannot change underneath the write.
      const packet = configurationSerializer.createPacketBuffer({ name, params: normalized });
      if (packet.length <= 1) {
        throw new Error(`Refusing to send an empty Minecraft ${version} ClientSettings payload.`);
      }
      return client.writeRaw(packet);
    }
    return originalWrite(name, normalized);
  };

  patchedClients.add(client);
  installReconfigurationHandler(client, playSerializer, configurationSerializer);
  return true;
}

function installReconfigurationHandler(client: ProtocolClient, playSerializer: any, configurationSerializer: any) {
  if (!client.once || !client.on || !client.listeners || !client.removeListener || !client.writeRaw) return;

  client.once("success", () => {
    setImmediate(() => {
      // node-minecraft-protocol's generic re-entry path can emit an empty id-0 frame on the first proxy transfer.
      const upstream = client.listeners!("start_configuration")
        .find(listener => Function.prototype.toString.call(listener).includes("enterConfigState"));
      if (upstream) client.removeListener!("start_configuration", upstream);

      client.on!("start_configuration", () => {
        if (client.state === minecraftProtocol.states.CONFIGURATION) return;
        if (client.state !== minecraftProtocol.states.PLAY) {
          throw new Error(`Cannot reconfigure Minecraft 1.21.11 client from protocol state '${client.state}'.`);
        }

        writeRawPacket(client, playSerializer, "configuration_acknowledged", {});
        client.state = minecraftProtocol.states.CONFIGURATION;
        writeRawPacket(client, configurationSerializer, "settings", VANILLA_CLIENT_SETTINGS_1_21_11, true);

        client.once!("select_known_packs", () => {
          writeRawPacket(client, configurationSerializer, "select_known_packs", { packs: [] });
        });
        client.once!("code_of_conduct", () => {
          writeRawPacket(client, configurationSerializer, "accept_code_of_conduct", {});
        });
        client.once!("finish_configuration", () => {
          writeRawPacket(client, configurationSerializer, "finish_configuration", {});
          client.state = minecraftProtocol.states.PLAY;
        });
      });
    });
  });
}

function writeRawPacket(
  client: ProtocolClient,
  serializer: any,
  name: string,
  params: unknown,
  requirePayload = false
) {
  const packet = serializer.createPacketBuffer({ name, params });
  if (requirePayload && packet.length <= 1) {
    throw new Error("Refusing to send an empty Minecraft 1.21.11 ClientSettings payload.");
  }
  return client.writeRaw!(packet);
}

function requiresParticleStatus(version: string) {
  return version.trim().toLowerCase() === "1.21.11";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLocale(value: unknown) {
  if (typeof value !== "string") return VANILLA_CLIENT_SETTINGS_1_21_11.locale;
  const locale = value.trim().toLowerCase();
  return locale.length > 0 && locale.length <= 16 ? locale : VANILLA_CLIENT_SETTINGS_1_21_11.locale;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeParticleStatus(value: unknown): ParticleStatus {
  if (value === "all" || value === "decreased" || value === "minimal") return value;
  if (value === 1) return "decreased";
  if (value === 2) return "minimal";
  return VANILLA_CLIENT_SETTINGS_1_21_11.particleStatus;
}
