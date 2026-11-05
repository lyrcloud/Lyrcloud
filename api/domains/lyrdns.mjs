// The .lyr namespace (preview): a private top-level domain that Lyrcloud answers for itself. It isn't
// delegated by ICANN, so .lyr names only resolve for people whose device or browser uses Lyrcloud's
// DNS-over-HTTPS resolver (RFC 8484). That resolver answers .lyr questions from the registry and
// passes every other question to a public resolver unchanged.
//
// This file is pure: DNS wire-format parsing/encoding and the .lyr answer logic. index.mjs wires it to
// DynamoDB (the registry) and the upstream resolver.

export const LYR_TLD = 'lyr';
export const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, ANY: 255 };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([name, code]) => [code, name]));
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
const NEGATIVE_TTL = 300;
// Labels people can't hold: they'd be confusing or are kept for Lyrcloud itself.
export const RESERVED_LYR = ['nic', 'dns', 'www', 'whois', 'registry', 'lyr', 'lyrcloud', 'admin', 'localhost', 'example', 'test', 'invalid'];

const LYR_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lyr$/;

// "Shop.LYR." -> "shop.lyr"; null if it isn't a valid second-level .lyr name.
export function cleanLyrName(input) {
  const name = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  const full = name.endsWith('.lyr') ? name : `${name}.lyr`;
  if (!LYR_NAME_RE.test(full)) return null;
  const label = full.slice(0, -4);
  if (label.slice(2, 4) === '--' && !label.startsWith('xn--')) return null;
  return full;
}

export const isReservedLyr = (name) => RESERVED_LYR.includes(name.slice(0, -4));

// The registered .lyr name a query falls under: "www.shop.lyr" -> "shop.lyr", "lyr" -> null.
export function registeredLyrName(qname) {
  const labels = qname.split('.');
  if (labels.length < 2 || labels.at(-1) !== LYR_TLD) return null;
  return `${labels.at(-2)}.${LYR_TLD}`;
}

export const isLyrQuestion = (qname) => qname === LYR_TLD || qname.endsWith(`.${LYR_TLD}`);

// ---------------------------------------------------------------- wire format

export class DnsFormatError extends Error {}

function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let end = offset;
  for (let guard = 0; guard < 128; guard += 1) {
    if (offset >= buf.length) throw new DnsFormatError('name runs past the message');
    const length = buf[offset];
    if (length === 0) {
      if (!jumped) end = offset + 1;
      return { name: labels.join('.').toLowerCase(), end };
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) throw new DnsFormatError('bad pointer');
      if (!jumped) end = offset + 2;
      offset = ((length & 0x3f) << 8) | buf[offset + 1];
      jumped = true;
      continue;
    }
    if (length > 63 || offset + 1 + length > buf.length) throw new DnsFormatError('bad label');
    labels.push(buf.toString('latin1', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  throw new DnsFormatError('name loops');
}

// Parses the header and first question of a DNS query.
export function parseQuery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new DnsFormatError('message too short');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  if (flags & 0x8000) throw new DnsFormatError('not a query');
  if (qdcount !== 1) throw new DnsFormatError('expected one question');
  const { name, end } = readName(buf, 12);
  if (end + 4 > buf.length) throw new DnsFormatError('question truncated');
  return {
    id,
    opcode: (flags >> 11) & 0xf,
    rd: Boolean(flags & 0x0100),
    qname: name,
    qtype: buf.readUInt16BE(end),
    qclass: buf.readUInt16BE(end + 2),
    question: buf.subarray(12, end + 4),
  };
}

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const chunks = parts.map((label) => {
    const bytes = Buffer.from(label, 'latin1');
    if (bytes.length > 63) throw new Error(`label too long: ${label}`);
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...chunks, Buffer.from([0])]);
}

export function ipv6Bytes(text) {
  const [head, tail = null] = text.split('::');
  if (text.split('::').length > 2) throw new Error('bad IPv6');
  const left = head ? head.split(':') : [];
  const right = tail === null ? [] : tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === null ? missing !== 0 : missing < 1) throw new Error('bad IPv6');
  const groups = [...left, ...Array(tail === null ? 0 : missing).fill('0'), ...right];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) throw new Error('bad IPv6');
  const out = Buffer.alloc(16);
  groups.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16), i * 2));
  return out;
}

function rdata(type, value) {
  switch (type) {
    case 'A': return Buffer.from(value.split('.').map(Number));
    case 'AAAA': return ipv6Bytes(value);
    case 'CNAME':
    case 'NS': return encodeName(value);
    case 'MX': {
      const [preference, host] = value.split(/\s+/);
      const pref = Buffer.alloc(2);
      pref.writeUInt16BE(Number(preference));
      return Buffer.concat([pref, encodeName(host)]);
    }
    case 'TXT': {
      const chunks = String(value).match(/[\s\S]{1,255}/g) || [''];
      return Buffer.concat(chunks.map((chunk) => {
        const bytes = Buffer.from(chunk, 'utf8').subarray(0, 255);
        return Buffer.concat([Buffer.from([bytes.length]), bytes]);
      }));
    }
    case 'SOA': {
      const numbers = Buffer.alloc(20);
      [value.serial, value.refresh, value.retry, value.expire, value.minimum].forEach((n, i) => numbers.writeUInt32BE(n >>> 0, i * 4));
      return Buffer.concat([encodeName(value.mname), encodeName(value.rname), numbers]);
    }
    default: throw new Error(`can't encode ${type}`);
  }
}

