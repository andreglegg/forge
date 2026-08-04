#!/usr/bin/env node
/**
 * Render docs/assets/forge-mono.png into truecolor half-block ANSI, once, at
 * build time, and write it into src/logo.ts as a constant.
 *
 * Two decisions worth the paragraph:
 *
 * **Build time, not runtime.** The logo never changes while the CLI is
 * running, so decoding a 1024x1024 PNG on every `forge` start is work done
 * repeatedly to produce a value that was already known. The generated constant
 * costs nothing to print.
 *
 * **No image library.** `sharp` is a native build on every install target, and
 * this package rejected `better-sqlite3` for exactly that reason. A PNG at
 * bitdepth 8, colour type 6, non-interlaced -- which this one is -- is zlib
 * plus five defilter cases, and Node ships zlib. The alternative is a
 * compile step in everyone's install for one picture.
 *
 * Each character is two vertical pixels: the upper half is the foreground and
 * the lower half is the background of `▀`. That is what makes the aspect ratio
 * come out right, since a terminal cell is about twice as tall as it is wide.
 *
 *   node scripts/render-logo.mjs [width]
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, "..", "..", "docs", "assets", "forge-mono.png");
const TARGET = path.resolve(HERE, "..", "src", "logo.ts");

/** Minimal PNG reader: bitdepth 8, colour type 2 or 6, no interlacing. */
function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + crc

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colourType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(
          `unsupported PNG: depth ${depth}, colour ${colourType}, interlace ${interlace}`,
        );
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Defilter. Each scanline is prefixed by its filter type and is decoded
  // against the already-decoded line above it, so this cannot be parallelised
  // and must run in order.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[i - channels] : 0; // left
      const b = prior ? prior[i] : 0; // above
      const c = prior && i >= channels ? prior[i - channels] : 0; // upper-left
      const x = line[i];
      switch (filter) {
        case 0:
          out[i] = x;
          break;
        case 1:
          out[i] = (x + a) & 0xff;
          break;
        case 2:
          out[i] = (x + b) & 0xff;
          break;
        case 3:
          out[i] = (x + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          // Paeth: pick whichever neighbour the gradient predicts.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out[i] = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
    }
  }
  return { width, height, channels, pixels };
}

/** Box-average a source region down to one output pixel, over black. */
function sample(image, x0, y0, x1, y1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * image.width + x) * image.channels;
      const alpha = image.channels === 4 ? image.pixels[i + 3] / 255 : 1;
      // Composited over black, which is what the mark is drawn against.
      r += image.pixels[i] * alpha;
      g += image.pixels[i + 1] * alpha;
      b += image.pixels[i + 2] * alpha;
      n += 1;
    }
  }
  return n === 0 ? [0, 0, 0] : [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function render(image, columns) {
  // Two image rows per character row, so the picture is not squashed.
  const rows = Math.round((columns * (image.height / image.width)) / 2) * 2;
  const cellW = image.width / columns;
  const cellH = image.height / rows;
  const lines = [];

  for (let row = 0; row < rows; row += 2) {
    let line = "";
    let lastTop = null;
    let lastBottom = null;
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.floor(column * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((column + 1) * cellW));
      const top = sample(image, x0, Math.floor(row * cellH), x1, Math.floor((row + 1) * cellH));
      const bottom = sample(
        image,
        x0,
        Math.floor((row + 1) * cellH),
        x1,
        Math.floor((row + 2) * cellH),
      );
      // Only emit a colour when it changes: the mark is mostly flat, and this
      // roughly halves the size of the constant that gets shipped.
      if (lastTop === null || top.join() !== lastTop) {
        line += `[38;2;${top[0]};${top[1]};${top[2]}m`;
        lastTop = top.join();
      }
      if (lastBottom === null || bottom.join() !== lastBottom) {
        line += `[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m`;
        lastBottom = bottom.join();
      }
      line += "▀";
    }
    lines.push(`${line}[0m`);
  }
  return lines;
}

const columns = Number.parseInt(process.argv[2] ?? "44", 10);
const image = decodePng(readFileSync(SOURCE));

// Crop the transparent margin: the source is a small mark inside a large
// square, and rendering the padding would waste most of the terminal rows on
// nothing. Found by scanning for the first row and column carrying any light.
let top = image.height;
let bottom = 0;
let left = image.width;
let right = 0;
for (let y = 0; y < image.height; y += 1) {
  for (let x = 0; x < image.width; x += 1) {
    const i = (y * image.width + x) * image.channels;
    const lit =
      (image.channels === 4 ? image.pixels[i + 3] : 255) > 8 &&
      image.pixels[i] + image.pixels[i + 1] + image.pixels[i + 2] > 40;
    if (lit) {
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
}
const cropped = {
  width: right - left + 1,
  height: bottom - top + 1,
  channels: image.channels,
  pixels: Buffer.alloc((right - left + 1) * (bottom - top + 1) * image.channels),
};
for (let y = 0; y < cropped.height; y += 1) {
  image.pixels.copy(
    cropped.pixels,
    y * cropped.width * image.channels,
    ((y + top) * image.width + left) * image.channels,
    ((y + top) * image.width + right + 1) * image.channels,
  );
}

const lines = render(cropped, columns);
writeFileSync(
  TARGET,
  `/**
 * The mark, pre-rendered from docs/assets/forge-mono.png.
 *
 * Generated by scripts/render-logo.mjs — do not edit by hand. Regenerate with:
 *
 *     node scripts/render-logo.mjs [columns]
 *
 * Truecolor half-blocks: each character is two vertical pixels, the upper half
 * as foreground and the lower as background of U+2580. Pre-rendered rather
 * than decoded at startup, because the picture is the same every time and a
 * CLI should not do image processing to print its own name.
 */
export const LOGO_COLUMNS = ${columns};

export const LOGO_TRUECOLOR: readonly string[] = ${JSON.stringify(lines, null, 2)};
`,
  "utf8",
);
process.stderr.write(`wrote ${lines.length} rows x ${columns} cols -> ${TARGET}\n`);
lines.forEach((line) => {
  process.stdout.write(`${line}\n`);
});
