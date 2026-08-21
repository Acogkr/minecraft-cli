import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { analyzePngChange, changedPngRegion, createContactSheet, cropPng, latestPng } from "../dist/image-diff.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-cli-image-diff-"));

function writeImage(name, colorFor) {
  const png = new PNG({ width: 64, height: 36 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      const [red, green, blue] = colorFor(x, y);
      png.data[offset] = red;
      png.data[offset + 1] = green;
      png.data[offset + 2] = blue;
      png.data[offset + 3] = 255;
    }
  }
  const file = path.join(root, name);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

try {
  const first = writeImage("first.png", () => [20, 40, 60]);
  const identical = writeImage("identical.png", () => [20, 40, 60]);
  const changed = writeImage("changed.png", (x) => x < 32 ? [220, 30, 30] : [20, 40, 60]);
  fs.utimesSync(changed, new Date(), new Date(Date.now() + 1000));

  const initial = analyzePngChange(first);
  assert.equal(initial.firstCapture, true);
  assert.equal(initial.sha256.length, 64);

  const same = analyzePngChange(identical, first);
  assert.equal(same.exactMatch, true);
  assert.equal(same.meanChannelDelta, 0);
  assert.equal(same.meaningfullyChanged, false);

  const difference = analyzePngChange(changed, first);
  assert.equal(difference.exactMatch, false);
  assert.equal(difference.changedSampleRatio, 0.5);
  assert.equal(difference.meaningfullyChanged, true);
  const bounds = changedPngRegion(changed, first, 0);
  assert.deepEqual(bounds.region, { x: 0, y: 0, width: 32, height: 36 });
  assert.equal(changedPngRegion(identical, first).changed, false);
  const crop = cropPng(changed, path.join(root, "crops", "left.png"), { x: 0, y: 0, width: 32, height: 36, label: "left" });
  assert.equal(crop.width, 32);
  assert.equal(crop.height, 36);
  const sheet = createContactSheet([crop.file, crop.file], path.join(root, "crops", "sheet.png"));
  assert.equal(sheet.count, 2);
  assert.equal(sheet.width, 64);
  assert.equal(latestPng(root), changed);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("Image difference smoke test passed.\n");
