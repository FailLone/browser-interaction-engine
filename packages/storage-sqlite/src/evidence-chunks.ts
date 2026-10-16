/** Independent content-defined ranges for text evidence. The rolling hash only
 * chooses boundaries: SHA-256 in the evidence store still verifies every byte.
 * There is no parent snapshot, patch chain, or semantic identity implied here.
 * Binary evidence retains the previous fixed-size layout.
 */
const minimum = 8192, maximum = 32768, boundaryMask = 8191;
const gear = new Uint32Array(256);
let seed = 0x6d2b79f5;
for (let i = 0; i < gear.length; i++) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  gear[i] = seed >>> 0;
}

export function* evidenceChunks(data: Uint8Array, contentDefined: boolean): Generator<Uint8Array> {
  if (!contentDefined) {
    for (let start = 0; start < data.length || start === 0; start += 16384) yield data.subarray(start, start + 16384);
    return;
  }
  if (data.length === 0) { yield data; return; }
  for (let start = 0; start < data.length;) {
    let end = Math.min(data.length, start + maximum), rolling = 0;
    // A 32-bit left-shift hash forgets bytes older than 32 positions. No cut is
    // permitted before minimum, so scanning that prefix cannot affect a cut.
    for (let offset = start + minimum - 32; offset < end; offset++) {
      rolling = ((rolling << 1) + gear[data[offset]]) >>> 0;
      if (offset + 1 - start >= minimum && (rolling & boundaryMask) === 0) { end = offset + 1; break; }
    }
    yield data.subarray(start, end); start = end;
  }
}
