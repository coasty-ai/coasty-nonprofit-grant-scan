# AGENTS.md — authoring contract

Read by Codex, Claude Code, Cursor and anything else that opens this repo.
`CLAUDE.md` imports this file, so there is exactly one source of truth.

## What this repo is

One automation in the Coasty catalog. An AI agent is given a plain-English goal
and drives a real browser on a cloud desktop to accomplish it. The demo video is
built from the agent's own **model-input frames** — the exact images it saw —
so it can never disagree with what actually happened.

## The one rule that matters

**Never spend money without both consents.** They are deliberately separate:

| Consent | Mechanism | Guards against |
|---|---|---|
| Destination | `COASTY_ALLOW_LIVE=1` | a forgotten `COASTY_BASE_URL` reaching production |
| Cost | `--confirm-cost-cents N` (N must equal the worst case exactly) | an unbounded run |

An unset `COASTY_BASE_URL` resolves to the bundled offline mock. **Production is
never a default.** Do not add a fallback to `https://coasty.ai/v1` anywhere.

## Commands

```bash
npm start            # run offline against the bundled mock — $0, no key
npm run demo         # render media/demo.mp4 + demo.gif from real frames
npm run estimate     # print the cost before anything runs
npm test             # node --test, zero deps, offline
npm run doctor       # preflight: node, ffmpeg, key mode
```

Everything works on a fresh clone with **no `npm install`** — this repo has zero
dependencies, on purpose. Do not add one without a very good reason; `node:*`
built-ins and `ffmpeg` cover the whole pipeline.

## Layout

```
automation.json      THE unit definition. Prompt, target, budget, caps.
src/client.mjs       Coasty client: fail-closed target, retry, idempotency
src/capture.mjs      frames → mp4/gif/poster + sanity checks
src/cli.mjs          run · demo · estimate
tools/mock.mjs       the offline Coasty (real 1280×720 PNGs)
tools/doctor.mjs     preflight
test/                the suite
```

`src/` and `tools/` are **identical across all 12 repos in the catalog.** If you
change them, the change must be correct for every automation, not just this one.
Anything unit-specific belongs in `automation.json`.

## Changing what the automation does

Edit `automation.json`. Nothing else. The fields that matter:

- `task` — the prompt. It **must name `target`** verbatim and state an
  observable goal. Write what a competent human would be told, not selectors.
  A test asserts both properties.
- `expectedSteps` / `maxSteps` — the agent's step budget. `maxSteps × 5¢` is the
  worst case and must stay `<= capCents`; a test asserts this.
- `target` — the host. **Must be publicly reachable with no credentials.**

Then run `npm test && npm start`. If the prompt changed, the idempotency key
changes with it, so the next live run is a genuinely new run.

## Writing a good prompt

The prompt is the automation, so it carries the whole contract:

- **Name the full URL.** `Go to https://example.com/search` beats "the search page".
- **State the finishing condition.** The agent stops when it can report the
  thing you asked for; "monitor prices" never terminates, "report the cheapest
  title and its price" does.
- **Ask for a specific, checkable output.** Counts, names, values.
- **Do not describe the UI.** No selectors, no "click the third button" — those
  are what break on a redesign, and avoiding them is the entire point.
- **Keep it under ~24 steps.** Each step is a screenshot plus a model call.

## Never do these

- Add a real credential, cookie, token or password to `automation.json`. Every unit
  targets a publicly reachable site. The single exception is a site that publishes
  throwaway demo credentials on its own login page for exactly this purpose (e.g.
  `saucedemo.com`); using those is intended, and the README must say plainly that
  they are published test credentials, not real ones.
- Default any base URL to production.
- Commit anything under `media/` beyond what `.gitignore` allowlists (`demo.gif`
  and `poster.jpg` — the two artifacts a reader actually sees). The mp4 is larger,
  GitHub will not render it inline from a repo path, and video is regenerable.
- Weaken a check in `assertVideoSane` to make a run pass. A failing check means
  the video misrepresents the run.
- Retry a POST without an `Idempotency-Key`; it can provision a second machine
  and bill twice.

## Before opening a PR

```bash
npm test && npm start && npm run demo
```

All three must pass, offline, with no key set. CI runs the same on Node 20/22/24
across Ubuntu and Windows, plus a guard asserting the repo refuses to reach
production without explicit opt-in.

## API reference

The contract lives at <https://coasty.ai/docs/llms.txt>. The endpoints this repo
uses:

| Endpoint | Purpose | Cost |
|---|---|---|
| `POST /v1/tasks` | submit-and-forget; Coasty owns the machine lifecycle | run steps only |
| `GET /v1/runs/{id}` | poll to a terminal state | free |
| `GET /v1/runs/{id}/screenshots` | model-input frames | **free** |
| `GET /v1/runs/{id}/events` | per-step narration (SSE) | free |

Frame paging has two traps: `include_image=true` clamps a page to **10 frames**,
and `step` restarts on a retried attempt — only `index` is a safe cursor.
