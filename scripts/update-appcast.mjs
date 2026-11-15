// Only public keys and detached signatures enter this process. Private keys stay in Keychain.
import fs from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function readPublicKey(file) {
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').toString('base64') !== key) {
    throw new Error(`Invalid public key in ${file}; run bash scripts/sparkle-keys.sh`);
  }
  return key;
}
const xml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);

export function updateAppcast({ version, dmg, signature, publicKeyFile, appcast, notes, now = new Date() }) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid EdDSA signature');
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid publication date');
  const publicKey = readPublicKey(publicKeyFile);
  // RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
  const bytes = fs.readFileSync(dmg);
  if (!bytes.length || !verify(null, bytes, key, Buffer.from(signature, 'base64'))) {
    throw new Error('DMG signature does not match launcher/sparkle-public-key.txt; feed was not changed');
  }
  const heading = fs.readFileSync(notes, 'utf8').split('\n')[0].replace(/^##\s+/, '').trim();
  if (heading !== version && !heading.startsWith(`${version} (`)) throw new Error('Release notes version mismatch');
  // GitHub's generated Markdown heading anchor (for our version/date headings).
  const anchor = heading.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
  const feed = fs.readFileSync(appcast, 'utf8');
  if (!feed.includes('xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"') ||
      (feed.match(/<channel>/g) || []).length !== 1 || (feed.match(/<\/channel>/g) || []).length !== 1) {
    throw new Error('Unexpected appcast channel or Sparkle namespace');
  }
  if (feed.includes(`<sparkle:version>${xml(version)}</sparkle:version>`)) throw new Error(`Appcast already contains ${version}; refusing duplicate publication`);
  const base = 'https://github.com/OnurSamett/tokenwise-studio';
  const item = `    <item>
      <title>${xml(version)}</title>
      <pubDate>${xml(now.toUTCString())}</pubDate>
      <sparkle:version>${xml(version)}</sparkle:version>
      <sparkle:shortVersionString>${xml(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <sparkle:releaseNotesLink>${xml(`${base}/blob/v${version}/CHANGELOG.md#${anchor}`)}</sparkle:releaseNotesLink>
      <enclosure url="${xml(`${base}/releases/download/v${version}/tokenwise-studio-${version}.dmg`)}" sparkle:edSignature="${xml(signature)}" length="${bytes.length}" type="application/octet-stream" />
    </item>
`;
  // Newest first. Preserve older items and channel metadata. Atomic replacement on failure.
  const updated = /    <item>/.test(feed) ? feed.replace(/    <item>/, item + '    <item>') : feed.replace('  </channel>', item + '  </channel>');
  const temp = `${appcast}.tmp`;
  try { fs.writeFileSync(temp, updated); fs.renameSync(temp, appcast); }
  finally { fs.rmSync(temp, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--check-key' && args.length === 2) readPublicKey(args[1]);
    else {
      if (args.length !== 7) throw new Error('Usage: update-appcast.mjs VERSION DMG SIGNATURE PUBLIC_KEY APPCAST NOTES PUBDATE');
      const [version, dmg, signature, publicKeyFile, appcast, notes, date] = args;
      updateAppcast({ version, dmg, signature, publicKeyFile, appcast, notes, now: new Date(date) });
    }
  } catch (error) { console.error(`[appcast] ${error.message}`); process.exitCode = 1; }
}
