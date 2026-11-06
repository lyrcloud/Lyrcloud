#!/usr/bin/env node
// Creates the Lyr Root CA once, after the lyrcloud-domains stack exists (bash scripts/deploy-domains.sh):
//
//   node scripts/lyr-root-ca.mjs
//
// The private key goes straight into Secrets Manager (lyrcloud/lyr-ca) and never into the repo. The public
// root certificate is written to public/lyr-root.crt and added to public/lyr.mobileconfig, so the next
// `bash scripts/deploy-live.sh` publishes it and the /lyr/ page shows the HTTPS setup steps.
//
// If the secret already holds a root, nothing new is made: the stored certificate is written out again
// (handy on a fresh checkout). Replacing a root means everyone installs it again, so that's never automatic.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createRoot } from '../api/domains/lyrca.mjs';

const SECRET = process.env.LYR_CA_SECRET || 'lyrcloud/lyr-ca';
const ROOT_FILE = 'public/lyr-root.crt';
const PROFILE = 'public/lyr.mobileconfig';
const aws = (...args) => execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

let stored = {};
try {
  stored = JSON.parse(aws('secretsmanager', 'get-secret-value', '--secret-id', SECRET, '--query', 'SecretString', '--output', 'text') || '{}');
} catch {
  console.error(`Couldn't read the ${SECRET} secret. Deploy the domains stack first: bash scripts/deploy-domains.sh`);
  process.exit(1);
}

let certPem = stored.certPem;
if (certPem) {
  console.log(`${SECRET} already holds a root; writing its certificate out again.`);
} else {
  const root = createRoot();
  const dir = mkdtempSync(join(tmpdir(), 'lyr-ca-'));
  const file = join(dir, 'secret.json');
  try {
    writeFileSync(file, JSON.stringify(root), { mode: 0o600 });
    aws('secretsmanager', 'put-secret-value', '--secret-id', SECRET, '--secret-string', `file://${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  certPem = root.certPem;
  console.log(`Made a new Lyr Root CA and stored its key in ${SECRET}.`);
}

writeFileSync(ROOT_FILE, certPem);
const cert = new X509Certificate(certPem);

// Apple devices: a root certificate payload in the same profile as Lyrcloud DNS. iOS also asks people to turn
// on full trust in Settings → General → About → Certificate Trust Settings.
const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s+/g, ''), 'base64').toString('base64').match(/.{1,52}/g).join('\n        ');
const payload = `    <dict>
      <!-- lyr-root: written by scripts/lyr-root-ca.mjs -->
      <key>PayloadCertificateFileName</key>
      <string>lyr-root.crt</string>
      <key>PayloadContent</key>
      <data>
        ${der}
      </data>
      <key>PayloadDisplayName</key>
      <string>Lyrcloud .lyr Root CA</string>
      <key>PayloadIdentifier</key>
      <string>com.lyrcloud.dns.root</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>3F0B6C52-6E0F-4E43-9C1D-7A1E5B2F9D10</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
`;
let profile = readFileSync(PROFILE, 'utf8').replace(/    <dict>\n      <!-- lyr-root:[\s\S]*?\n    <\/dict>\n/, '');
profile = profile.replace(/  <\/array>/, `${payload}  </array>`);
writeFileSync(PROFILE, profile);

console.log(`Wrote ${ROOT_FILE} and added the root to ${PROFILE}.`);
console.log(`  ${cert.subject.replace(/\n/g, ', ')}, valid until ${cert.validTo}`);
console.log(`  SHA-256 fingerprint ${cert.fingerprint256}`);
console.log('Commit both files, then run: bash scripts/deploy-live.sh');
