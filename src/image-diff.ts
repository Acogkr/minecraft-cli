import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const SAMPLE_COLUMNS = 64;
const SAMPLE_ROWS = 36;

export function analyzePngChange(file: string, previousFile?: string) {
  const currentBuffer = fs.readFileSync(file);
  const current = PNG.sync.read(currentBuffer);
  const base = {
    sha256: crypto.createHash("sha256").update(currentBuffer).digest("hex"),
    width: current.width,
    height: current.height
  };
  if (!previousFile || !fs.existsSync(previousFile)) return { ...base, firstCapture: true };

  const previousBuffer = fs.readFileSync(previousFile);
  const previousHash = crypto.createHash("sha256").update(previousBuffer).digest("hex");
  if (previousHash === base.sha256) {
    return {
      ...base,
      firstCapture: false,
      comparedTo: previousFile,
      exactMatch: true,
      samples: SAMPLE_COLUMNS * SAMPLE_ROWS,
      meanChannelDelta: 0,
      changedSampleRatio: 0,
      meaningfullyChanged: false
    };
  }

  const previous = PNG.sync.read(previousBuffer);
  let totalDifference = 0;
  let changedSamples = 0;
  const samples = SAMPLE_COLUMNS * SAMPLE_ROWS;
  for (let row = 0; row < SAMPLE_ROWS; row++) {
    for (let column = 0; column < SAMPLE_COLUMNS; column++) {
      const currentX = Math.min(current.width - 1, Math.floor(((column + 0.5) / SAMPLE_COLUMNS) * current.width));
      const currentY = Math.min(current.height - 1, Math.floor(((row + 0.5) / SAMPLE_ROWS) * current.height));
      const previousX = Math.min(previous.width - 1, Math.floor(((column + 0.5) / SAMPLE_COLUMNS) * previous.width));
      const previousY = Math.min(previous.height - 1, Math.floor(((row + 0.5) / SAMPLE_ROWS) * previous.height));
      const currentOffset = (currentY * current.width + currentX) * 4;
      const previousOffset = (previousY * previous.width + previousX) * 4;
      const red = Math.abs(current.data[currentOffset] - previous.data[previousOffset]);
      const green = Math.abs(current.data[currentOffset + 1] - previous.data[previousOffset + 1]);
      const blue = Math.abs(current.data[currentOffset + 2] - previous.data[previousOffset + 2]);
      totalDifference += red + green + blue;
      if (Math.max(red, green, blue) >= 16) changedSamples++;
    }
  }
  const meanChannelDelta = totalDifference / (samples * 3 * 255);
  const changedSampleRatio = changedSamples / samples;
  return {
    ...base,
    firstCapture: false,
    comparedTo: previousFile,
    exactMatch: false,
    samples,
    meanChannelDelta: Number(meanChannelDelta.toFixed(5)),
    changedSampleRatio: Number(changedSampleRatio.toFixed(5)),
    meaningfullyChanged: meanChannelDelta >= 0.003 || changedSampleRatio >= 0.005
  };
}

export function latestPng(directory: string) {
  if (!fs.existsSync(directory)) return undefined;
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map(entry => {
      const file = path.join(directory, entry.name);
      return { file, modifiedAt: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.file;
}
