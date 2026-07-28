import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CONSTANT_STROKE_WIDTH_PROFILE,
  DEFAULT_STROKE_WIDTH_PROFILE,
  PAPER_COLOR,
  activeCanvasMarkCommands,
  type CanvasCommand,
  type Point,
  type StrokeCommand,
  type StrokeWidthProfile
} from "@drawguessai/canvas-protocol";

export const SERVER_AI_IMAGE_SIZE = { width: 480, height: 360 } as const;

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

interface Raster {
  pixels: Uint8Array;
  width: number;
  height: number;
}

interface ScaledPoint {
  x: number;
  y: number;
}

const SCALE_X = SERVER_AI_IMAGE_SIZE.width / CANVAS_WIDTH;
const SCALE_Y = SERVER_AI_IMAGE_SIZE.height / CANVAS_HEIGHT;
const PAPER_RGB = parseHexColor(PAPER_COLOR);

function parseHexColor(color: string): Rgb {
  return {
    red: Number.parseInt(color.slice(1, 3), 16),
    green: Number.parseInt(color.slice(3, 5), 16),
    blue: Number.parseInt(color.slice(5, 7), 16)
  };
}

function smoothStep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function widthScaleAt(profile: StrokeWidthProfile, progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  if (clamped <= profile.peakAt) {
    const amount = smoothStep(clamped / profile.peakAt);
    return profile.startScale + (profile.peakScale - profile.startScale) * amount;
  }
  const amount = smoothStep((clamped - profile.peakAt) / (1 - profile.peakAt));
  return profile.peakScale + (profile.endScale - profile.peakScale) * amount;
}

function createRaster(): Raster {
  const { width, height } = SERVER_AI_IMAGE_SIZE;
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = PAPER_RGB.red;
    pixels[index + 1] = PAPER_RGB.green;
    pixels[index + 2] = PAPER_RGB.blue;
    pixels[index + 3] = 255;
  }
  return { pixels, width, height };
}

function setPixel(raster: Raster, x: number, y: number, color: Rgb): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
  const offset = (y * raster.width + x) * 4;
  raster.pixels[offset] = color.red;
  raster.pixels[offset + 1] = color.green;
  raster.pixels[offset + 2] = color.blue;
  raster.pixels[offset + 3] = 255;
}

function scalePoint(point: Point): ScaledPoint {
  return { x: point.x * SCALE_X, y: point.y * SCALE_Y };
}

function drawDisk(
  raster: Raster,
  centerX: number,
  centerY: number,
  radius: number,
  color: Rgb
): void {
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(raster.width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(raster.height - 1, Math.ceil(centerY + radius));
  const radiusSquared = radius * radius;
  for (let y = minY; y <= maxY; y += 1) {
    const dy = y + 0.5 - centerY;
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - centerX;
      if (dx * dx + dy * dy <= radiusSquared) setPixel(raster, x, y, color);
    }
  }
}

function fillPolygon(raster: Raster, points: readonly ScaledPoint[], color: Rgb): void {
  if (points.length < 3) return;
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const maxY = Math.min(raster.height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
  for (let y = minY; y <= maxY; y += 1) {
    const scanY = y + 0.5;
    const intersections: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]!;
      const end = points[(index + 1) % points.length]!;
      if ((start.y <= scanY && end.y > scanY) || (end.y <= scanY && start.y > scanY)) {
        intersections.push(start.x + ((scanY - start.y) * (end.x - start.x)) / (end.y - start.y));
      }
    }
    intersections.sort((left, right) => left - right);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const startX = Math.max(0, Math.ceil(intersections[index]!));
      const endX = Math.min(raster.width - 1, Math.floor(intersections[index + 1]!));
      for (let x = startX; x <= endX; x += 1) setPixel(raster, x, y, color);
    }
  }
}

function drawStroke(raster: Raster, stroke: StrokeCommand): void {
  const scaledPoints = stroke.points.map(scalePoint);
  const strokeColor = stroke.tool === "eraser" ? PAPER_RGB : parseHexColor(stroke.color);
  if (stroke.fillColor !== undefined) {
    fillPolygon(
      raster,
      scaledPoints,
      stroke.tool === "eraser" ? PAPER_RGB : parseHexColor(stroke.fillColor)
    );
  }
  const distances = [0];
  for (let index = 1; index < scaledPoints.length; index += 1) {
    const start = scaledPoints[index - 1]!;
    const end = scaledPoints[index]!;
    distances.push(distances[index - 1]! + Math.hypot(end.x - start.x, end.y - start.y));
  }
  const totalLength = distances.at(-1) ?? 0;
  const profile =
    stroke.widthProfile ??
    (stroke.tool === "eraser" ? CONSTANT_STROKE_WIDTH_PROFILE : DEFAULT_STROKE_WIDTH_PROFILE);
  const radiusAt = (distance: number) =>
    Math.max(
      0.75,
      (stroke.width *
        Math.min(SCALE_X, SCALE_Y) *
        widthScaleAt(profile, totalLength === 0 ? 0 : distance / totalLength)) /
        2
    );
  if (totalLength === 0) {
    const first = scaledPoints[0];
    if (first !== undefined) drawDisk(raster, first.x, first.y, radiusAt(0), strokeColor);
    return;
  }
  for (let index = 1; index < scaledPoints.length; index += 1) {
    const start = scaledPoints[index - 1]!;
    const end = scaledPoints[index]!;
    const startDistance = distances[index - 1]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(length / Math.max(0.75, radiusAt(startDistance) * 0.65)));
    for (let step = 0; step <= steps; step += 1) {
      const progress = step / steps;
      const distance = startDistance + length * progress;
      drawDisk(
        raster,
        start.x + (end.x - start.x) * progress,
        start.y + (end.y - start.y) * progress,
        radiusAt(distance),
        strokeColor
      );
    }
  }
}

