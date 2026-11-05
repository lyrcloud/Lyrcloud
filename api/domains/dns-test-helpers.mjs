// Test helpers: build DNS queries and read responses in wire format.
import { TYPES } from './lyrdns.mjs';

// A DNS query in wire format, as a browser's DoH client would send it.
export function wireQuery(name, type = 'A', id = 0x1234) {
  const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  const qname = Buffer.concat([...name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPES[type], 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, qname, tail]);
}

// Decodes a response far enough to check it: rcode, flags and answers.
export function readResponse(buf) {
  let offset = 12;
  const name = () => {
    const labels = [];
    let end = null;
    let at = offset;
    for (;;) {
      const len = buf[at];
      if (len === 0) { at += 1; break; }
      if ((len & 0xc0) === 0xc0) { end ??= at + 2; at = ((len & 0x3f) << 8) | buf[at + 1]; continue; }
      labels.push(buf.toString('latin1', at + 1, at + 1 + len));
      at += 1 + len;
    }
    offset = end ?? at;
    return labels.join('.');
  };
  const typeName = (code) => Object.keys(TYPES).find((key) => TYPES[key] === code);
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((at) => buf.readUInt16BE(at));
  for (let i = 0; i < counts[0]; i += 1) { name(); offset += 4; }
  const records = [];
  for (let i = 0; i < counts[1] + counts[2]; i += 1) {
    const owner = name();
    const type = typeName(buf.readUInt16BE(offset));
    const ttl = buf.readUInt32BE(offset + 4);
    const length = buf.readUInt16BE(offset + 8);
    offset += 10;
    const start = offset;
    let value;
    if (type === 'A') value = [...buf.subarray(offset, offset + 4)].join('.');
    else if (type === 'AAAA') value = buf.subarray(offset, offset + 16).toString('hex');
    else if (type === 'CNAME') value = name();
    else if (type === 'MX') { const pref = buf.readUInt16BE(offset); offset += 2; value = `${pref} ${name()}`; }
    else if (type === 'TXT') { const parts = []; let at = offset; while (at < start + length) { parts.push(buf.toString('utf8', at + 1, at + 1 + buf[at])); at += 1 + buf[at]; } value = parts.join(''); }
    else value = type;
    offset = start + length;
    records.push({ section: i < counts[1] ? 'answer' : 'authority', name: owner, type, ttl, value });
  }
  return { id: buf.readUInt16BE(0), qr: Boolean(flags & 0x8000), aa: Boolean(flags & 0x0400), rd: Boolean(flags & 0x0100), ra: Boolean(flags & 0x0080), rcode: flags & 0xf, answers: records.filter((r) => r.section === 'answer'), authority: records.filter((r) => r.section === 'authority') };
}
