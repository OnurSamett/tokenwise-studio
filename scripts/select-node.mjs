// Select the newest LTS satisfying this repo's simple >= engine, or an explicit pinned release.
import fs from 'node:fs';
const [indexFile, packageFile, pin = ''] = process.argv.slice(2);
const engine = JSON.parse(fs.readFileSync(packageFile, 'utf8')).engines.node;
const min = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(engine);
if (!min) throw new Error(`Unsupported engines.node ${engine}; update the release selector before building`);
const parts = v => v.replace(/^v/, '').split('.').map(Number);
const compare = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
const releases = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
if (pin && !/^v?\d+\.\d+\.\d+$/.test(pin)) throw new Error('NODE_VERSION must be an exact x.y.z release');
const candidates = releases.filter(r => (pin ? r.version === `v${pin.replace(/^v/, '')}` : r.lts)
  && compare(parts(r.version), min.slice(1).map(Number)) >= 0
  && ['osx-arm64-tar', 'osx-x64-tar'].every(f => r.files.includes(f)))
  .sort((a, b) => compare(parts(b.version), parts(a.version)));
if (!candidates.length) throw new Error(`No macOS arm64 + x64 ${pin || 'LTS'} release satisfies ${engine}`);
console.log(candidates[0].version);
