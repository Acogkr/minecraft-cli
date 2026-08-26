import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDeserializer, createSerializer, states } = require("minecraft-protocol");
const {
  VANILLA_CLIENT_SETTINGS_1_21_11,
  installClientSettingsPacketAdapter,
  normalizeClientSettingsPacket
} = require("../dist/client-settings.js");

const expectedKeys = [
  "locale",
  "viewDistance",
  "chatFlags",
  "chatColors",
  "skinParts",
  "mainHand",
  "enableTextFiltering",
  "enableServerListing",
  "particleStatus"
];

const normalized = normalizeClientSettingsPacket("1.21.11", "settings", {});
assert.deepEqual(Object.keys(normalized), expectedKeys);
assert.deepEqual(normalized, VANILLA_CLIENT_SETTINGS_1_21_11);

const customized = normalizeClientSettingsPacket("1.21.11", "settings", {
  locale: "KO_KR",
  viewDistance: 12,
  chatFlags: 1,
  chatColors: false,
  skinParts: 0x55,
  mainHand: 0,
  enableTextFiltering: true,
  enableServerListing: false,
  particleStatus: 2
});
assert.deepEqual(customized, {
  locale: "ko_kr",
  viewDistance: 12,
  chatFlags: 1,
  chatColors: false,
  skinParts: 0x55,
  mainHand: 0,
  enableTextFiltering: true,
  enableServerListing: false,
  particleStatus: "minimal"
});

const writes = [];
const rawWrites = [];
class FakeClient extends EventEmitter {
  state = states.CONFIGURATION;

  write(name, params) {
    writes.push({ name, params });
  }

  writeRaw(buffer) {
    rawWrites.push(buffer);
  }
}

const fakeClient = new FakeClient();
let upstreamReconfigurationCalls = 0;
fakeClient.once("success", () => {
  fakeClient.on("start_configuration", () => enterConfigState());
});
function enterConfigState() {
  upstreamReconfigurationCalls += 1;
}
assert.equal(installClientSettingsPacketAdapter(fakeClient, "1.21.11"), true);
assert.equal(installClientSettingsPacketAdapter(fakeClient, "1.21.11"), true);
fakeClient.write("settings", undefined);
fakeClient.write("settings", { locale: "ko_kr", particleStatus: "decreased" });
fakeClient.write("finish_configuration", {});
assert.equal(rawWrites.length, 2);
assert.equal(writes.length, 1);
assert.deepEqual(writes[0], { name: "finish_configuration", params: {} });

const serializer = createSerializer({ state: states.CONFIGURATION, isServer: false, version: "1.21.11" });
const deserializer = createDeserializer({ state: states.CONFIGURATION, isServer: true, version: "1.21.11" });
const rawPackets = rawWrites.map(buffer => deserializer.parsePacketBuffer(buffer).data.params);
assert.deepEqual(Object.keys(rawPackets[0]), expectedKeys);
assert.equal(rawPackets[1].locale, "ko_kr");
assert.equal(rawPackets[1].particleStatus, "decreased");

for (const packet of [...rawPackets, customized]) {
  const encoded = serializer.createPacketBuffer({ name: "settings", params: packet });
  const decoded = deserializer.parsePacketBuffer(encoded).data;
  assert.equal(decoded.name, "settings");
  assert.deepEqual(decoded.params, packet);
  assert.ok(encoded.length >= 10, `ClientSettings frame must include packet id plus 9 fields, got ${encoded.length} bytes.`);
}

fakeClient.state = states.PLAY;
fakeClient.write("settings", {});
assert.equal(writes.length, 2);
assert.deepEqual(Object.keys(writes[1].params), expectedKeys);

fakeClient.emit("success", {});
await new Promise(resolve => setImmediate(resolve));
const reconfigurationStartIndex = rawWrites.length;
fakeClient.emit("start_configuration", {});
assert.equal(upstreamReconfigurationCalls, 0);
assert.equal(fakeClient.state, states.CONFIGURATION);
assert.equal(rawWrites.length, reconfigurationStartIndex + 2);

const playDeserializer = createDeserializer({ state: states.PLAY, isServer: true, version: "1.21.11" });
const acknowledged = playDeserializer.parsePacketBuffer(rawWrites[reconfigurationStartIndex]).data;
assert.equal(acknowledged.name, "configuration_acknowledged");
const reconfiguredSettings = deserializer.parsePacketBuffer(rawWrites[reconfigurationStartIndex + 1]).data;
assert.equal(reconfiguredSettings.name, "settings");
assert.deepEqual(reconfiguredSettings.params, VANILLA_CLIENT_SETTINGS_1_21_11);

fakeClient.emit("select_known_packs", { packs: [] });
fakeClient.emit("finish_configuration", {});
assert.equal(fakeClient.state, states.PLAY);
const knownPacks = deserializer.parsePacketBuffer(rawWrites[reconfigurationStartIndex + 2]).data;
const finished = deserializer.parsePacketBuffer(rawWrites[reconfigurationStartIndex + 3]).data;
assert.equal(knownPacks.name, "select_known_packs");
assert.deepEqual(knownPacks.params, { packs: [] });
assert.equal(finished.name, "finish_configuration");

const priorVersionPayload = { untouched: true };
assert.equal(
  normalizeClientSettingsPacket("1.21.10", "settings", priorVersionPayload),
  priorVersionPayload
);

process.stdout.write("client-settings-1.21.11 smoke passed: 9-field configuration payload survives repeated writes and protocol round-trip.\n");
