// Spike S4: minimal patch that lets ssh2 1.17.0 authenticate with OpenSSH user certificates.
//
// ssh2's Protocol.authPK() writes the *request* algorithm name (e.g. "ssh-ed25519-cert-v01@openssh.com")
// into the signature blob as well, and passes it to convertSignature(). RFC 4252 / PROTOCOL.certkeys
// require the signature to be in the underlying key's format ("ssh-ed25519", "rsa-sha2-256",
// "ecdsa-sha2-nistp256"), so OpenSSH rejects it. The fix strips "-cert-v01@openssh.com" for the signature
// only; the signed request keeps the certificate algorithm.
//
//   node patch-ssh2-certificates.mjs          apply (idempotent)
//   node patch-ssh2-certificates.mjs --check  exit 1 if not applied
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const file = join(dirname(require.resolve('ssh2/package.json')), 'lib/protocol/Protocol.js');
const version = require('ssh2/package.json').version;
const MARK = '/* qe-s4: certificate signature format */';
let src = readFileSync(file, 'utf8');

if (process.argv.includes('--check')) {
  console.log(src.includes(MARK) ? `patched (ssh2 ${version})` : `NOT patched (ssh2 ${version})`);
  process.exit(src.includes(MARK) ? 0 : 1);
}
if (src.includes(MARK)) {
  console.log(`already patched: ${file}`);
  process.exit(0);
}

// Each edit must match exactly once, inside authPK()'s signing branch.
const start = src.indexOf('  authPK(username, pubKey, keyAlgo, cbSign) {');
const end = src.indexOf('  authHostbased(', start);
if (start < 0 || end < 0) throw new Error(`authPK() not found in ssh2 ${version}`);
let body = src.slice(start, end);
const edits = [
  [
    'signature = convertSignature(signature, keyType);',
    `${MARK}\n      const sigAlgo = keyAlgo.replace(/-cert-v01@openssh\\.com$/, '');\n      const sigAlgoLen = Buffer.byteLength(sigAlgo);\n      signature = convertSignature(signature, keyType.replace(/-cert-v01@openssh\\.com$/, ''));`,
  ],
  ['          + 4 + algoLen + 4 + sigLen\n', '          + 4 + sigAlgoLen + 4 + sigLen\n'],
  [
    'writeUInt32BE(packet, 4 + algoLen + 4 + sigLen, p += pubKeyLen);\n\n      writeUInt32BE(packet, algoLen, p += 4);\n      packet.utf8Write(keyAlgo, p += 4, algoLen);\n\n      writeUInt32BE(packet, sigLen, p += algoLen);',
    'writeUInt32BE(packet, 4 + sigAlgoLen + 4 + sigLen, p += pubKeyLen);\n\n      writeUInt32BE(packet, sigAlgoLen, p += 4);\n      packet.utf8Write(sigAlgo, p += 4, sigAlgoLen);\n\n      writeUInt32BE(packet, sigLen, p += sigAlgoLen);',
  ],
];
for (const [from, to] of edits) {
  const count = body.split(from).length - 1;
  if (count !== 1) throw new Error(`expected exactly one match for edit, found ${count}: ${from.slice(0, 60)}`);
  body = body.replace(from, to);
}
src = src.slice(0, start) + body + src.slice(end);
writeFileSync(file, src);
console.log(`patched ssh2 ${version}: ${file}`);
