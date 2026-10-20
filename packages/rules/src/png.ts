import { inflateSync } from 'node:zlib';

/**
 * Decode a browser screenshot PNG to RGBA rows. Only what Chromium writes is supported: 8-bit
 * truecolor with or without alpha, not interlaced. Anything else returns undefined, and rules
 * reading pixels then stay with what the DOM alone can decide.
 */
export function decodePng(png: Uint8Array): { width: number; height: number; data: Uint8Array } | undefined {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 33 || view.getUint32(0) !== 0x89504e47) return undefined;
  let width = 0,
    height = 0,
    channels = 0;
  const parts: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at),
      type = String.fromCharCode(...png.subarray(at + 4, at + 8)),
      body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (depth !== 8 || !channels || interlace) return undefined;
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!width || !height || !parts.length) return undefined;
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return undefined;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
      out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[out + x - channels] : 0,
        up = y ? rows[out - stride + x] : 0,
        corner = y && x >= channels ? rows[out - stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner,
          pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) return undefined;
      rows[out + x] = value & 255;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    data[j] = rows[i];
    data[j + 1] = rows[i + 1];
    data[j + 2] = rows[i + 2];
    data[j + 3] = 255;
  }
  return { width, height, data };
}
