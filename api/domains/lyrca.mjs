// The Lyr Root CA: HTTPS certificates for .lyr names. Public CAs only issue for ICANN names, so .lyr gets its
// own certificate authority. People who use .lyr install its root next to Lyrcloud DNS (the /lyr/ page and
// lyr.mobileconfig). The root carries a critical name constraint: it can only vouch for names under .lyr,
// never an IP address, and browsers (Chrome, Firefox, Safari) refuse anything else it signs, so installing it
// can't put any other site at risk even if its key leaked.
//
// Pure: X.509 DER encoding with node:crypto signing, no dependencies. index.mjs keeps the root key in
// Secrets Manager (lyrcloud/lyr-ca); scripts/lyr-root-ca.mjs creates it once.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

export const ROOT_SUBJECT = [['O', 'Lyrcloud'], ['CN', 'Lyrcloud .lyr Root CA']];
export const LEAF_DAYS = 90;
const ROOT_YEARS = 20;

// ---------------------------------------------------------------- DER

function tlv(tag, content) {
  const body = Buffer.concat([].concat(content));
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 0xff]) : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...items) => tlv(0x30, items);
const set = (...items) => tlv(0x31, items);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const octets = (bytes) => tlv(0x04, bytes);
const bits = (bytes, unused = 0) => tlv(0x03, [Buffer.from([unused]), bytes]);
const explicit = (n, inner) => tlv(0xa0 | n, inner);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));

// A positive INTEGER from a non-negative number or big-endian bytes.
function int(value) {
  let bytes = Buffer.isBuffer(value) ? value : Buffer.from((value.toString(16).length % 2 ? '0' : '') + value.toString(16), 'hex');
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && !(bytes[i + 1] & 0x80)) i += 1;
  bytes = bytes.subarray(i);
  return tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// UTCTime until 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const ATTRIBUTE = { CN: '2.5.4.3', O: '2.5.4.10' };
const nameDer = (rdns) => seq(...rdns.map(([type, value]) => set(seq(oid(ATTRIBUTE[type]), utf8(value)))));

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  nameConstraints: '2.5.29.30',
};
const SIG_ALG = seq(oid(OID.ecdsaSha256));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

// KeyUsage bits, numbered as in RFC 5280: digitalSignature(0), keyEncipherment(2), keyCertSign(5), cRLSign(6).
function keyUsage(...numbers) {
  let byte = 0;
  for (const n of numbers) byte |= 0x80 >> n;
  const unused = Math.min(...numbers.map((n) => 7 - n));
  return bits(Buffer.from([byte]), unused);
}

// Key identifier: the first 20 bytes of SHA-256 over the SubjectPublicKeyInfo (RFC 7093, method 4 style).
export const keyId = (spkiDer) => createHash('sha256').update(spkiDer).digest().subarray(0, 20);
const spkiOf = (key) => (key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'der' });
const serial = () => {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  bytes[0] |= 0x01;
  return bytes;
};

function signCertificate(tbs, caKey) {
  const signature = sign('sha256', tbs, { key: caKey, dsaEncoding: 'der' });
  return seq(tbs, SIG_ALG, bits(signature));
}

const pem = (der, label = 'CERTIFICATE') => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

// ---------------------------------------------------------------- root

// The root's name constraints: only .lyr names (dNSName "lyr" and everything below it), and no IP address at
// all (excluded 0.0.0.0/0 and ::/0), so a certificate it signs can't be used for anything else.
function lyrOnly() {
  const subtree = (generalName) => seq(generalName);
  const permitted = tlv(0xa0, subtree(tlv(0x82, Buffer.from('lyr'))));
  const excluded = tlv(0xa1, [subtree(tlv(0x87, Buffer.alloc(8))), subtree(tlv(0x87, Buffer.alloc(32)))]);
  return seq(permitted, excluded);
}

// Makes a new self-signed root: { keyPem, certPem }. Run once (scripts/lyr-root-ca.mjs); replacing it means
// everyone installs the root again.
export function createRoot({ now = new Date() } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = spkiOf(publicKey);
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + ROOT_YEARS);
  const subject = nameDer(ROOT_SUBJECT);
  const tbs = seq(
    explicit(0, int(2)),
    int(serial()),
    SIG_ALG,
    subject,
    seq(time(notBefore), time(notAfter)),
    subject,
    spki,
    explicit(3, seq(
      extension(OID.basicConstraints, true, seq(bool(true), int(0))),
      extension(OID.keyUsage, true, keyUsage(5, 6)),
      extension(OID.subjectKeyId, false, octets(keyId(spki))),
      extension(OID.nameConstraints, true, lyrOnly()),
    )),
  );
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certPem: pem(signCertificate(tbs, privateKey)),
  };
}

