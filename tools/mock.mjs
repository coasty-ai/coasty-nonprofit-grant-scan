/**
 * A faithful-enough offline Coasty for this automation. Zero dependencies.
 *
 * Serves exactly the four routes an automation touches, with the documented
 * contract quirks that actually bite:
 *   POST /v1/tasks                        idempotency replay, 422 on key reuse
 *   GET  /v1/runs/{id}                    machine_id null while provisioning
 *   GET  /v1/runs/{id}/screenshots        10-frame clamp under include_image,
 *                                         after_index paging, has_more, no-store
 *   GET  /v1/runs/{id}/events             SSE timeline, closes after `done`
 *
 * Frames are real 1280x720 PNGs, distinct per step, so the capture pipeline
 * produces a genuine video offline — the same code path that later runs against
 * live Coasty, differing only in the pixels.
 *
 * Run standalone:  node tools/mock.mjs [--port 4010]
 * Or in-process:   const { url, close } = await startMock()
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { renderFrame } from './portal.mjs';

// ── run state machine ────────────────────────────────────────────────────────

const PROVISION_TICKS = 2;

class Run {
  constructor({ id, task, maxSteps, totalSteps, unit }) {
    this.unit = unit ?? {};
    this.id = id;
    this.task = task;
    this.status = 'queued';
    this.machine_id = null;
    this.steps_completed = 0;
    this.cost_cents = 0;
    this.max_steps = maxSteps;
    this.totalSteps = totalSteps;
    this.ticks = 0;
    this.frames = [];
    this.events = [];
    this.result = null;
    this.host = 'example.com';
    this.machine = { mode: 'automatic', status: 'provisioning', id: null, cleanup: 'always', cleanup_status: 'pending' };
  }

  emit(type, data) {
    this.events.push({ seq: this.events.length + 1, type, data });
  }

  /**
   * Tear the ephemeral machine down. This MUST happen in the same tick that
   * puts the run into a terminal state: `waitForRun` returns on the first
   * terminal observation, so leaving cleanup to the next tick opened a ~1-tick
   * window where a caller saw `succeeded` with `cleanup_status: 'pending'`.
   * That was a real ~4%-per-suite flake, i.e. red CI on most pushes.
   */
  teardown() {
    this.machine.status = 'terminated';
    this.machine.cleanup_status = 'terminated';
  }

  tick() {
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(this.status)) {
      this.teardown();
      return;
    }
    if (this.machine.status === 'provisioning') {
      if (++this.ticks < PROVISION_TICKS) return;
      this.machine_id = `mch_test_${randomUUID().slice(0, 8)}`;
      this.machine.id = this.machine_id;
      this.machine.status = 'ready';
      this.status = 'running';
      this.emit('status', { status: 'running', machine_id: this.machine_id });
      return;
    }
    const step = this.steps_completed + 1;
    const buf = renderFrame(this.unit, step, this.totalSteps);
    this.frames.push({
      index: this.frames.length,
      attempt: 1,
      step,
      taken_at: new Date(Date.now()).toISOString(),
      width: 1280,
      height: 720,
      mime_type: 'image/png',
      size_bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      degraded: false,
      encrypted_at_rest: true,
      _buf: buf,
    });
    this.emit('text', { text: `Step ${step}: inspecting ${this.host}` });
    this.emit('tool_call', { tool: step % 3 === 0 ? 'type_text' : 'click', params: { x: 120 + step * 7, y: 240 } });
    this.steps_completed = step;
    this.cost_cents += 5;
    this.emit('step', { steps_completed: step });
    this.emit('billing', { cost_cents: this.cost_cents });
    if (step >= this.totalSteps) {
      this.status = 'succeeded';
      this.result = { passed: true, status: 'succeeded', summary: `Completed in ${step} steps.` };
      this.teardown();
      this.emit('done', { status: 'succeeded', result: this.result });
    } else if (step >= this.max_steps) {
      this.status = 'failed';
      this.result = { passed: false, status: 'failed', summary: 'Hit max_steps.' };
      this.teardown();
      this.emit('done', { status: 'failed', result: this.result });
    }
  }
}

// ── server ───────────────────────────────────────────────────────────────────

