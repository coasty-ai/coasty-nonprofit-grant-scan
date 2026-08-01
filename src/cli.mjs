/**
 * Shared CLI for every automation in the catalog. Identical in all 12 repos —
 * everything unit-specific lives in `automation.json`, so a new automation is
 * one JSON file and one prompt, never a fork of this code.
 *
 *   node src/cli.mjs run     [--live] [--confirm-cost-cents N] [--json]
 *   node src/cli.mjs demo    [--live] [--out DIR] [--no-gif]
 *   node src/cli.mjs estimate
 *
 * Offline by default: with no COASTY_BASE_URL it boots the bundled mock
 * in-process on an ephemeral port, so `npm start` works on a fresh clone with
 * no key, no server to start, and no spend.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { CoastyClient, CoastyError, resolveTarget, makeLogger } from './client.mjs';
import { downloadFrames, encode, probe, assertVideoSane, hasFfmpeg, fileSize } from './capture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * Accept BOTH `--flag value` and `--flag=value`. Getting this wrong is not a
 * cosmetic bug: with only the `=` form, a bare value falls through to the
 * positional slot and silently becomes the slug/command.
 */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const takesValue = new Set(['out', 'confirm-cost-cents', 'steps', 'timeout-ms']);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (takesValue.has(body)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${body} requires a value`);
      }
      out.flags[body] = next;
      i++;
      continue;
    }
    out.flags[body] = true;
  }
  return out;
}

const loadUnit = async () =>
  JSON.parse(await readFile(path.join(ROOT, 'automation.json'), 'utf8'));

/** Worst-case spend for one run, in cents. Run steps bill; frames are free. */
export function estimateCents(unit, perStepCents = 5) {
  return {
    perStepCents,
    expected: unit.expectedSteps * perStepCents,
    worstCase: unit.maxSteps * perStepCents,
  };
}

/** Start the bundled mock unless a base URL was supplied. */
async function ensureTarget(unit, wantLive) {
  if (wantLive || process.env.COASTY_BASE_URL) {
    const t = resolveTarget();
    return { baseUrl: t.baseUrl, isLive: t.isLive, close: async () => {} };
  }
  // Windows: a bare absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const { startMock } = await import(pathToFileURL(path.join(ROOT, 'tools', 'mock.mjs')).href);
  const mock = await startMock({ steps: unit.expectedSteps, host: unit.target });
  return { baseUrl: mock.url, isLive: false, close: mock.close };
}

const j = (o) => JSON.stringify(o);

async function main(argv) {
  const { _, flags } = parseArgs(argv);
  const cmd = _[0] ?? 'run';
  const unit = await loadUnit();
  const est = estimateCents(unit);

  if (cmd === 'estimate') {
    const out = { slug: unit.slug, ...est, capCents: unit.capCents };
    console.log(flags.json ? j(out) : renderEstimate(unit, est));
    return 0;
  }

  const wantLive = Boolean(flags.live);
  // Cost consent is a SEPARATE decision from destination consent, and it is
  // required only when real money is at stake.
  if (wantLive) {
    const confirmed = Number(flags['confirm-cost-cents'] ?? NaN);
    if (!Number.isInteger(confirmed) || confirmed !== est.worstCase) {
      console.error(renderEstimate(unit, est));
      console.error(
        `\nRefusing to spend without explicit confirmation.\n` +
          `Re-run with:  --live --confirm-cost-cents ${est.worstCase}`,
      );
      return 2;
    }
    if (est.worstCase > unit.capCents) {
      console.error(`Worst case ${est.worstCase}¢ exceeds this unit's cap of ${unit.capCents}¢.`);
      return 2;
    }
  }

  // `ensureTarget` itself can refuse (fail-closed destination), so it must be
  // inside the guarded block — otherwise the refusal escapes as a stack trace
  // instead of a clean message and exit code.
  let target = { close: async () => {} };
  try {
    target = await ensureTarget(unit, wantLive);
    const logger = makeLogger(process.stderr, { slug: unit.slug });
    const client = new CoastyClient({
      baseUrl: target.baseUrl,
      timeoutMs: Number(flags['timeout-ms'] ?? 60_000),
      onLog: logger.log,
    });

    if (!flags.json) {
      console.log(`${unit.title}`);
      console.log(`  target   ${unit.target}${target.isLive ? '' : '  (offline mock)'}`);
      console.log(`  estimate ${est.expected}¢ expected · ${est.worstCase}¢ worst case`);
      console.log('');
    }

    // A stable key derived from the prompt: a retried submit returns the
    // ORIGINAL run instead of provisioning a second machine and billing twice.
    const idempotencyKey = `${unit.slug}:${hash12(unit.task)}`;
    const created = await client.createTask(unit.task, {
      idempotencyKey,
      max_steps: unit.maxSteps,
      cua_version: unit.cuaVersion ?? 'v5',
      ...(unit.deadlineSeconds ? { deadline_seconds: unit.deadlineSeconds } : {}),
      ...(unit.machine ? { machine: unit.machine } : {}),
      metadata: { slug: unit.slug, vertical: unit.vertical },
    });

    const run = await client.waitForRun(created.id, {
      intervalMs: target.isLive ? 3000 : 120,
      onTick: (r) => {
        if (!flags.json && r.steps_completed > 0) {
          process.stdout.write(`\r  step ${r.steps_completed}/${unit.maxSteps}   `);
        }
      },
    });
    if (!flags.json) process.stdout.write('\r');

    if (cmd === 'run') {
      const out = {
        run_id: run.id,
        status: run.status,
        steps: run.steps_completed,
        cost_cents: run.cost_cents,
        passed: run.result?.passed ?? null,
        summary: run.result?.summary ?? null,
      };
      console.log(flags.json ? j(out) : renderRun(out));
      return run.status === 'succeeded' ? 0 : 1;
    }

    // ── demo: real model-input frames → video ───────────────────────────────
    if (!(await hasFfmpeg())) {
      console.error('ffmpeg is required for `demo`. Run `npm run doctor` for install hints.');
      return 4;
    }
    const outDir = flags.out ? path.resolve(String(flags.out)) : path.join(ROOT, 'media');
    const { frames, skipped } = await downloadFrames(client, run.id);
    if (frames.length === 0) {
      console.error('No model-input frames were captured for this run.');
      return 5;
    }
    const captions = await client.captions(run.id);
    const encoded = await encode(frames, outDir, { gif: !flags['no-gif'] });
    const probed = await probe(encoded.mp4);
    const checks = await assertVideoSane({ frames, run, encoded, probed });

    const out = {
      run_id: run.id,
      mode: target.isLive ? 'live' : 'mock',
      frames: frames.length,
      skipped,
      captions: captions.size,
      duration_s: Number(probed.durationS.toFixed(2)),
      mp4: encoded.mp4,
      gif: encoded.gif ?? null,
      poster: encoded.poster,
      checks: checks.map(({ name, ok }) => ({ name, ok })),
    };
    if (flags.json) {
      console.log(j(out));
    } else {
      console.log(`  ${frames.length} frames · ${captions.size} captions · ${probed.width}x${probed.height} · ${out.duration_s}s`);
      console.log(`  mp4 ${await fileSize(encoded.mp4)}${encoded.gif ? ` · gif ${await fileSize(encoded.gif)}` : ''}`);
      console.log('');
      for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}  ${c.detail}`);
      console.log(`\n  → ${outDir}`);
    }
    return checks.every((c) => c.ok) ? 0 : 6;
  } catch (err) {
    if (err instanceof CoastyError) {
      console.error(`\n${err.code}: ${err.message}${err.requestId ? `\n  request_id: ${err.requestId}` : ''}`);
      return 3;
    }
    throw err;
  } finally {
    await target.close();
  }
}

const hash12 = (s) =>
  [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261)
    .toString(16)
    .padStart(8, '0');

const renderEstimate = (u, e) =>
  [
    `${u.title}`,
    `  ${u.vertical} · ${u.niche}`,
    `  target        ${u.target}`,
    `  steps         ${u.expectedSteps} expected, ${u.maxSteps} max`,
    `  cost          ${e.expected}¢ (~$${(e.expected / 100).toFixed(2)}) expected`,
    `                ${e.worstCase}¢ (~$${(e.worstCase / 100).toFixed(2)}) worst case`,
    `  cap           ${u.capCents}¢`,
    `  frames        free (model-input frames are not billed)`,
  ].join('\n');

const renderRun = (o) =>
  [
    `  ${o.status === 'succeeded' ? '✓' : '✗'} ${o.status}  ·  ${o.steps} steps  ·  ${o.cost_cents}¢`,
    o.summary ? `  ${o.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n');

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}

export { main };