function encodeRecord({ name, type, ttl, value }) {
  const data = rdata(type, value);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(TYPES[type], 0);
  fixed.writeUInt16BE(1, 2); // IN
  fixed.writeUInt32BE(Math.max(0, Math.floor(ttl)) >>> 0, 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), fixed, data]);
}

// Builds a response to `query` with the given answers and authority records.
export function buildResponse(query, { rcode = RCODE.NOERROR, answers = [], authority = [], authoritative = false } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query?.id ?? 0, 0);
  const flags = 0x8000 | ((query?.opcode ?? 0) << 11) | (authoritative ? 0x0400 : 0) | (query?.rd ? 0x0100 : 0) | 0x0080 | (rcode & 0xf);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(query?.question ? 1 : 0, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authority.length, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([header, query?.question || Buffer.alloc(0), ...answers.map(encodeRecord), ...authority.map(encodeRecord)]);
}

// ---------------------------------------------------------------- .lyr answers

export const lyrSoa = (zone = LYR_TLD) => ({
  name: zone,
  type: 'SOA',
  ttl: NEGATIVE_TTL,
  value: { mname: 'ns.lyrcloud.com', rname: 'hostmaster.lyrcloud.com', serial: Math.floor(Date.now() / 1000), refresh: 3600, retry: 600, expire: 604800, minimum: NEGATIVE_TTL },
});

// Records stored for a .lyr name (rules.mjs shape: { type, name, values[], ttl }) that answer `qname`.
// Exact names win over a "*.name" wildcard, as in normal DNS.
function recordsAt(entry, qname) {
  const records = entry.records || [];
  const exact = records.filter((record) => record.name === qname);
  if (exact.length) return { records: exact, owner: qname };
  const wildcard = `*.${qname.split('.').slice(1).join('.')}`;
  // A name with records below it exists (an "empty non-terminal"), so the wildcard doesn't cover it.
  const exists = records.some((record) => record.name.endsWith(`.${qname}`));
  const wild = qname !== entry.name && !exists ? records.filter((record) => record.name === wildcard) : [];
  return { records: wild, owner: qname };
}

const toAnswers = (records, owner) => records.flatMap((record) => record.values.map((value) => ({ name: owner, type: record.type, ttl: record.ttl ?? 300, value })));

// Answers a .lyr question. `entry` is the registry item for the name ({ name, records }) or null.
// `chase(target, type)` resolves a CNAME target outside .lyr and returns answer records.
export async function answerLyr(query, entry, chase, lookupLyr) {
  const { qname, qtype } = query;
  const typeName = TYPE_NAMES[qtype];
  if (qname === LYR_TLD) {
    return { rcode: RCODE.NOERROR, answers: qtype === TYPES.SOA ? [lyrSoa()] : [], authority: qtype === TYPES.SOA ? [] : [lyrSoa()], authoritative: true };
  }
  if (!entry) return { rcode: RCODE.NXDOMAIN, authority: [lyrSoa()], authoritative: true };
  const { records, owner } = recordsAt(entry, qname);
  if (!records.length) {
    // The name exists (it's registered) but has nothing here: NODATA for the name itself, NXDOMAIN below it
    // unless something lives deeper.
    const deeper = (entry.records || []).some((record) => record.name.endsWith(`.${qname}`));
    const rcode = qname === entry.name || deeper ? RCODE.NOERROR : RCODE.NXDOMAIN;
    return { rcode, authority: [lyrSoa(entry.name)], authoritative: true };
  }
  const cname = records.find((record) => record.type === 'CNAME');
  if (cname && typeName !== 'CNAME') {
    const answers = toAnswers([cname], owner);
    const target = cname.values[0].replace(/\.$/, '').toLowerCase();
    if (isLyrQuestion(target)) {
      const inner = await lookupLyr(target);
      const followed = inner ? recordsAt(inner, target) : { records: [] };
      answers.push(...toAnswers(followed.records.filter((record) => record.type === typeName), target));
    } else if (typeName && typeName !== 'ANY') {
      answers.push(...(await chase(target, typeName)));
    }
    return { rcode: RCODE.NOERROR, answers, authoritative: true };
  }
  const matching = typeName === 'ANY' ? records : records.filter((record) => record.type === typeName);
  if (!matching.length) return { rcode: RCODE.NOERROR, authority: [lyrSoa(entry.name)], authoritative: true };
  return { rcode: RCODE.NOERROR, answers: toAnswers(matching, owner), authoritative: true };
}

// dns.google's JSON answers (for CNAME chasing) -> our answer records, keeping only types we can encode.
export function fromJsonAnswers(answers) {
  return (answers || [])
    .map((answer) => ({ name: String(answer.name).replace(/\.$/, ''), type: TYPE_NAMES[answer.type], ttl: answer.TTL ?? 300, value: String(answer.data) }))
    .filter((answer) => ['A', 'AAAA', 'CNAME', 'MX', 'TXT'].includes(answer.type))
    .map((answer) => ({
      ...answer,
      value: answer.type === 'CNAME' || answer.type === 'MX' ? answer.value.replace(/\.$/, '') : answer.type === 'TXT' ? answer.value.replace(/^"|"$/g, '') : answer.value,
    }));
}

// Validates the record list for a .lyr name. Returns [status, message] or null. Uses rules.mjs checks.
export function lyrRecordsError(records, name, recordError) {
  if (!Array.isArray(records) || records.length > 50) return [400, 'Send at most 50 record sets.'];
  for (const record of records) {
    const refused = recordError(record, name);
    if (refused) return refused;
  }
  return null;
}
