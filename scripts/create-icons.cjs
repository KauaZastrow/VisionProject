const fs = require("node:fs");
const path = require("node:path");

const outputDirectory = path.join(__dirname, "..", "assets");
fs.mkdirSync(outputDirectory, { recursive: true });

const width = 32;
const height = 32;
const imageWidth = 256;
const imageHeight = 256;
const scale = imageWidth / width;
const pixels = Buffer.alloc(imageWidth * imageHeight * 4);

function pixel(x, y, red, green, blue, alpha = 255) {
  for (let row = 0; row < scale; row += 1) {
    for (let column = 0; column < scale; column += 1) {
      const px = x * scale + column;
      const py = y * scale + row;
      if (px < 0 || py < 0 || px >= imageWidth || py >= imageHeight) continue;
      const offset = (py * imageWidth + px) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alpha;
    }
  }
}

function roundedRectangle(x, y, w, h, radius, color) {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      const cx = Math.max(x + radius, Math.min(px, x + w - radius - 1));
      const cy = Math.max(y + radius, Math.min(py, y + h - radius - 1));
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2) {
        pixel(px, py, ...color);
      }
    }
  }
}

function line(x1, y1, x2, y2, color, thickness = 2) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    roundedRectangle(
      x - Math.floor(thickness / 2),
      y - Math.floor(thickness / 2),
      thickness,
      thickness,
      1,
      color,
    );
  }
}

roundedRectangle(1, 1, 30, 30, 8, [23, 25, 35]);
roundedRectangle(5, 6, 22, 16, 4, [82, 100, 242]);
roundedRectangle(8, 9, 16, 10, 2, [238, 240, 255]);
line(13, 25, 19, 25, [238, 240, 255], 2);
line(16, 22, 16, 25, [238, 240, 255], 2);
line(10, 14, 14, 17, [82, 100, 242], 2);
line(14, 17, 21, 11, [82, 100, 242], 2);

function makePng(image, pngWidth, pngHeight) {
  const zlib = require("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  });

  function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(pngWidth, 0);
  header.writeUInt32BE(pngHeight, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(pngHeight * (1 + pngWidth * 4));
  for (let y = 0; y < pngHeight; y += 1) {
    const rowOffset = y * (1 + pngWidth * 4);
    scanlines[rowOffset] = 0;
    image.copy(
      scanlines,
      rowOffset + 1,
      y * pngWidth * 4,
      (y + 1) * pngWidth * 4,
    );
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function resize(size) {
  const resized = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.floor((y * imageHeight) / size);
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.floor((x * imageWidth) / size);
      const source = (sourceY * imageWidth + sourceX) * 4;
      const target = (y * size + x) * 4;
      pixels.copy(resized, target, source, source + 4);
    }
  }
  return resized;
}

const png = makePng(pixels, imageWidth, imageHeight);
fs.writeFileSync(path.join(outputDirectory, "icon.png"), png);

function makeIcnsChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(data.length + header.length, 4);
  return Buffer.concat([header, data]);
}

const icnsChunks = [
  makeIcnsChunk("ic07", makePng(resize(128), 128, 128)),
  makeIcnsChunk("ic08", png),
  makeIcnsChunk("ic09", makePng(resize(512), 512, 512)),
];
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, 4, "ascii");
icnsHeader.writeUInt32BE(
  icnsHeader.length + icnsChunks.reduce((total, chunk) => total + chunk.length, 0),
  4,
);
fs.writeFileSync(
  path.join(outputDirectory, "icon.icns"),
  Buffer.concat([icnsHeader, ...icnsChunks]),
);

const xorBitmap = Buffer.alloc(imageHeight * imageWidth * 4);
const andBitmap = Buffer.alloc(imageHeight * Math.ceil(imageWidth / 32) * 4);
for (let y = 0; y < imageHeight; y += 1) {
  for (let x = 0; x < imageWidth; x += 1) {
    const source = ((imageHeight - 1 - y) * imageWidth + x) * 4;
    const target = (y * imageWidth + x) * 4;
    xorBitmap[target] = pixels[source + 2];
    xorBitmap[target + 1] = pixels[source + 1];
    xorBitmap[target + 2] = pixels[source];
    xorBitmap[target + 3] = pixels[source + 3];
  }
}

const bitmapHeader = Buffer.alloc(40);
bitmapHeader.writeUInt32LE(40, 0);
bitmapHeader.writeInt32LE(imageWidth, 4);
bitmapHeader.writeInt32LE(imageHeight * 2, 8);
bitmapHeader.writeUInt16LE(1, 12);
bitmapHeader.writeUInt16LE(32, 14);
bitmapHeader.writeUInt32LE(xorBitmap.length + andBitmap.length, 20);
const bitmap = Buffer.concat([bitmapHeader, xorBitmap, andBitmap]);

const directory = Buffer.alloc(6 + 16);
directory.writeUInt16LE(0, 0);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(1, 4);
directory[6] = imageWidth;
directory[7] = imageHeight;
directory[8] = 0;
directory[9] = 0;
directory.writeUInt16LE(1, 10);
directory.writeUInt16LE(32, 12);
directory.writeUInt32LE(bitmap.length, 14);
directory.writeUInt32LE(directory.length, 18);
fs.writeFileSync(
  path.join(outputDirectory, "icon.ico"),
  Buffer.concat([directory, bitmap]),
);