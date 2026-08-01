/**
 * Offline portal renderer: turns a unit's `portal` block into a sequence of
 * 1280x720 frames that read like a real browser working through that task.
 *
 * These are the frames anyone who clones the repo and runs `npm run demo` with
 * no key will see, so they have to be a genuine demonstration of THAT site.
 * A flow is a list of scenes, each drawn by the archetype the real page uses
 * (tools/scenes.mjs) — a grid dashboard, a chemical datasheet and a storefront
 * are not the same page with different words, and should not render as if they
 * were.
 *
 * Zero dependencies.
 */
import * as S from './scenes.mjs';

const { Canvas, W, H } = S;

/**
 * Spread `total` steps across scenes by weight, guaranteeing every scene gets
 * at least one step (a beat that never renders is a beat the author cannot see
 * is broken) and that the LAST scene owns the final step, where the answer is
 * revealed.
 */
export function planSteps(scenes, total) {
  const weights = scenes.map((s) => Math.max(1, s.steps ?? defaultWeight(s.kind)));
  const sum = weights.reduce((a, b) => a + b, 0);
  let counts = weights.map((w) => Math.max(1, Math.round((w / sum) * total)));
  // Reconcile rounding against the real step budget.
  let drift = counts.reduce((a, b) => a + b, 0) - total;
  for (let i = counts.length - 1; drift > 0 && i >= 0; i = i === 0 ? counts.length - 1 : i - 1) {
    if (counts[i] > 1) {
      counts[i]--;
      drift--;
    } else if (counts.every((c) => c === 1)) break;
  }
  while (drift < 0) {
    counts[counts.length - 1]++;
    drift++;
  }
  const plan = [];
  let at = 1;
  counts.forEach((c, i) => {
    plan.push({ scene: scenes[i], from: at, to: at + c - 1 });
    at += c;
  });
  return plan;
}

const defaultWeight = (kind) =>
  ({ load: 1, login: 2, search: 3, table: 4, cards: 4, fields: 4, dashboard: 4, datasheet: 3, detail: 2 })[kind] ?? 2;

/** How far through its own scene this step is, 0..1. */
const progress = (step, from, to) => (to === from ? 1 : (step - from) / (to - from));

/**
 * Reveal n of `len` items by scene progress, all of them at the end.
 *
 * The floor is deliberately NOT 1. A page that draws its heading and a single
 * row under 400px of white does not read as "rendering"; it reads as "this
 * failed to load", and it was the single most common complaint against these
 * demos — every multi-step scene in every unit opened on one item. So a scene's
 * first beat already shows two thirds of the list (at least three), and each
 * later beat adds to it. Consecutive beats can therefore repeat content: that
 * is correct, because an agent taking several screenshots while it reads a
 * loaded table really does see the same table each time.
 */
const reveal = (p, len) => {
  if (p >= 1) return len;
  const floor = Math.min(len, Math.max(3, Math.ceil((len * 2) / 3)));
  return Math.min(len, floor + Math.round(p * (len - floor)));
};

/**
 * Characters typed so far. Typing is the one reveal that must start empty: a
 * search box that opens half-filled does not read as an agent typing into it.
 */
const typing = (p, len) => (p >= 1 ? len : Math.max(1, Math.ceil(p * len)));

