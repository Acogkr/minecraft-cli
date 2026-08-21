import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const SAMPLE_COLUMNS = 64;
const SAMPLE_ROWS = 36;

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

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

export function changedPngRegion(file: string, previousFile?: string, padding = 8) {
  if (!previousFile || !fs.existsSync(previousFile)) return { comparable: false, changed: true };
  const current = PNG.sync.read(fs.readFileSync(file));
  const previous = PNG.sync.read(fs.readFileSync(previousFile));
  if (current.width !== previous.width || current.height !== previous.height) {
    return { comparable: false, changed: true, region: { x: 0, y: 0, width: current.width, height: current.height } };
  }
  let minX = current.width;
  let minY = current.height;
  let maxX = -1;
  let maxY = -1;
  let changedPixels = 0;
  for (let y = 0; y < current.height; y++) {
    for (let x = 0; x < current.width; x++) {
      const offset = (y * current.width + x) * 4;
      const delta = Math.max(
        Math.abs(current.data[offset] - previous.data[offset]),
        Math.abs(current.data[offset + 1] - previous.data[offset + 1]),
        Math.abs(current.data[offset + 2] - previous.data[offset + 2]),
        Math.abs(current.data[offset + 3] - previous.data[offset + 3])
      );
      if (delta < 8) continue;
      changedPixels++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (changedPixels === 0) return { comparable: true, changed: false, changedPixels: 0 };
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  const right = Math.min(current.width, maxX + 1 + padding);
  const bottom = Math.min(current.height, maxY + 1 + padding);
  return {
    comparable: true,
    changed: true,
    changedPixels,
    changedPixelRatio: Number((changedPixels / (current.width * current.height)).toFixed(6)),
    region: { x, y, width: right - x, height: bottom - y }
  };
}

export function cropPng(inputFile: string, outputFile: string, requested: ImageRegion) {
  const source = PNG.sync.read(fs.readFileSync(inputFile));
  const region = clampRegion(requested, source.width, source.height);
  if (region.width < 1 || region.height < 1) throw new Error("Crop region is empty.");
  const output = new PNG({ width: region.width, height: region.height });
  PNG.bitblt(source, output, region.x, region.y, region.width, region.height, 0, 0);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, PNG.sync.write(output));
  return { ...region, file: outputFile, bytes: fs.statSync(outputFile).size };
}

export function createContactSheet(files: string[], outputFile: string) {
  if (files.length === 0) return undefined;
  const images = files.map(file => ({ file, png: PNG.sync.read(fs.readFileSync(file)) }));
  const columns = Math.min(2, images.length);
  const rows = Math.ceil(images.length / columns);
  const cellWidth = Math.max(...images.map(image => image.png.width));
  const cellHeight = Math.max(...images.map(image => image.png.height));
  const output = new PNG({ width: cellWidth * columns, height: cellHeight * rows });
  output.data.fill(0);
  images.forEach((image, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    PNG.bitblt(image.png, output, 0, 0, image.png.width, image.png.height, column * cellWidth, row * cellHeight);
  });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, PNG.sync.write(output));
  return { file: outputFile, width: output.width, height: output.height, count: files.length, bytes: fs.statSync(outputFile).size };
}

export function intersectRegions(left: ImageRegion, right: ImageRegion) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return rightEdge > x && bottomEdge > y ? { x, y, width: rightEdge - x, height: bottomEdge - y, label: left.label } : undefined;
}

function clampRegion(region: ImageRegion, width: number, height: number) {
  const x = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil(region.x + region.width)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil(region.y + region.height)));
  return { x, y, width: right - x, height: bottom - y, ...(region.label ? { label: region.label } : {}) };
}