function colorsMatch(
  pixels: Uint8Array,
  offset: number,
  target: readonly [number, number, number, number]
): boolean {
  return (
    Math.abs(pixels[offset]! - target[0]) <= 8 &&
    Math.abs(pixels[offset + 1]! - target[1]) <= 8 &&
    Math.abs(pixels[offset + 2]! - target[2]) <= 8 &&
    Math.abs(pixels[offset + 3]! - target[3]) <= 8
  );
}

function drawFill(raster: Raster, point: Point, color: Rgb): void {
  const seedX = Math.max(0, Math.min(raster.width - 1, Math.round(point.x * SCALE_X)));
  const seedY = Math.max(0, Math.min(raster.height - 1, Math.round(point.y * SCALE_Y)));
  const seedIndex = seedY * raster.width + seedX;
  const offset = seedIndex * 4;
  const target = [
    raster.pixels[offset]!,
    raster.pixels[offset + 1]!,
    raster.pixels[offset + 2]!,
    raster.pixels[offset + 3]!
  ] as const;
  if (
    target[0] === color.red &&
    target[1] === color.green &&
    target[2] === color.blue &&
    target[3] === 255
  ) {
    return;
  }
  const pixelCount = raster.width * raster.height;
  const queued = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  queue[tail++] = seedIndex;
  queued[seedIndex] = 1;
  const enqueue = (index: number) => {
    if (queued[index] === 1 || !colorsMatch(raster.pixels, index * 4, target)) return;
    queued[index] = 1;
    queue[tail++] = index;
  };
  while (head < tail) {
    const index = queue[head++]!;
    const pixelOffset = index * 4;
    raster.pixels[pixelOffset] = color.red;
    raster.pixels[pixelOffset + 1] = color.green;
    raster.pixels[pixelOffset + 2] = color.blue;
    raster.pixels[pixelOffset + 3] = 255;
    const x = index % raster.width;
    const y = Math.floor(index / raster.width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < raster.width) enqueue(index + 1);
    if (y > 0) enqueue(index - raster.width);
    if (y + 1 < raster.height) enqueue(index + raster.width);
  }
}

function renderCommands(commands: readonly CanvasCommand[]): Raster {
  const raster = createRaster();
  for (const command of activeCanvasMarkCommands(commands)) {
    if (command.type === "stroke") drawStroke(raster, command);
    else drawFill(raster, command.point, parseHexColor(command.color));
  }
  return raster;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStore(bytes: Uint8Array): Uint8Array {
  const blockCount = Math.ceil(bytes.length / 65_535);
  const result = new Uint8Array(2 + blockCount * 5 + bytes.length + 4);
  result[0] = 0x78;
  result[1] = 0x01;
  let sourceOffset = 0;
  let targetOffset = 2;
  while (sourceOffset < bytes.length) {
    const blockLength = Math.min(65_535, bytes.length - sourceOffset);
    const final = sourceOffset + blockLength === bytes.length;
    result[targetOffset++] = final ? 1 : 0;
    result[targetOffset++] = blockLength & 0xff;
    result[targetOffset++] = (blockLength >>> 8) & 0xff;
    const inverted = ~blockLength & 0xffff;
    result[targetOffset++] = inverted & 0xff;
    result[targetOffset++] = (inverted >>> 8) & 0xff;
    result.set(bytes.subarray(sourceOffset, sourceOffset + blockLength), targetOffset);
    sourceOffset += blockLength;
    targetOffset += blockLength;
  }
  writeUint32(result, targetOffset, adler32(bytes));
  return result;
}

function pngChunk(kind: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(12 + data.length);
  writeUint32(result, 0, data.length);
  const type = new TextEncoder().encode(kind);
  result.set(type, 4);
  result.set(data, 8);
  writeUint32(result, 8 + data.length, crc32(result.subarray(4, 8 + data.length)));
  return result;
}

function encodePng(raster: Raster): Uint8Array {
  const rowLength = raster.width * 4;
  const scanlines = new Uint8Array((rowLength + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    const scanlineOffset = y * (rowLength + 1);
    scanlines[scanlineOffset] = 0;
    scanlines.set(raster.pixels.subarray(y * rowLength, (y + 1) * rowLength), scanlineOffset + 1);
  }
  const header = new Uint8Array(13);
  writeUint32(header, 0, raster.width);
  writeUint32(header, 4, raster.height);
  header[8] = 8;
  header[9] = 6;
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibStore(scanlines)),
    pngChunk("IEND", new Uint8Array())
  ];
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

export function commandsToServerAiImageDataUrl(commands: readonly CanvasCommand[]): string {
  return `data:image/png;base64,${base64(encodePng(renderCommands(commands)))}`;
}
