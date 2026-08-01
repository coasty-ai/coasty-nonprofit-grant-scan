# CLAUDE.md

The authoring contract for this repo lives in `AGENTS.md`, imported below so
there is exactly one source of truth and no chance of the two drifting.

@AGENTS.md

## Quick orientation

- Zero dependencies. `npm test` and `npm start` work on a fresh clone with no
  install, no key and no network.
- `automation.json` is the whole unit definition. `src/` is shared verbatim
  across all 12 repos in the catalog — treat it as library code.
- The demo video is generated from the run's real model-input frames. There is
  no storyboard to keep in sync.
