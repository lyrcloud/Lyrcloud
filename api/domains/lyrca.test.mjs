// The Lyr Root CA: certificates chain to the root, and the root can't vouch for anything outside .lyr.
// The chain checks use OpenSSL when it's installed (Node can't verify name constraints by itself).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRoot, issueCertificate, publicKeyFrom } from './lyrca.mjs';

const root = createRoot();
const issue = (options) => issueCertificate({ caKeyPem: root.keyPem, caCertPem: root.certPem, name: 'shop.lyr', ...options });

let openssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  openssl = false;
}

function verify(certPem, hostname) {
  const dir = mkdtempSync(join(tmpdir(), 'lyrca-'));
  try {
    writeFileSync(join(dir, 'root.pem'), root.certPem);
    writeFileSync(join(dir, 'leaf.pem'), certPem);
    execFileSync('openssl', ['verify', '-CAfile', join(dir, 'root.pem'), '-purpose', 'sslserver', ...(hostname ? ['-verify_hostname', hostname] : []), join(dir, 'leaf.pem')], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the root is a CA limited to .lyr names', () => {
  const cert = new X509Certificate(root.certPem);
  assert.equal(cert.ca, true);
  assert.equal(cert.subject, 'O=Lyrcloud\nCN=Lyrcloud .lyr Root CA');
  assert.ok(cert.verify(cert.publicKey), 'self-signed');
  assert.ok(new Date(cert.validTo) > new Date(Date.now() + 15 * 365 * 86400_000));
});

test('certificates cover the name and its subdomains, with a key made for the holder', () => {
  const issued = issue();
  const cert = new X509Certificate(issued.certPem);
  assert.equal(cert.subjectAltName, 'DNS:shop.lyr, DNS:*.shop.lyr');
  assert.equal(cert.ca, false);
  assert.ok(cert.verify(new X509Certificate(root.certPem).publicKey));
  assert.match(issued.keyPem, /BEGIN PRIVATE KEY/);
  const days = (Date.parse(cert.validTo) - Date.now()) / 86400_000;
  assert.ok(days > 89 && days <= 90);
  assert.throws(() => issue({ name: 'google.com' }), /Only .lyr/);
});

test('holders can bring their own key or CSR, if it’s strong enough', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issued = issue({ publicKey: publicKeyFrom(publicKey.export({ type: 'spki', format: 'pem' })) });
  assert.equal(issued.keyPem, null);
  assert.ok(new X509Certificate(issued.certPem).publicKey.equals(publicKey));
  assert.throws(() => publicKeyFrom('hello'), /PEM/);
  assert.throws(() => publicKeyFrom(generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'pem' })), /P-256/);
  if (openssl) {
    const dir = mkdtempSync(join(tmpdir(), 'lyrca-'));
    try {
      const keyFile = join(dir, 'key.pem');
      writeFileSync(keyFile, generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const csr = execFileSync('openssl', ['req', '-new', '-key', keyFile, '-subj', '/CN=ignored.example'], { encoding: 'utf8' });
      const cert = new X509Certificate(issue({ publicKey: publicKeyFrom(csr) }).certPem);
      assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'secp384r1');
      assert.equal(cert.subject, 'CN=shop.lyr', 'the CSR’s own name is ignored');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('OpenSSL trusts .lyr certificates and rejects anything else the root signs', { skip: !openssl && 'openssl not installed' }, async () => {
  assert.ok(verify(issue().certPem, 'www.shop.lyr'));
  // Sign a google.com certificate with the real key by lifting the name check, as an attacker with the key could.
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'lyrca-'));
  try {
    const source = readFileSync(new URL('./lyrca.mjs', import.meta.url), 'utf8').replace(/if \(!\/\^\[a-z0-9-\]\+\\\.lyr\$\/\.test\(name\)\) throw/, 'if (false) throw');
    assert.ok(source.includes('if (false) throw'));
    writeFileSync(join(dir, 'unchecked.mjs'), source);
    const unchecked = await import(join(dir, 'unchecked.mjs'));
    const forged = unchecked.issueCertificate({ caKeyPem: root.keyPem, caCertPem: root.certPem, name: 'google.com' });
    assert.equal(verify(forged.certPem), false, 'the name constraint stops it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