// ---------------------------------------------------------------- what customers send

// Reads one TLV at `offset`: { tag, start (of content), end }.
function readTlv(buf, offset) {
  if (offset + 2 > buf.length) throw new Error('truncated');
  const tag = buf[offset];
  let length = buf[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 3 || start + count > buf.length) throw new Error('bad length');
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | buf[start + i];
    start += count;
  }
  if (start + length > buf.length) throw new Error('truncated');
  return { tag, start, end: start + length };
}

const fromPem = (text, label) => {
  const match = String(text).match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`));
  return match ? Buffer.from(match[1].replace(/\s+/g, ''), 'base64') : null;
};

// The public key from a PEM public key or certificate signing request (PKCS #10), checked to be a key we sign
// for: EC P-256/P-384, or RSA of 2048 bits or more. The CSR's own name and extensions are ignored: the
// certificate covers the .lyr name it's issued for. Returns a KeyObject, or throws an Error with a message
// people can act on.
export function publicKeyFrom(text) {
  let key;
  const csr = fromPem(text, 'CERTIFICATE REQUEST') || fromPem(text, 'NEW CERTIFICATE REQUEST');
  try {
    if (csr) {
      // CertificationRequest { info { version, subject, subjectPKInfo, ... }, ... }
      const outer = readTlv(csr, 0);
      const info = readTlv(csr, outer.start);
      const version = readTlv(csr, info.start);
      const subject = readTlv(csr, version.end);
      const spki = readTlv(csr, subject.end);
      key = createPublicKey({ key: csr.subarray(subject.end, spki.end), format: 'der', type: 'spki' });
    } else {
      key = createPublicKey(String(text));
    }
  } catch {
    throw new Error('Paste a PEM certificate signing request (CSR) or public key.');
  }
  const details = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType === 'ec' && ['prime256v1', 'secp384r1'].includes(details.namedCurve)) return key;
  if (key.asymmetricKeyType === 'rsa' && details.modulusLength >= 2048) return key;
  throw new Error('Use an ECDSA P-256 or P-384 key, or an RSA key of at least 2048 bits.');
}

// ---------------------------------------------------------------- leaf certificates

// Issues a server certificate for `name` (a registered name like shop.lyr) and *.name, valid LEAF_DAYS days.
// Without `publicKey`, makes a new P-256 key and returns it too. Returns { certPem, chainPem, keyPem?,
// serial, notAfter }.
export function issueCertificate({ caKeyPem, caCertPem, name, publicKey, now = new Date() }) {
  if (!/^[a-z0-9-]+\.lyr$/.test(name)) throw new Error('Only .lyr names get Lyr certificates.');
  let keyPem = null;
  let key = publicKey;
  if (!key) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    key = pair.publicKey;
    keyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  }
  const caCert = new X509Certificate(caCertPem);
  const caSpki = caCert.publicKey.export({ type: 'spki', format: 'der' });
  const spki = spkiOf(key);
  const number = serial();
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + LEAF_DAYS * 86400_000);
  const rsa = key.asymmetricKeyType === 'rsa';
  const tbs = seq(
    explicit(0, int(2)),
    int(number),
    SIG_ALG,
    nameDer(ROOT_SUBJECT),
    seq(time(notBefore), time(notAfter)),
    nameDer([['CN', name]]),
    spki,
    explicit(3, seq(
      extension(OID.basicConstraints, true, seq()),
      extension(OID.keyUsage, true, rsa ? keyUsage(0, 2) : keyUsage(0)),
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectKeyId, false, octets(keyId(spki))),
      extension(OID.authorityKeyId, false, seq(tlv(0x80, keyId(caSpki)))),
      extension(OID.subjectAltName, false, seq(tlv(0x82, Buffer.from(name)), tlv(0x82, Buffer.from(`*.${name}`)))),
    )),
  );
  const certPem = pem(signCertificate(tbs, caKeyPem));
  return { certPem, chainPem: certPem + caCertPem, keyPem, serial: number.toString('hex'), notAfter: notAfter.toISOString() };
}
