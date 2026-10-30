function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function zipFiles(files: { name: string; data: Uint8Array; store?: boolean }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const file of files) {
    const name = enc.encode(file.name);
    const stored = !!file.store || file.data.length === 0;
    const payload = stored ? file.data : await deflateRaw(file.data);
    const method = stored ? 0 : 8;
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, method, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, payload);
    const cen = new Uint8Array(46 + name.length);
    const cview = new DataView(cen.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 20, true);
    cview.setUint16(6, 20, true);
    cview.setUint16(10, method, true);
    cview.setUint32(16, crc, true);
    cview.setUint32(20, payload.length, true);
    cview.setUint32(24, file.data.length, true);
    cview.setUint16(28, name.length, true);
    cview.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + payload.length;
  }
  let cenSize = 0;
  for (const c of central) cenSize += c.length;
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);
  eview.setUint16(8, files.length, true);
  eview.setUint16(10, files.length, true);
  eview.setUint32(12, cenSize, true);
  eview.setUint32(16, offset, true);
  return concat([...parts, ...central, end]);
}

export async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  const min = Math.max(0, data.length - 22 - 65536);
  for (let i = data.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("bad zip");
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = view.getUint16(ptr + 10, true);
    const comp = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extra = view.getUint16(ptr + 30, true);
    const comment = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = dec.decode(data.subarray(ptr + 46, ptr + 46 + nameLen));
    const localName = view.getUint16(localOff + 26, true);
    const localExtra = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + localName + localExtra;
    const slice = data.subarray(start, start + comp);
    const raw = method === 0 ? slice : method === 8 ? await inflateRaw(slice) : null;
    if (!raw) throw new Error("unsupported zip method " + method);
    out.set(name, raw);
    ptr += 46 + nameLen + extra + comment;
  }
  return out;
}
