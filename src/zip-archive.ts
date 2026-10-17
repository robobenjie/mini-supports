import { inflateSync, unzipSync, zipSync, strToU8 } from 'fflate';

export interface ZipMember { name: string; compressed: Uint8Array; size: number; crc: number; method: number }
/** Read the ZIP directory once; inflate only the model currently being processed. */
export class ZipArchive {
  readonly members = new Map<string, ZipMember>();
  constructor(data: Uint8Array | Map<string, ZipMember>) {
    // A validated import can transfer its members from a temporary worker.
    if (data instanceof Map) { this.members = data; return; }
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let end = data.length - 22;
    while (end >= Math.max(0, data.length - 65557) && v.getUint32(end, true) !== 0x06054b50) end--;
    if (end < Math.max(0, data.length - 65557)) throw new Error('Invalid or truncated ZIP archive.');
    let offset = v.getUint32(end + 16, true);
    const count = v.getUint16(end + 10, true);
    if (count === 65535 || offset === 0xffffffff) {
      // fflate handles ZIP64. This uncommon fallback keeps large-file compatibility.
      for (const [name, bytes] of Object.entries(unzipSync(data))) this.members.set(name, { name, compressed: bytes, size: bytes.length, crc: 0, method: 0 });
      const rebuilt = new ZipArchive(zipSync(Object.fromEntries([...this.members].map(([name, m]) => [name, m.compressed])), { level: 1 }));
      this.members = rebuilt.members; return;
    }
    for (let i = 0; i < count; i++) {
      if (v.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
      if (v.getUint16(offset + 8, true) & 1) throw new Error('Encrypted 3MF archives are not supported.');
      const compressedSize = v.getUint32(offset + 20, true), size = v.getUint32(offset + 24, true);
      const n = v.getUint16(offset + 28, true), extra = v.getUint16(offset + 30, true), comment = v.getUint16(offset + 32, true);
      const local = v.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + n));
      if (this.members.has(name)) throw new Error('Duplicate ZIP path.');
      if (v.getUint32(local, true) !== 0x04034b50) throw new Error('Invalid ZIP member.');
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      if (start + compressedSize > data.length) throw new Error('Truncated ZIP member.');
      this.members.set(name, { name, compressed: data.subarray(start, start + compressedSize), size, crc: v.getUint32(offset + 16, true), method: v.getUint16(offset + 10, true) });
      offset += 46 + n + extra + comment;
    }
  }
  read(name: string) {
    const entry = this.members.get(name);
    if (!entry) throw new Error(`The 3MF is missing a referenced file: ${name}`);
    if (entry.method === 0) return entry.compressed;
    if (entry.method !== 8) throw new Error('Unsupported ZIP compression method.');
    return inflateSync(entry.compressed, { out: new Uint8Array(entry.size) });
  }
}
export function textMembers(files: Record<string, string>) {
  return [...new ZipArchive(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 1 })).members.values()];
}
/** Reuse original compressed mesh bytes: no re-serialization or recompression of sculpture detail. */
export function packMembers(members: ZipMember[]): Uint8Array {
  const names = members.map(m => strToU8(m.name));
  const localSize = members.reduce((n, m, i) => n + 30 + names[i].length + m.compressed.length, 0);
  const centralSize = members.reduce((n, _, i) => n + 46 + names[i].length, 0);
  if (localSize + centralSize + 22 > 0xffffffff || members.length >= 65535) throw new Error('This export requires ZIP64, which is not yet supported.');
  const data = new Uint8Array(localSize + centralSize + 22), view = new DataView(data.buffer);
  let local = 0, central = localSize;
  members.forEach((m, i) => {
    const name = names[i];
    view.setUint32(local, 0x04034b50, true); view.setUint16(local + 4, 20, true); view.setUint16(local + 6, 0x800, true);
    view.setUint16(local + 8, m.method, true); view.setUint32(local + 14, m.crc, true);
    view.setUint32(local + 18, m.compressed.length, true); view.setUint32(local + 22, m.size, true); view.setUint16(local + 26, name.length, true);
    data.set(name, local + 30); data.set(m.compressed, local + 30 + name.length);
    view.setUint32(central, 0x02014b50, true); view.setUint16(central + 4, 20, true); view.setUint16(central + 6, 20, true); view.setUint16(central + 8, 0x800, true);
    view.setUint16(central + 10, m.method, true); view.setUint32(central + 16, m.crc, true);
    view.setUint32(central + 20, m.compressed.length, true); view.setUint32(central + 24, m.size, true); view.setUint16(central + 28, name.length, true); view.setUint32(central + 42, local, true);
    data.set(name, central + 46);
    local += 30 + name.length + m.compressed.length; central += 46 + name.length;
  });
  view.setUint32(central, 0x06054b50, true); view.setUint16(central + 8, members.length, true); view.setUint16(central + 10, members.length, true);
  view.setUint32(central + 12, centralSize, true); view.setUint32(central + 16, localSize, true);
  return data;
}