export function renderFrame(unit, step, total) {
  const p = unit.portal ?? {};
  const C = S.theme(p.theme);
  const url = p.url ?? `https://${unit.target}`;
  const scenes = Array.isArray(p.scenes) && p.scenes.length ? p.scenes : legacyScenes(p);
  const plan = planSteps(scenes, total);
  const cur = plan.find((x) => step >= x.from && step <= x.to) ?? plan[plan.length - 1];
  const sc = cur.scene;
  const t = progress(step, cur.from, cur.to);
  const last = step >= total;

  const cv = new Canvas(W, H, C.page);

  if (sc.kind === 'load') {
    S.chrome(cv, C, sc.url ?? url, { loading: true, progress: 0.2 + 0.6 * t });
    cv.fill(0, 84, W, H - 84 - S.STATUS_H, [252, 253, 255]);
    S.drawText(cv, sc.text ?? 'Loading...', 40, 140, C.muted, 3);
    S.status(cv, step, total, sc.status ?? `Navigating to ${hostOf(sc.url ?? url)}`);
    return cv.toPNG();
  }

  S.chrome(cv, C, sc.url ?? url);
  const top = S.masthead(cv, C, sc.site ?? p.site ?? unit.target, sc.nav ?? p.nav ?? [], {
    sub: sc.sub ?? p.sub ?? '',
  });

  switch (sc.kind) {
    case 'login': {
      const fs = (sc.fields ?? []).map(([label, value], i) => {
        // Type the fields in order across the scene.
        const share = 1 / Math.max(1, sc.fields.length);
        const local = Math.min(1, Math.max(0, (t - i * share) / share));
        return [label, sc.mask && i === sc.fields.length - 1
          ? '*'.repeat(Math.round(local * String(value).length))
          : String(value).slice(0, Math.round(local * String(value).length))];
      });
      const typedIdx = Math.min(sc.fields.length - 1, Math.floor(t / (1 / Math.max(1, sc.fields.length))));
      S.login(cv, C, top, { title: sc.title, fields: fs, typedIdx: last ? -1 : typedIdx, note: sc.note });
      S.status(cv, step, total, sc.status ?? 'Signing in with the published demo credentials');
      return cv.toPNG();
    }

    case 'search': {
      const typed = String(sc.query ?? '').slice(0, typing(t, String(sc.query ?? '').length));
      S.searchBox(cv, C, top, {
        label: sc.label,
        typed,
        hint: sc.hint,
        focused: !last,
        submitted: last,
        button: sc.button ?? 'Search',
      });
      S.status(cv, step, total, sc.status ?? `Typing "${typed}"`);
      return cv.toPNG();
    }

    case 'table': {
      let y = top;
      if (sc.query !== undefined) {
        y = S.searchBox(cv, C, top, { label: sc.label, typed: sc.query, hint: '', focused: false, submitted: true, button: sc.button ?? 'Search' });
      }
      const rows = sc.rows ?? [];
      S.table(cv, C, y, {
        columns: sc.columns ?? [],
        rows,
        visible: reveal(t, rows.length),
        highlight: last ? sc.answerRow ?? rows.length - 1 : -1,
        note: sc.note ?? '',
      });
      break;
    }

    case 'cards': {
      let y = top;
      if (sc.query !== undefined) {
        y = S.searchBox(cv, C, top, { label: sc.label, typed: sc.query, hint: '', focused: false, submitted: true, button: sc.button ?? 'Search' });
      }
      const items = sc.items ?? [];
      S.cards(cv, C, y + 8, {
        items,
        visible: reveal(t, items.length),
        highlight: last ? sc.answerRow ?? -1 : -1,
        cols: sc.cols ?? 3,
        note: sc.note ?? '',
      });
      break;
    }

    case 'fields': {
      const fs = sc.fields ?? [];
      S.fields(cv, C, top + 10, {
        title: sc.title,
        fields: fs,
        visible: reveal(t, fs.length),
        highlight: last ? sc.answerRow ?? -1 : -1,
        cols: sc.cols ?? 2,
      });
      break;
    }

    case 'dashboard': {
      const tiles = sc.tiles ?? [];
      const series = sc.series ?? [];
      S.dashboard(cv, C, top + 16, {
        tiles,
        series,
        visible: reveal(t, tiles.length + series.length),
        highlight: last ? sc.answerRow ?? -1 : -1,
        note: sc.note ?? '',
      });
      break;
    }

    case 'datasheet': {
      const rows = sc.rows ?? [];
      S.datasheet(cv, C, top + 10, {
        title: sc.title,
        subtitle: sc.subtitle,
        rows,
        visible: reveal(t, rows.length),
        highlight: last ? sc.answerRow ?? -1 : -1,
        note: sc.note ?? '',
      });
      break;
    }

    default: {
      S.drawText(cv, sc.text ?? '', 40, top + 30, C.ink, 3);
    }
  }

  S.status(cv, step, total, last ? p.answer ?? sc.status ?? 'Reporting the result' : sc.status ?? 'Reading the page');
  return cv.toPNG();
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

/** Back-compat: a flat `portal` block (no `scenes`) becomes load → search → table. */
function legacyScenes(p) {
  return [
    { kind: 'load' },
    { kind: 'search', label: p.label, query: p.query, hint: p.hint },
    {
      kind: 'table',
      label: p.label,
      query: p.query,
      columns: p.columns ?? [],
      rows: p.rows ?? [],
      answerRow: p.answerRow,
      note: p.note ?? (p.total ? `${p.total} results` : ''),
    },
  ];
}
