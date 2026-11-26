// A small zip writer and reader with no dependencies, shared by the Lyrcloud CLI (cli/lib/zip.mjs is an
// identical copy; a test keeps them the same) and the Edge Functions API.
//
//   createZip([{ name, data }])  -> Buffer    a new archive (deflated entries)
//   listZip(buffer)              -> [{ name, size, compressedSize }]
//   addZipEntry(buffer, name, data) -> Buffer  the archive with one more file, the rest copied untouched
//
// Only plain archives: no zip64, encryption or multi-disk sets (Lambda packages here are a few MB).
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// 1 January 2000, so archives built from the same files are byte-for-byte the same.
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const FILE_MODE = 0o100644;

function entry(name, data) {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const deflated = deflateRawSync(raw, { level: 9 });
  const stored = deflated.length >= raw.length;
  const body = stored ? raw : deflated;
  const crc = crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_FLAG, 6);
  local.writeUInt16LE(stored ? 0 : 8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  const central = (offset) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, so the file mode below counts
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(((FILE_MODE << 16) >>> 0), 38);
    header.writeUInt32LE(offset, 42);
    return Buffer.concat([header, nameBytes]);
  };
  return { local: Buffer.concat([local, nameBytes, body]), central };
}

function endRecord(count, centralSize, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return end;
}

export function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const built = entry(file.name, file.data);
    centrals.push(built.central(offset));
    locals.push(built.local);
    offset += built.local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, endRecord(files.length, central.length, offset)]);
}

export class ZipError extends Error {}

function findEnd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return { at: i, count: buf.readUInt16LE(i + 10), size: buf.readUInt32LE(i + 12), offset: buf.readUInt32LE(i + 16) };
    }
  }
  throw new ZipError('This isn’t a zip archive.');
}

function centralEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('This isn’t a zip archive.');
  const end = findEnd(buf);
  if (end.count === 0xffff || end.offset === 0xffffffff) throw new ZipError('Zip64 archives aren’t supported.');
  if (end.offset + end.size > end.at) throw new ZipError('The zip archive is damaged.');
  const entries = [];
  let p = end.offset;
  for (let i = 0; i < end.count; i += 1) {
    if (p + 46 > end.at || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip archive is damaged.');
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      flags: buf.readUInt16LE(p + 8),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return { end, entries };
}

export function listZip(buf) {
  const { entries } = centralEntries(buf);
  for (const item of entries) if (item.flags & 1) throw new ZipError('Encrypted zip archives aren’t supported.');
  return entries.map(({ name, size, compressedSize }) => ({ name, size, compressedSize }));
}

// Appends one file: the existing file records stay where they are, the new one goes after them, and
// the central directory is written again with the new entry at the end.
export function addZipEntry(buf, name, data) {
  const { end } = centralEntries(buf);
  const built = entry(name, data);
  const oldCentral = buf.subarray(end.offset, end.offset + end.size);
  const newCentral = Buffer.concat([oldCentral, built.central(end.offset)]);
  const centralOffset = end.offset + built.local.length;
  return Buffer.concat([buf.subarray(0, end.offset), built.local, newCentral, endRecord(end.count + 1, newCentral.length, centralOffset)]);
}
