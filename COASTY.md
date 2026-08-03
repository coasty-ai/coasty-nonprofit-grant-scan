# Coasty API — what this repo uses

A working reference for the parts of the [Coasty](https://coasty.ai) computer-use
API this automation touches. The full contract is at
<https://coasty.ai/docs> (human) and <https://coasty.ai/docs/llms.txt> (machine).

- **Base URL** `https://coasty.ai/v1`
- **Auth** `X-API-Key: <key>` (or `Authorization: Bearer <key>`)
- **Keys** <https://coasty.ai/developers/keys>

---

## 1. Get a key

Create one at **<https://coasty.ai/developers/keys>**. The raw key is shown
**exactly once** — store it when it appears. Cap is 20 active keys per account.

| Prefix | Kind | Bills your wallet? |
| --- | --- | --- |
| `sk-coasty-test-<48 hex>` | sandbox | **No — free** |
| `sk-coasty-live-<48 hex>` | live | Yes |
| `cua_sk_<48 hex>` | legacy | Yes (accepted through 2026-11-01) |

Start with a **sandbox key**. It uses the same wire schemas as live and never
debits your wallet; responses carry `X-Coasty-Test-Mode: true` and
`X-Credits-Charged: 0`.

New keys already carry `runs:read` and `runs:write`, which is everything this
automation needs — nothing extra to enable.

```bash
export COASTY_API_KEY=sk-coasty-test-...   # from the link above
export COASTY_BASE_URL=https://coasty.ai/v1
export COASTY_ALLOW_LIVE=1                 # destination consent (see §5)
npm start -- --live --confirm-cost-cents <N>
```

`npm run doctor` tells you which mode you are in before you run anything.

---

## 2. The four endpoints this repo calls

### `POST /v1/tasks` — submit and forget

The highest-level surface. You send one goal; Coasty provisions its own
ephemeral desktop, drives the agent, and destroys the machine afterwards. You
never manage a VM.

Only `task` is required.

```jsonc
{
  "task": "Sign on and report the largest submission's accession number",
  "cua_version": "v5",        // default v5; also v1, v3, v4
  "max_steps": 150,           // 1-1000, server-clamped
  "deadline_seconds": 900,    // end-to-end wall clock, includes provisioning
  "action_policy": { },       // enforced post-model controls
  "webhook_url": "https://…", // HTTPS only
  "machine": { "os_type": "linux", "desktop_enabled": true }
}
```

Returns a normal durable **Run** object, so everything below works on it.
`machine_id` is `null` while provisioning — that is expected, not an error.

### `GET /v1/runs/{id}` — poll to a terminal state

Terminal states: `succeeded`, `failed`, `cancelled`, `timed_out`. A task never
enters `awaiting_human` — it is hardwired to keep going.

### `GET /v1/runs/{id}/screenshots` — the model-input frames · **free**

> *the exact images the agent was looking at before each decision. Captured for
> every run, managed and BYOK alike.*

This is what the demo video in this repo is built from.

```bash
curl "$BASE/runs/$RUN_ID/screenshots?include_image=true&after_index=9" \
  -H "X-API-Key: $COASTY_API_KEY"
```

Two traps worth knowing:

- **`include_image=true` clamps a page to 10 frames.** Paging is mandatory even
  for short runs. Page with `after_index=<last index you saw>`.
- **`index` is the only safe cursor.** It is flat and monotonic across the whole
  run; `step` restarts at 1 on a retried attempt, so `step` alone is not unique.

Also: `degraded: true` means capture failed and the agent acted on a reused
frame — check it first if a run did something inexplicable. `width`/`height` are
the **model coordinate space**, not necessarily the machine's resolution.

### `GET /v1/runs/{id}/events` — per-step narration (SSE) · free

Frames are `id:` / `event:` / `data:`. Reconnect with `Last-Event-ID: <seq>`;
events are durable and the seq is the cursor, so nothing is lost or duplicated.

---

## 3. What it costs

1 credit = 1 cent = $0.01, exactly.

| Item | Credits |
| --- | --- |
| Run step (v3 / v4 / v5) | **5** |
| Run step (v1) | 8 |
| Model-input frames, events, run polling | **0** |
| Machine running — Linux | 5/hour |
| Machine running — Windows | 9/hour |
| Machine stopped | 1/hour |

So a 20-step task on v5 is 100 credits ($1.00) plus a few minutes of machine
runtime. `npm run estimate` prints this repo's exact numbers before anything runs.

Charges are debited up front and auto-refunded on failure. Runtime is metered
per minute, rounded down.

---

## 4. Errors

Every response carries `X-Coasty-Request-Id`; errors repeat it as
`error.request_id`. It is the one useful thing to quote in a support ticket, so
this repo attaches it to every error and every log line.

**Branch on `error.code`, never on `error.message`.**

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | `INVALID_API_KEY` | key is wrong, revoked, or malformed |
| 402 | `INSUFFICIENT_CREDITS` | wallet cannot cover the operation |
| 403 | `INSUFFICIENT_SCOPE` | key lacks a required scope |
| 404 | `RUN_NOT_FOUND` | wrong id, or wrong key mode — ids are mode-isolated |
| 409 | `INVALID_STATE` | illegal transition; carries `allowed_from` |
| 422 | `IDEMPOTENCY_KEY_REUSED` | same key, different body |
| 429 | `RATE_LIMITED` | honour `Retry-After` |
| 5xx | `INTERNAL_ERROR`, `UPSTREAM_UNAVAILABLE` | retryable |

Retry 429 and 5xx with backoff. **Retry a POST only when you sent an
`Idempotency-Key`** — an unkeyed retry can provision a second machine and bill
twice. `src/client.mjs` implements exactly this policy.

---

## 5. Spending safely

This repo separates two consents that are easy to conflate:

| Consent | Mechanism | Guards against |
| --- | --- | --- |
| **Destination** | `COASTY_ALLOW_LIVE=1` | a forgotten `COASTY_BASE_URL` reaching production |
| **Cost** | `--confirm-cost-cents N` | an unbounded run |

An unset `COASTY_BASE_URL` resolves to the bundled offline mock. **Production is
never a default.** A live key alone will not spend; a base URL alone will not
spend.

The submit key is derived from the prompt hash, so a retried submit returns the
original run rather than starting a second one.

---

## 6. Beyond this repo

Coasty exposes three layers, smallest to largest:

1. **Core inference** — `/v1/predict`, `/v1/sessions`, `/v1/ground`, `/v1/parse`.
   You supply screenshots and instructions; Coasty returns actions.
2. **Runs** — `/v1/runs` gives the agent a task *and a machine you own*, with
   optional human takeover. `/v1/tasks` (used here) is the managed version.
3. **Workflows** — `/v1/workflows`, a versioned DSL composing runs with
   branching, loops, retries and approval gates.

Machines (`/v1/machines`) let you provision and keep a desktop yourself, when
you want it to outlive a single task.

| Resource | Link |
| --- | --- |
| Docs | <https://coasty.ai/docs> |
| Full API contract (machine-readable) | <https://coasty.ai/docs/llms.txt> |
| API keys | <https://coasty.ai/developers/keys> |
| Cookbook — every endpoint, 4 languages | <https://github.com/coasty-ai/computer-use-cookbook> |
| open-cowork — an AI coworker on this API | <https://github.com/coasty-ai/open-cowork> |
| The full 12-automation catalog | <https://github.com/coasty-ai> |
