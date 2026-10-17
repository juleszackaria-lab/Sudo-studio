/**
 * minizip.js - PROMPT 21 dependency-free ZIP writer/reader (stored only).
 *
 * The diagnostic export must produce a .zip with ZERO new dependency, so this
 * module implements the minimum of the ZIP format: stored (uncompressed)
 * entries with UTF-8 names, CRC32, central directory and EOCD. Output opens
 * in Explorer / `unzip` / Python zipfile. readZip() only reads back stored
 * entries (exactly what writeZip() produces) for hermetic roundtrip tests.
 * Pure Node (Buffer only), ASCII-only source.
 */
'use strict';

function crc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crc32Table();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const dt = d instanceof Date ? d : new Date();
  const time = ((dt.getHours() & 31) << 11) | ((dt.getMinutes() & 63) << 5) | ((Math.floor(dt.getSeconds() / 2)) & 31);
  const date = (((dt.getFullYear() - 1980) & 127) << 9) | (((dt.getMonth() + 1) & 15) << 5) | (dt.getDate() & 31);
  return { time, date };
}

function toBuf(data) {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(String(data === undefined || data === null ? '' : data), 'utf8');
}

function safeName(name) {
  return String(name || 'file').replace(/\\/g, '/').replace(/^\/*/, '').replace(/\.\./g, '_').slice(0, 200) || 'file';
}

// entries: [{ name, data }] -> Buffer (complete .zip file)
function writeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries || []) {
    const name = safeName(e.name);
    const data = toBuf(e.data);
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(new Date());
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);      // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE((entries || []).length, 8);
  end.writeUInt16LE((entries || []).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

// Minimal reader for stored-only zips (what writeZip produces). -> [{ name, data }]
function readZip(buf) {
  const out = [];
  let off = 0;
  while (off + 30 <= buf.length) {
    const sig = buf.readUInt32LE(off);
    if (sig === 0x06054b50) break; // EOCD
    if (sig === 0x02014b50) break; // central directory: done
    if (sig !== 0x04034b50) throw new Error('minizip: bad local header at ' + off);
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    if (method !== 0) throw new Error('minizip: only stored entries supported');
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const data = buf.slice(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + size);
    if (crc32(data) !== crc) throw new Error('minizip: CRC mismatch for ' + name);
    out.push({ name, data });
    off += 30 + nameLen + extraLen + size;
  }
  return out;
}

module.exports = { writeZip, readZip, crc32 };
