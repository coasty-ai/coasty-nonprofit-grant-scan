#!/usr/bin/env node
/** Preflight: says what works, what is missing, and exactly how to fix it. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
const exec = promisify(execFile);
const ok = (m, d = '') => console.log(`  \x1b[32m✓\x1b[0m ${m}${d ? `  ${d}` : ''}`);
const warn = (m, d = '') => console.log(`  \x1b[33m!\x1b[0m ${m}${d ? `\n      ${d}` : ''}`);

const unit = JSON.parse(await readFile(new URL('../automation.json', import.meta.url), 'utf8'));
console.log(`\n${unit.title}\n`);

const [maj, min] = process.versions.node.split('.').map(Number);
(maj > 20 || (maj === 20 && min >= 11))
  ? ok('node', `v${process.versions.node}`)
  : warn(`node v${process.versions.node} is too old`, 'Need >= 20.11 for the built-in test runner.');

try {
  const { stdout } = await exec('ffmpeg', ['-version']);
  ok('ffmpeg', stdout.split('\n')[0].split(' ').slice(0, 3).join(' '));
} catch {
  warn('ffmpeg not on PATH — `npm run demo` will not render', 
    'macOS: brew install ffmpeg | Ubuntu: sudo apt-get install -y ffmpeg | Windows: winget install Gyan.FFmpeg');
}

const key = process.env.COASTY_API_KEY?.trim();
const base = process.env.COASTY_BASE_URL?.trim();
if (!key) ok('offline mode', 'no COASTY_API_KEY — the bundled mock is used, $0');
else if (key.startsWith('sk-coasty-test-')) ok('sandbox key', 'never bills');
else if (key.startsWith('sk-coasty-live-')) {
  base && !/127\.0\.0\.1|localhost/.test(base)
    ? warn('LIVE key + remote base URL', `Runs bill real money. COASTY_ALLOW_LIVE=${process.env.COASTY_ALLOW_LIVE ?? 'unset'}`)
    : ok('live key, offline target', 'fail-closed: requests go to the mock');
} else warn('unrecognised COASTY_API_KEY prefix', 'Treated as live (the expensive interpretation).');

// Someone running doctor with no key is usually deciding whether they can run
// this for real. Tell them where a key comes from rather than leaving a dead end.
if (!key) {
  console.log(`\n  Need a key to run for real?  \x1b[36mhttps://coasty.ai/developers/keys\x1b[0m`);
  console.log(`  A \x1b[36msk-coasty-test-\x1b[0m sandbox key never bills.`);
}
console.log(`\n  Run offline now:  \x1b[36mnpm start\x1b[0m`);
console.log(`  Render a demo:    \x1b[36mnpm run demo\x1b[0m\n`);
