/**
 * Minimal Coasty API client. Zero dependencies — Node 20+ built-ins only.
 *
 * Three things it does that a bare `fetch` does not:
 *
 *  1. FAILS CLOSED on destination. An unset `COASTY_BASE_URL` resolves to the
 *     bundled offline mock, never to production. Reaching the real, billable
 *     API requires BOTH a non-loopback base URL AND `COASTY_ALLOW_LIVE=1`.
 *     Cost consent and destination consent are separate decisions: the shipped
 *     upstream quickstart gated spend on the key prefix alone while the base
 *     URL defaulted to production, so one forgotten env var billed a real
 *     account.
 *  2. Retries safely. GET/DELETE always; POST only when an Idempotency-Key was
 *     supplied, because a retried unkeyed POST can provision a second machine
 *     and bill twice.
 *  3. Surfaces the request id. Every Coasty response carries
 *     `X-Coasty-Request-Id`; it is the only useful thing to quote in a support
 *     ticket, so it rides on every error and every log line.
 */
import { setTimeout as sleep } from 'node:timers/promises';

export const MOCK_BASE_URL = 'http://127.0.0.1:4010/v1';
export const LIVE_BASE_URL = 'https://coasty.ai/v1';

/** Terminal run states. A run in one of these will never change again. */
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export class CoastyError extends Error {
  constructor(message, { status, code, requestId, retryable = false, body } = {}) {
    super(message);
    this.name = 'CoastyError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
    this.body = body;
  }
}

