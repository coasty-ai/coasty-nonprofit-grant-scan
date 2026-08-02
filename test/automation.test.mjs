/**
 * Offline test suite. Zero dependencies — `node --test`, no install required.
 * Everything runs against the bundled in-process mock: no key, no network, $0.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoastyClient, CoastyError, resolveTarget, isLoopback, TERMINAL } from '../src/client.mjs';
import { computeHolds, downloadFrames, hasFfmpeg, encode, probe, assertVideoSane } from '../src/capture.mjs';
import { parseArgs, estimateCents, main } from '../src/cli.mjs';
import { startMock } from '../tools/mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unit = JSON.parse(await readFile(path.join(ROOT, 'automation.json'), 'utf8'));

let mock;
let client;
before(async () => {
  mock = await startMock({ steps: 14, tickMs: 10, unit });
  client = new CoastyClient({ baseUrl: mock.url, apiKey: 'sk-coasty-test-offline' });
});
after(async () => mock?.close());

// ── the unit definition itself ───────────────────────────────────────────────

describe('automation.json', () => {
  test('declares every field the catalog contract requires', () => {
    for (const k of ['slug', 'title', 'vertical', 'niche', 'target', 'task',
      'expectedSteps', 'maxSteps', 'capCents', 'publicTarget']) {
      assert.ok(unit[k] !== undefined && unit[k] !== '', `missing ${k}`);
    }
  });

  test('the task prompt names the target and states an observable goal', () => {
    assert.ok(unit.task.length > 60, 'prompt is too thin to be reproducible');
    assert.ok(unit.task.includes(unit.target), 'prompt must name its target host');
  });

  test('worst-case spend fits under the declared cap', () => {
    const e = estimateCents(unit);
    assert.ok(e.worstCase <= unit.capCents, `${e.worstCase}¢ > cap ${unit.capCents}¢`);
    assert.ok(unit.expectedSteps <= unit.maxSteps);
  });

  test('slug is a clean, stable identifier', () => {
    assert.match(unit.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('README', () => {
  // The README is the only thing most people will ever read, so a prompt shown
  // there that is not the prompt that actually runs is a straightforward lie.
  // Nothing caught this until a README drifted by three words.
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  let readme;
  before(async () => {
    readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  });

  test('quotes the real prompt verbatim (whitespace-insensitive)', () => {
    assert.ok(
      norm(readme).includes(norm(unit.task)),
      'README must quote automation.json\'s task exactly — reflow is fine, edits are not',
    );
  });

  test('embeds the demo hero and names its own repo', () => {
    assert.ok(readme.includes('media/demo.gif'), 'README must embed the demo gif');
    assert.ok(readme.includes(`coasty-${unit.slug}`), 'badges/clone URL must name this repo');
  });

  test('says where to get an API key', () => {
    // The README is where someone decides whether they can actually run this.
    // Telling them to set COASTY_API_KEY without saying where one comes from
    // is a dead end, and every README had exactly that gap.
    assert.ok(
      readme.includes('https://coasty.ai/developers/keys'),
      'README must link https://coasty.ai/developers/keys so a reader can obtain a key',
    );
  });

  test('states the correct worst-case cost', () => {
    const worst = estimateCents(unit).worstCase;
    assert.ok(
      readme.includes(`--confirm-cost-cents ${worst}`),
      `README must show the real worst case (${worst}) in its --confirm-cost-cents example`,
    );
  });
});

// ── argument parsing: the bug that silently ate the slug ─────────────────────

describe('parseArgs', () => {
  test('accepts --flag=value', () => {
    assert.equal(parseArgs(['demo', '--out=/tmp/x']).flags.out, '/tmp/x');
  });

  test('accepts --flag value (space form)', () => {
    assert.equal(parseArgs(['demo', '--out', '/tmp/x']).flags.out, '/tmp/x');
  });

  test('a space-form value never leaks into the positional slot', () => {
    // The regression: `--confirm-cost-cents 120` used to overwrite the command.
    const a = parseArgs(['run', '--live', '--confirm-cost-cents', '120']);
    assert.deepEqual(a._, ['run']);
    assert.equal(a.flags['confirm-cost-cents'], '120');
    assert.equal(a.flags.live, true);
  });

  test('rejects a value-taking flag with no value', () => {
    assert.throws(() => parseArgs(['demo', '--out']), /requires a value/);
    assert.throws(() => parseArgs(['demo', '--out', '--live']), /requires a value/);
  });
});

// ── fail-closed target resolution ────────────────────────────────────────────

describe('resolveTarget', () => {
  test('an unset base URL resolves to the mock, never production', () => {
    const t = resolveTarget({ COASTY_API_KEY: 'sk-coasty-live-aaaa' });
    assert.ok(isLoopback(t.baseUrl), 'must default to loopback');
    assert.equal(t.isLive, false);
  });

  test('a live key against a remote host is refused without explicit opt-in', () => {
    assert.throws(
      () => resolveTarget({ COASTY_BASE_URL: 'https://coasty.ai/v1', COASTY_API_KEY: 'sk-coasty-live-aaaa' }),
      (e) => e.code === 'LIVE_NOT_ALLOWED',
    );
  });

  test('explicit opt-in allows it', () => {
    const t = resolveTarget({
      COASTY_BASE_URL: 'https://coasty.ai/v1',
      COASTY_API_KEY: 'sk-coasty-live-aaaa',
      COASTY_ALLOW_LIVE: '1',
    });
    assert.equal(t.isLive, true);
  });

  // Destination consent is about the HOST, not the key. Gating it on the key
  // kind let a sandbox key — or no key at all — reach a remote host unchallenged.
  test('a sandbox key against a remote host is still refused without opt-in', () => {
    assert.throws(
      () => resolveTarget({ COASTY_BASE_URL: 'https://coasty.ai/v1', COASTY_API_KEY: 'sk-coasty-test-aaaa' }),
      (e) => e.code === 'LIVE_NOT_ALLOWED',
    );
  });

  test('a remote host with no key at all is refused', () => {
    assert.throws(
      () => resolveTarget({ COASTY_BASE_URL: 'https://coasty.ai/v1' }),
      (e) => e.code === 'LIVE_NOT_ALLOWED',
    );
  });

  test('a sandbox key never counts as live once the destination is allowed', () => {
    const t = resolveTarget({
      COASTY_BASE_URL: 'https://coasty.ai/v1',
      COASTY_API_KEY: 'sk-coasty-test-aaaa',
      COASTY_ALLOW_LIVE: '1',
    });
    assert.equal(t.isLive, false);
  });

  test('an allowed remote host with no key refuses instead of inventing one', () => {
    // The client used to substitute a made-up `sk-coasty-test-offline` and send
    // it to whatever host was configured.
    assert.throws(
      () => new CoastyClient({ env: { COASTY_BASE_URL: 'https://coasty.ai/v1', COASTY_ALLOW_LIVE: '1' } }),
      (e) => e.code === 'NO_API_KEY',
    );
  });

  test('the offline mock still needs no key', () => {
    const c = new CoastyClient({ env: {} });
    assert.ok(isLoopback(c.baseUrl));
    assert.equal(c.apiKey, 'sk-coasty-test-offline');
  });

  test('an unparseable base URL is treated as remote, not loopback', () => {
    assert.equal(isLoopback('not a url'), false);
  });
});

// ── cost consent cannot be skipped by omitting --live ────────────────────────

describe('cost consent', () => {
  // The gate used to key off the --live FLAG while the target went live off the
  // ENV, so `npm start` under a live COASTY_BASE_URL submitted a real billable
  // run with no confirmation. 192.0.2.0/24 is RFC 5737 TEST-NET-1: unroutable,
  // so a regression here stalls rather than spending anything.
  const LIVE_ENV = {
    COASTY_BASE_URL: 'http://192.0.2.1:9/v1',
    // Deliberately non-hex so CI's secret-shaped-material guard does not fire.
    COASTY_API_KEY: 'sk-coasty-live-zzzzzzzzzzzzzzzz',
    COASTY_ALLOW_LIVE: '1',
  };
  let saved;
  const quiet = async (fn) => {
    const { log, error } = console;
    console.log = console.error = () => {};
    try {
      return await fn();
    } finally {
      Object.assign(console, { log, error });
    }
  };
  before(() => {
    saved = { ...process.env };
    Object.assign(process.env, LIVE_ENV);
  });
  after(() => {
    for (const k of Object.keys(LIVE_ENV)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  test('`run` against a live target refuses without --confirm-cost-cents', async () => {
    assert.equal(await quiet(() => main(['run'])), 2);
  });

  test('`run --live` with the wrong confirmed amount is refused', async () => {
    assert.equal(await quiet(() => main(['run', '--live', '--confirm-cost-cents', '5'])), 2);
  });
});

// ── the CLI refuses malformed invocations cleanly ────────────────────────────

describe('command dispatch', () => {
  const quiet = async (fn) => {
    const { log, error } = console;
    console.log = console.error = () => {};
    try {
      return await fn();
    } finally {
      Object.assign(console, { log, error });
    }
  };

  test('an unknown subcommand is refused, not silently treated as `demo`', async () => {
    // `demo` writes media/demo.gif + poster.jpg, both tracked, so a typo used to
    // overwrite the committed README hero.
    assert.equal(await quiet(() => main(['frobnicate'])), 2);
  });

  test('a flag missing its value exits 2 rather than throwing a stack trace', async () => {
    assert.equal(await quiet(() => main(['demo', '--out'])), 2);
  });
});

// ── the API contract the mock reproduces ─────────────────────────────────────

describe('run lifecycle', () => {
  test('a task provisions its own machine and reaches a terminal state', async () => {
    const created = await client.createTask(unit.task, { max_steps: unit.maxSteps });
    assert.equal(created.machine_id, null, 'machine_id is null while provisioning');
    assert.equal(created.status, 'queued');

    const run = await client.waitForRun(created.id, { intervalMs: 10 });
    assert.ok(TERMINAL.has(run.status));
    assert.equal(run.status, 'succeeded');
    assert.ok(run.machine_id?.startsWith('mch_'), 'a machine id appears once provisioned');
    assert.equal(run.machine.cleanup_status, 'terminated', 'the ephemeral machine is torn down');
    assert.ok(run.steps_completed > 0);
  });

  test('a stable Idempotency-Key replays the original run instead of billing twice', async () => {
    const key = 'test-idem-key-1';
    const a = await client.createTask(unit.task, { idempotencyKey: key });
    const b = await client.createTask(unit.task, { idempotencyKey: key });
    assert.equal(a.id, b.id, 'same key + same body must return the SAME run');
  });

  test('reusing a key with a different body is rejected', async () => {
    const key = 'test-idem-key-2';
    await client.createTask(unit.task, { idempotencyKey: key });
    await assert.rejects(
      () => client.createTask(`${unit.task} (changed)`, { idempotencyKey: key }),
      (e) => e.code === 'IDEMPOTENCY_KEY_REUSED',
    );
  });

  test('an empty task is refused', async () => {
    await assert.rejects(() => client.createTask('  '), (e) => e.status === 422);
  });

  test('an unknown run id 404s with a typed error', async () => {
    await assert.rejects(() => client.getRun('run_nope'), (e) => e instanceof CoastyError && e.code === 'RUN_NOT_FOUND');
  });
});

// ── model-input frames ───────────────────────────────────────────────────────

describe('model-input frames', () => {
  let runId;
  before(async () => {
    const c = await client.createTask(unit.task, { max_steps: unit.maxSteps });
    const r = await client.waitForRun(c.id, { intervalMs: 10 });
    runId = r.id;
  });

  test('pages past the 10-frame include_image clamp', async () => {
    const seen = [];
    for await (const f of client.frames(runId)) seen.push(f);
    assert.ok(seen.length > 10, 'this unit must produce enough frames to force paging');
    assert.deepEqual(seen.map((f) => f.index), seen.map((_, i) => i), 'index is flat and monotonic');
  });

  test('frames are full model-coordinate-space size', async () => {
    const first = (await client.frames(runId).next()).value;
    assert.equal(first.width, 1280);
    assert.equal(first.height, 720);
  });

  test('inlined images are marked no-store', async () => {
    const res = await fetch(`${mock.url}/runs/${runId}/screenshots?include_image=true`, {
      headers: { 'X-API-Key': 'sk-coasty-test-offline' },
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('every frame passes its sha256 integrity check', async () => {
    const { frames } = await downloadFrames(client, runId, {
      workDir: path.join(tmpdir(), `frames-${runId}`),
    });
    assert.ok(frames.length > 0);
    // downloadFrames throws on mismatch, so reaching here proves integrity.
    assert.equal(new Set(frames.map((f) => f.sha256)).size, frames.length, 'frames are distinct');
  });

  test('captions are recovered from the SSE timeline', async () => {
    const caps = await client.captions(runId);
    assert.ok(caps.size > 0, 'the event stream must yield per-step narration');
  });
});

// ── pacing + encode ──────────────────────────────────────────────────────────

describe('video pacing', () => {
  test('holds are clamped and the final frame lingers', () => {
    const mk = (s) => ({ taken_at: new Date(s * 1000).toISOString() });
    const holds = computeHolds([mk(0), mk(0.1), mk(60), mk(61)]);
    assert.equal(holds[0], 0.6, 'a fast step is floored so it stays readable');
    assert.equal(holds[1], 2.5, 'a slow step is capped so it cannot stall the video');
    assert.equal(holds.at(-1), 1.8, 'the closing frame holds');
  });
});

describe('encode', { skip: (await hasFfmpeg()) ? false : 'ffmpeg not on PATH' }, () => {
  test('produces a playable video whose duration matches the pacing', async () => {
    const c = await client.createTask(unit.task, { max_steps: unit.maxSteps });
    const run = await client.waitForRun(c.id, { intervalMs: 10 });
    const { frames } = await downloadFrames(client, run.id);
    const out = path.join(tmpdir(), `enc-${run.id}`);
    const encoded = await encode(frames, out, { gif: false });
    const probed = await probe(encoded.mp4);

    // The regression this pins: `-r` as an output option silently truncates a
    // variable-rate concat stream. `fps=` as a filter + `-t` does not.
    assert.ok(
      Math.abs(probed.durationS - encoded.totalS) < 0.5,
      `duration ${probed.durationS}s should match the ${encoded.totalS}s timeline`,
    );
    assert.equal(probed.width, 1280);

    const checks = await assertVideoSane({ frames, run, encoded, probed });
    for (const c2 of checks) assert.ok(c2.ok, `${c2.name}: ${c2.detail}`);
  });
});