export async function startMock({ port = 0, tickMs = 60, steps = 14, unit = {} } = {}) {
  const runs = new Map();
  const idem = new Map();
  const timers = new Set();

  const send = (res, code, body, extra = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'X-Coasty-Request-Id': `req_${randomUUID().slice(0, 12)}`,
      ...extra,
    });
    res.end(payload);
  };
  const fail = (res, code, errCode, message, extra = {}) =>
    send(res, code, { error: { code: errCode, message, type: 'error', ...extra } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/v1/tasks' && req.method === 'POST') {
      const raw = await new Promise((r) => {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => r(b));
      });
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return fail(res, 422, 'VALIDATION_ERROR', 'Body must be JSON');
      }
      if (typeof body.task !== 'string' || !body.task.trim()) {
        return fail(res, 422, 'VALIDATION_ERROR', 'task is required (1-16000 chars)');
      }
      const key = req.headers['idempotency-key'];
      const hash = createHash('sha256').update(raw).digest('hex');
      if (key) {
        const prev = idem.get(key);
        if (prev) {
          if (prev.hash !== hash) {
            return fail(res, 422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused with a different body');
          }
          return send(res, 201, prev.payload, { 'X-Coasty-Idempotent-Replay': 'true' });
        }
      }
      const run = new Run({
        id: `run_${randomUUID().slice(0, 12)}`,
        task: body.task,
        maxSteps: body.max_steps ?? 150,
        totalSteps: steps,
        unit,
      });
      run.host = unit.target ?? 'example.com';
      runs.set(run.id, run);
      const t = setInterval(() => run.tick(), tickMs);
      timers.add(t);
      const payload = publicRun(run);
      if (key) idem.set(key, { hash, payload });
      return send(res, 201, payload);
    }

    const m = /^\/v1\/runs\/([^/]+)(\/screenshots|\/events)?$/.exec(p);
    if (m) {
      const run = runs.get(decodeURIComponent(m[1]));
      if (!run) return fail(res, 404, 'RUN_NOT_FOUND', `No run '${m[1]}'`);

      if (!m[2]) return send(res, 200, publicRun(run));

      if (m[2] === '/screenshots') {
        const include = url.searchParams.get('include_image') === 'true';
        const after = url.searchParams.has('after_index')
          ? Number(url.searchParams.get('after_index'))
          : -1;
        if (Number.isNaN(after)) {
          return fail(res, 400, 'INVALID_LIMIT', 'after_index must be an integer');
        }
        const all = run.frames.filter((f) => f.index > after);
        // include_image clamps the page to 10; metadata-only pages are unclamped.
        const page = include ? all.slice(0, 10) : all;
        const data = page.map(({ _buf, ...meta }) =>
          include ? { ...meta, image_b64: _buf.toString('base64') } : meta,
        );
        return send(
          res,
          200,
          { object: 'list', data, has_more: page.length < all.length },
          include ? { 'Cache-Control': 'no-store' } : {},
        );
      }

      // SSE timeline; closes after `done`, so a terminal run yields a finite stream.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let sent = 0;
      const pump = setInterval(() => {
        while (sent < run.events.length) {
          const e = run.events[sent++];
          res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
          if (e.type === 'done') {
            clearInterval(pump);
            timers.delete(pump);
            return res.end();
          }
        }
      }, 20);
      timers.add(pump);
      req.on('close', () => {
        clearInterval(pump);
        timers.delete(pump);
      });
      return undefined;
    }

    return fail(res, 404, 'NOT_FOUND', `No route ${req.method} ${p}`);
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}/v1`,
    port: actual,
    async close() {
      for (const t of timers) clearInterval(t);
      timers.clear();
      await new Promise((r) => server.close(r));
    },
  };
}

function publicRun(run) {
  return {
    id: run.id,
    object: 'agent.run',
    status: run.status,
    machine_id: run.machine_id,
    machine: run.machine,
    task: run.task,
    cua_version: 'v5',
    max_steps: run.max_steps,
    on_awaiting_human: 'fail',
    steps_completed: run.steps_completed,
    cost_cents: run.cost_cents,
    result: run.result,
    error: null,
  };
}

// CLI. `file://${path}` yields two slashes on Windows against import.meta.url's
// three, so `npm run mock` was a silent no-op there — it exited 0 with no
// listener. pathToFileURL is the portable form (src/cli.mjs already uses it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argPort = process.argv.find((a) => a.startsWith('--port='))?.split('=')[1];
  const i = process.argv.indexOf('--port');
  const port = Number(argPort ?? (i > -1 ? process.argv[i + 1] : 4010));
  const { readFile } = await import('node:fs/promises');
  const unit = JSON.parse(await readFile(new URL('../automation.json', import.meta.url), 'utf8'));
  const { url } = await startMock({ port, steps: unit.expectedSteps ?? 14, unit });
  console.log(`offline coasty mock → ${url}`);
}