/** True for a URL pointing at this machine. Fails CLOSED: unparseable ⇒ remote. */
export function isLoopback(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Decide where requests go, and refuse to guess.
 *
 * @returns {{baseUrl:string, isLive:boolean, keyKind:'sandbox'|'live'|'none'}}
 * @throws  {CoastyError} when the resolved target is live and not explicitly allowed
 */
export function resolveTarget(env = process.env) {
  const baseUrl = (env.COASTY_BASE_URL?.trim() || MOCK_BASE_URL).replace(/\/+$/, '');
  const key = env.COASTY_API_KEY?.trim() ?? '';
  const keyKind = key.startsWith('sk-coasty-live-')
    ? 'live'
    : key.startsWith('sk-coasty-test-') || key.startsWith('cua_sk_')
      ? 'sandbox'
      : key
        ? 'live' // unknown prefix: assume the expensive interpretation
        : 'none';

  // Destination consent depends on the HOST, not on the key. Gating it on the
  // key kind meant a remote base URL with no key (or a sandbox key) sailed
  // straight through to a third-party host — and the client then invented a
  // credential to send it. Any host that is not the bundled loopback mock is
  // an egress decision the operator has to make explicitly.
  const isRemote = !isLoopback(baseUrl);
  if (isRemote && env.COASTY_ALLOW_LIVE !== '1') {
    throw new CoastyError(
      `Refusing to call ${baseUrl}. That is not the bundled offline mock.\n` +
        `Set COASTY_ALLOW_LIVE=1 to allow it, or unset COASTY_BASE_URL to use the offline mock.`,
      { code: 'LIVE_NOT_ALLOWED' },
    );
  }
  // "Live" means the request can actually bill: a remote host AND a billing key.
  const isLive = isRemote && keyKind === 'live';
  return { baseUrl, isLive, keyKind };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class CoastyClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]   overrides target resolution (tests)
   * @param {string} [opts.apiKey]
   * @param {number} [opts.timeoutMs] per attempt. Default 60s.
   * @param {number} [opts.maxAttempts] Default 4.
   * @param {(e:object)=>void} [opts.onLog] structured log sink
   */
  constructor(opts = {}) {
    const env = opts.env ?? process.env;
    const resolved = opts.baseUrl ? null : resolveTarget(env);
    this.baseUrl = (opts.baseUrl ?? resolved.baseUrl).replace(/\/+$/, '');
    // The bundled mock ignores the key, so a fresh clone needs no account. A
    // REMOTE host never gets a placeholder: fabricating `sk-coasty-test-offline`
    // for an unset key shipped a made-up credential to a third-party host.
    const supplied = opts.apiKey ?? (env.COASTY_API_KEY?.trim() || '');
    this.apiKey = supplied || (isLoopback(this.baseUrl) ? 'sk-coasty-test-offline' : '');
    if (!this.apiKey) {
      throw new CoastyError(
        `No COASTY_API_KEY set for ${this.baseUrl}.\n` +
          `Set one, or unset COASTY_BASE_URL to use the offline mock.`,
        { code: 'NO_API_KEY' },
      );
    }
    this.isLive = opts.baseUrl ? !isLoopback(this.baseUrl) : resolved.isLive;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.onLog = opts.onLog ?? (() => {});
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** One attempt. Throws CoastyError; never retries. */
  async #attempt(method, path, { body, idempotencyKey, signal } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = { 'X-API-Key': this.apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (cause) {
      throw new CoastyError(`${method} ${path} — network failure: ${cause.message}`, {
        code: 'UNREACHABLE',
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const requestId = res.headers.get('x-coasty-request-id') ?? undefined;
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const err = parsed?.error ?? {};
      throw new CoastyError(err.message ?? `${method} ${path} → HTTP ${res.status}`, {
        status: res.status,
        code: err.code ?? `HTTP_${res.status}`,
        requestId: err.request_id ?? requestId,
        retryable: RETRYABLE_STATUS.has(res.status),
        body: parsed,
      });
    }
    return { body: parsed, headers: res.headers, requestId };
  }

  /**
   * Request with the retry policy. A POST is retried ONLY when the caller
   * supplied an Idempotency-Key — otherwise a retry could double-bill.
   */
  async request(method, path, opts = {}) {
    const safe = method === 'GET' || method === 'DELETE' || Boolean(opts.idempotencyKey);
    let lastErr;
    for (let attempt = 1; attempt <= (safe ? this.maxAttempts : 1); attempt++) {
      try {
        const out = await this.#attempt(method, path, opts);
        this.onLog({ evt: 'http', method, path, ok: true, attempt, request_id: out.requestId });
        return out;
      } catch (err) {
        lastErr = err;
        this.onLog({
          evt: 'http',
          method,
          path,
          ok: false,
          attempt,
          code: err.code,
          status: err.status,
          request_id: err.requestId,
        });
        if (!err.retryable || attempt === this.maxAttempts || !safe) break;
        // Exponential backoff with full jitter, honouring Retry-After.
        const after = Number(err.body?.error?.retry_after ?? 0) * 1000;
        const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
        await sleep(Math.max(after, Math.random() * backoff));
      }
    }
    throw lastErr;
  }

  // ── the three endpoints an automation actually needs ──────────────────────

  /** POST /v1/tasks — submit-and-forget. Coasty owns the machine lifecycle. */
  async createTask(task, { idempotencyKey, ...rest } = {}) {
    const { body } = await this.request('POST', '/tasks', {
      body: { task, ...rest },
      idempotencyKey,
    });
    return body;
  }

  async getRun(runId) {
    const { body } = await this.request('GET', `/runs/${encodeURIComponent(runId)}`);
    return body;
  }

  /** Poll to a terminal state. Returns the final run object. */
  async waitForRun(runId, { intervalMs = 2000, timeoutMs = 900_000, onTick } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.getRun(runId);
      onTick?.(run);
      if (TERMINAL.has(run.status)) return run;
      if (Date.now() > deadline) {
        throw new CoastyError(`Run ${runId} did not finish within ${timeoutMs}ms`, {
          code: 'WAIT_TIMEOUT',
        });
      }
      await sleep(intervalMs);
    }
  }

  /**
   * GET /v1/runs/{id}/screenshots — the model-input frames, oldest first: the
   * exact images the agent saw before each decision. Free (`runs:read`).
   *
   * `include_image=true` CLAMPS the page to 10 frames, so paging is mandatory
   * even for short runs. `index` is flat and monotonic across the WHOLE run;
   * `step` restarts on a retried attempt, so only `index` is a safe cursor.
   */
  async *frames(runId, { includeImage = true } = {}) {
    let after = -1;
    for (;;) {
      const q = new URLSearchParams();
      if (includeImage) q.set('include_image', 'true');
      if (after >= 0) q.set('after_index', String(after));
      const { body } = await this.request(
        'GET',
        `/runs/${encodeURIComponent(runId)}/screenshots?${q}`,
      );
      const page = body.data ?? [];
      if (page.length === 0) return;
      for (const f of page) yield f;
      after = page.at(-1).index;
      if (!body.has_more) return;
    }
  }

  /**
   * Per-step narration from the SSE timeline, keyed by step number.
   * NB: the timeline is SSE on both the mock and live Coasty — `events.json`
   * is an open-cowork backend convenience route that does not exist upstream.
   */
  async captions(runId) {
    const out = new Map();
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { 'X-API-Key': this.apiKey, Accept: 'text/event-stream' },
      });
    } catch {
      return out; // captions are a nice-to-have
    }
    if (!res.ok) return out;
    const raw = await res.text(); // the run is terminal, so the stream is finite
    let step = 0;
    for (const frame of raw.split('\n\n')) {
      const type = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!type || !data) continue;
      let d;
      try {
        d = JSON.parse(data);
      } catch {
        continue;
      }
      // `text` precedes the `step` event for the same step, so it belongs to step+1.
      if ((type === 'text' || type === 'reasoning') && d.text) {
        out.set(step + 1, String(d.text).slice(0, 140));
      }
      if (type === 'step' && typeof d.steps_completed === 'number') step = d.steps_completed;
    }
    return out;
  }
}

/** NDJSON logger. One object per line, correlated by run id. */
export function makeLogger(stream = process.stderr, base = {}) {
  const counters = Object.create(null);
  return {
    log(obj) {
      counters[obj.evt] = (counters[obj.evt] ?? 0) + 1;
      stream.write(`${JSON.stringify({ t: new Date().toISOString(), ...base, ...obj })}\n`);
    },
    counters,
  };
}
