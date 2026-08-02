import type { CanvasCommand } from "@drawguessai/canvas-protocol";
import { describe, expect, it } from "vitest";

import { SERVER_AI_IMAGE_SIZE, commandsToServerAiImageDataUrl } from "../src/canvas-image";

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function rawScanlines(bytes: Uint8Array): Uint8Array {
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = readUint32(bytes, offset);
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (kind === "IDAT") idat.push(bytes.slice(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const zlib = concat(idat);
  expect(zlib.slice(0, 2)).toEqual(new Uint8Array([0x78, 0x01]));
  const raw: Uint8Array[] = [];
  offset = 2;
  while (offset < zlib.length - 4) {
    const header = zlib[offset++]!;
    expect(header & 0b110).toBe(0);
    const length = zlib[offset]! | (zlib[offset + 1]! << 8);
    offset += 4;
    raw.push(zlib.slice(offset, offset + length));
    offset += length;
    if ((header & 1) === 1) break;
  }
  return concat(raw);
}

describe("server canvas image", () => {
  it("turns relay drawing commands into a nonblank PNG data URL", () => {
    const commands: CanvasCommand[] = [
      {
        type: "stroke",
        id: "house",
        tool: "pen",
        color: "#202124",
        fillColor: "#f2c84b",
        closed: true,
        width: 8,
        points: [
          { x: 260, y: 560 },
          { x: 260, y: 360 },
          { x: 500, y: 180 },
          { x: 740, y: 360 },
          { x: 740, y: 560 }
        ],
        offsetMs: 0
      },
      { type: "finish", id: "finish", offsetMs: 1 }
    ];

    const imageDataUrl = commandsToServerAiImageDataUrl(commands);
    const png = decodeBase64(imageDataUrl.replace("data:image/png;base64,", ""));

    expect(imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(png.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(readUint32(png, 16)).toBe(SERVER_AI_IMAGE_SIZE.width);
    expect(readUint32(png, 20)).toBe(SERVER_AI_IMAGE_SIZE.height);
    const scanlines = rawScanlines(png);
    const paper = [247, 248, 250];
    let hasInk = false;
    const rowLength = SERVER_AI_IMAGE_SIZE.width * 4 + 1;
    for (let y = 0; y < SERVER_AI_IMAGE_SIZE.height && !hasInk; y += 1) {
      for (let offset = y * rowLength + 1; offset < (y + 1) * rowLength; offset += 4) {
        if (
          scanlines[offset] !== paper[0] ||
          scanlines[offset + 1] !== paper[1] ||
          scanlines[offset + 2] !== paper[2]
        ) {
          hasInk = true;
          break;
        }
      }
    }
    expect(hasInk).toBe(true);
  });

  it("renders every brush preset deterministically with distinct texture", () => {
    const render = (brushPreset: "ink" | "pencil" | "marker" | "paint") =>
      commandsToServerAiImageDataUrl([
        {
          type: "stroke",
          id: "expressive-stroke",
          tool: "pen",
          brushPreset,
          color: "#3f7edb",
          width: 28,
          points: [
            { x: 120, y: 540 },
            { x: 350, y: 180 },
            { x: 620, y: 570 },
            { x: 880, y: 240 }
          ],
          offsetMs: 0
        },
        { type: "finish", id: "finish", offsetMs: 1 }
      ]);

    const rendered = ["ink", "pencil", "marker", "paint"].map((preset) =>
      render(preset as "ink" | "pencil" | "marker" | "paint")
    );
    expect(new Set(rendered).size).toBe(4);
    expect(render("pencil")).toBe(render("pencil"));
  });
});
