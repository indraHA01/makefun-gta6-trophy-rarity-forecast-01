// gta6-trophy-rarity-forecast-01 — a calibrated trophy-rarity forecaster (Node 22, stdlib only).
//
// Forecast, for every GTA VI trophy on PlayStation 5, its earn rate on Exophase at the
// case's target, as five quantiles a trophy, scored by pinball loss on the logit scale.
//
// The model — a log-time adoption curve, shrunk toward a class prior, with an honest
// spread — rests on three facts about how trophy rates move in a launch week:
//
//   1. A trophy's earn rate is an adoption curve in log-time. Players join over days
//      and progress through the game over days, so logit(rate) is roughly linear in
//      ln(1 + days since release). The program fits that line per trophy on the case's
//      own distinct reads (Exophase refreshes in steps, so identical consecutive reads
//      are collapsed to one snapshot first) and reads it at the target.
//
//   2. Two days of history cannot identify a 7-day curve on its own, so the fit is
//      shrunk toward a class prior: each trophy is classified from its own name and
//      description (story chapter, finale, 100% completion, platinum, grind, side
//      mission, light activity) and given a day-7 prior rate grounded in the
//      comparable Rockstar launches — GTA V on Exophase (PS5, 236k players tracked:
//      first story mission 46.9%, mid-story 15–24%, final mission 15.4%, 100%
//      completion 4.6%, platinum 3.75%, collectible sets ~5.4%, explore-all 6.0%),
//      scaled down for week one, when far fewer players have finished a ~50-hour
//      campaign and the tracked population is still diluting with new buyers
//      (Insider Gaming's pre-launch estimate: ~50 h to roll credits, ~200 h to
//      platinum). The prior curve is anchored at the trophy's last observed rate and
//      runs to its class's day-7 rate, so a short horizon barely moves it and a
//      7-day horizon lands on it.
//
//   3. Exophase refreshes in lumps, and a refresh dilutes: the first refresh on
//      launch night took the tracked players from 638 to 3,868 and every rate but
//      the 100% one fell, because the new cohort had barely played. When a case's
//      history is perfectly flat (no refresh yet seen) and the checkpoint is on
//      launch night, the program expects the next refresh to dilute the rates and
//      says so with a wide spread; when the history already shows refreshes, the
//      fit has absorbed them and no extra dilution is applied.
//
// The spread is the honest predictive standard deviation of logit(rate) at the
// target: a random-walk term growing with the horizon, a refresh-shock term, the
// fit's residual, and a class term for rare/grind trophies. Quantiles are the
// median shifted by the normal quantiles times that spread.
//
// Deterministic: pure functions of the case file, no clock, no randomness, no
// network. Runs in milliseconds per case.
//
// Input:  every <id>.in in $MAKEFUN_INPUT_DIR (else /input), schema
//          "makefun/gta6-trophies-case/v1".
// Output: <id>.out in $MAKEFUN_OUTPUT_DIR (else /output):
//          {"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}, ...]}

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: Read[];
  notes: string;
}

/** One distinct Exophase snapshot: consecutive identical reads collapsed to one. */
interface Snapshot {
  /** Hours since the game's release. */
  hours: number;
  players: number;
  rates: Array<number | null>;
}

/** A trophy's class, from its own name and description. */
type TrophyClass =
  | 'saturated' // everyone tracked already has it (first mission): stays near 100%
  | 'chapter' // "Complete Chapter N": story progression, ordered by chapter
  | 'finale' // "Complete the final mission"
  | 'completion100' // "Attain 100% Completion"
  | 'platinum' // the platinum
  | 'storyside' // a named story/side mission strand
  | 'grind' // a large-count grind: 250 stunts, 100 locations, gold medals, 50 challenges
  | 'activity'; // light activity: try/win/complete once, discover, spend, explore

interface ClassInfo {
  cls: TrophyClass;
  /** Chapter number for 'chapter', else 0. */
  chapter: number;
  /** The class's day-7 prior earn rate, in percent. */
  prior7: number;
  /** Extra logit spread for this class (rare/grind trophies are less predictable). */
  extraSigma: number;
}

/**
 * Day-7 prior rates, in percent. Grounded in GTA V's Exophase PS5 page (236,467
 * players tracked, long-run rates) and scaled down for week one: first story
 * mission 46.9% long-run, mid-story 15–24%, final mission 15.4%, 100% completion
 * 4.6%, platinum 3.75%, collectible sets ~5.4%, explore-all 6.0%, easy activities
 * up to 62%. A week after launch far fewer players have finished a ~50-hour
 * campaign, and the tracked population is still diluting with new buyers, so
 * late-story and completion rates sit well below their long-run levels while
 * early-story rates sit near them: launch-week players are the keenest.
 */
const CHAPTER_PRIOR7 = [0, 52, 42, 34, 27, 22]; // index by chapter number
const CLASS_PRIOR7: Record<TrophyClass, number> = {
  saturated: 97,
  chapter: 34, // refined by chapter number below
  finale: 12,
  completion100: 1.2,
  platinum: 0.25,
  storyside: 9,
  grind: 1.5,
  activity: 6,
};
const CLASS_SIGMA: Record<TrophyClass, number> = {
  saturated: 0.1,
  chapter: 0.25,
  finale: 0.35,
  completion100: 0.45,
  platinum: 0.5,
  storyside: 0.3,
  grind: 0.45,
  activity: 0.3,
};

/** The first number in a description, e.g. "Complete 250 Stunts" -> 250. */
function firstCount(text: string): number | null {
  const m = /(\d[\d,]*)/.exec(text);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function classify(t: Trophy, lastRate: number): ClassInfo {
  const d = t.description;
  const lower = d.toLowerCase();
  if (t.tier === 'platinum') {
    return { cls: 'platinum', chapter: 0, prior7: CLASS_PRIOR7.platinum, extraSigma: CLASS_SIGMA.platinum };
  }
  if (lastRate >= 99) {
    return { cls: 'saturated', chapter: 0, prior7: CLASS_PRIOR7.saturated, extraSigma: CLASS_SIGMA.saturated };
  }
  const chapterMatch = /complete chapter (\d+)/i.exec(d);
  if (chapterMatch) {
    const n = parseInt(chapterMatch[1], 10);
    const prior = CHAPTER_PRIOR7[Math.min(n, CHAPTER_PRIOR7.length - 1)] ?? 22;
    return { cls: 'chapter', chapter: n, prior7: prior, extraSigma: CLASS_SIGMA.chapter };
  }
  if (/complete the final mission/i.test(d)) {
    return { cls: 'finale', chapter: 0, prior7: CLASS_PRIOR7.finale, extraSigma: CLASS_SIGMA.finale };
  }
  if (/100% completion/i.test(d)) {
    return { cls: 'completion100', chapter: 0, prior7: CLASS_PRIOR7.completion100, extraSigma: CLASS_SIGMA.completion100 };
  }
  const count = firstCount(d);
  // A big count is a grind when it is repetitive doing, not discovering: "Discover
  // 100 vehicles" is exploration a player does by playing, "Complete 250 Stunts"
  // is 250 repetitions. Keep the count rule off discovery/exploration verbs.
  const isDiscovery = /discover|explore/i.test(d);
  const isGrind =
    /gold medal in all/i.test(d) ||
    /complete \d+ challenges/i.test(d) ||
    /collectible card sets/i.test(d) ||
    (count !== null && count >= 50 && !isDiscovery);
  if (isGrind) {
    return { cls: 'grind', chapter: 0, prior7: CLASS_PRIOR7.grind, extraSigma: CLASS_SIGMA.grind };
  }
  const isStorySide =
    /complete the final mission for/i.test(d) ||
    (/^complete [A-Z]/.test(d) && t.secret) ||
    (/strangers/i.test(d) && /mission strands/i.test(d));
  if (isStorySide) {
    return { cls: 'storyside', chapter: 0, prior7: CLASS_PRIOR7.storyside, extraSigma: CLASS_SIGMA.storyside };
  }
  const prior = t.tier === 'silver' ? 8 : CLASS_PRIOR7.activity;
  return { cls: 'activity', chapter: 0, prior7: prior, extraSigma: CLASS_SIGMA.activity };
}

/** Collapse consecutive identical reads (same players + same rates) to one snapshot. */
function distinctSnapshots(c: Case, releaseMs: number): Snapshot[] {
  const out: Snapshot[] = [];
  let prevKey = '';
  for (const h of c.history) {
    const key = `${h.players_tracked}|${h.rates.join(',')}`;
    if (key === prevKey) continue;
    prevKey = key;
    out.push({
      hours: (Date.parse(h.at) - releaseMs) / 3_600_000,
      players: h.players_tracked,
      rates: h.rates,
    });
  }
  return out;
}

/** Least-squares line y = a + b*x; returns [a, b, residualStd]. */
function fitLine(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-9 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return [a, b, resid];
}

/**
 * Forecast one trophy: median rate at the target (percent) and logit spread.
 *
 * - x(t) = ln(1 + days since release): the adoption clock. The prior curve runs
 *   from the trophy's last observed rate at the checkpoint to its class's day-7
 *   prior at day 7. The data curve is the least-squares line of logit(rate) on
 *   x over the case's distinct snapshots, read at the target.
 * - The median blends the two, weighted by how many distinct snapshots the case
 *   actually shows: a flat launch-night history leans on the prior, a two-day
 *   history with real movement leans on its own line.
 * - A flat history on launch night also expects the next Exophase refresh to
 *   dilute the rates (launch night's first refresh took 638 -> 3,868 players and
 *   every non-100% rate fell to about a fifth): the median's odds are scaled
 *   down, except for a saturated trophy, which new players earn first.
 */
function forecastTrophy(
  c: Case,
  snaps: Snapshot[],
  idx: number,
  info: ClassInfo,
  xLast: number,
  xTarget: number,
  horizonDays: number,
): { median: number; sigma: number } {
  const lastSnap = snaps[snaps.length - 1];
  const lastRate = clampPct(lastSnap.rates[idx] ?? 0.01);

  // The prior curve: anchored at the last observed rate, ending at the day-7 prior.
  const x7 = Math.log(1 + 7);
  const span = Math.max(x7 - xLast, 1e-6);
  const frac = Math.min(Math.max((xTarget - xLast) / span, 0), 1.5);
  const priorLogit = logit(lastRate) + (logit(info.prior7) - logit(lastRate)) * frac;

  // The data curve: least squares of logit(rate) on x over distinct snapshots.
  let fitLogit: number | null = null;
  let fitResid = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of snaps) {
    const r = s.rates[idx];
    if (r === null || r === undefined) continue;
    xs.push(Math.log(1 + Math.max(s.hours, 0) / 24));
    ys.push(logit(r));
  }
  if (xs.length >= 3) {
    const [a, bRaw, resid] = fitLine(xs, ys);
    const b = Math.min(4, Math.max(-3, bRaw));
    fitLogit = a + b * xTarget;
    fitResid = resid;
  }

  // Blend: the more distinct snapshots, the more the case's own line counts.
  const nd = snaps.length;
  let w = nd >= 3 ? nd / (nd + 4) : 0;
  if (fitResid > 0.5) w *= 0.7;
  let medianLogit = fitLogit === null ? priorLogit : w * fitLogit + (1 - w) * priorLogit;

  // Launch-night dilution: a flat history means no refresh has been seen yet, and
  // the next one reveals a much larger, much less progressed cohort.
  const flatHistory = nd <= 1;
  const hoursSinceRelease = Math.max(xLast, 0) * 24;
  if (flatHistory && hoursSinceRelease <= 36 && horizonDays <= 0.25 && info.cls !== 'saturated') {
    const dilution = 0.35 + 0.65 * (lastRate / 100); // saturated trophies dilute least
    medianLogit += Math.log(dilution);
  }

  const median = clampPct(invLogit(medianLogit));

  // The spread: random-walk growth with horizon, a refresh shock while the
  // history is flat, the fit's residual, and the class's own unpredictability.
  const base = 0.55 * Math.sqrt(horizonDays);
  const shock = flatHistory ? 1.0 : 0.35;
  const sigma = Math.min(
    2.0,
    Math.max(0.4, Math.sqrt(base * base + shock * shock + fitResid * fitResid + info.extraSigma * info.extraSigma)),
  );
  return { median, sigma };
}

/** Enforce the story chain on medians: Ch1 >= Ch2 >= Ch3 >= Ch4 >= finale. */
function enforceChain(
  trophies: Trophy[],
  infos: ClassInfo[],
  medians: number[],
): number[] {
  const out = medians.slice();
  const chain: Array<{ chapter: number; idx: number }> = [];
  let finaleIdx = -1;
  let completionIdx = -1;
  let platinumIdx = -1;
  trophies.forEach((t, i) => {
    if (infos[i].cls === 'chapter') chain.push({ chapter: infos[i].chapter, idx: i });
    if (infos[i].cls === 'finale') finaleIdx = i;
    if (infos[i].cls === 'completion100') completionIdx = i;
    if (infos[i].cls === 'platinum') platinumIdx = i;
  });
  chain.sort((a, b) => a.chapter - b.chapter);
  const order = chain.map((e) => e.idx);
  if (finaleIdx >= 0) order.push(finaleIdx);
  let cap = Infinity;
  for (const i of order) {
    out[i] = Math.min(out[i], cap);
    cap = out[i];
  }
  // 100% completion cannot exceed finishing the story; platinum cannot exceed it.
  if (completionIdx >= 0 && finaleIdx >= 0) out[completionIdx] = Math.min(out[completionIdx], out[finaleIdx]);
  if (platinumIdx >= 0 && completionIdx >= 0) out[platinumIdx] = Math.min(out[platinumIdx], out[completionIdx]);
  return out;
}

function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${c.id} has no history`);
  const releaseMs = Date.parse(c.game.release_date);
  const snaps = distinctSnapshots(c, releaseMs);
  const lastSnap = snaps[snaps.length - 1];
  const xLast = Math.log(1 + Math.max(lastSnap.hours, 0) / 24);
  const horizonDays = c.horizon_minutes / 1440;
  const targetMs = Date.parse(c.target);
  const xTarget = Math.log(1 + Math.max((targetMs - releaseMs) / 86_400_000, 0));

  const infos = c.trophies.map((t, i) => classify(t, clampPct(lastSnap.rates[i] ?? 0.01)));
  const medians: number[] = [];
  const sigmas: number[] = [];
  c.trophies.forEach((t, i) => {
    const f = forecastTrophy(c, snaps, i, infos[i], xLast, xTarget, horizonDays);
    medians.push(f.median);
    sigmas.push(f.sigma);
  });
  const fixed = enforceChain(c.trophies, infos, medians);

  const trophies = c.trophies.map((t, i) => {
    const l = logit(fixed[i]);
    const qs: number[] = [];
    let prev = -Infinity;
    for (const z of Z) {
      const q = Math.min(99.99, Math.max(0.01, round4(invLogit(l + z * sigmas[i]))));
      qs.push(Math.max(q, prev));
      prev = qs[qs.length - 1];
    }
    return { id: t.id, q: qs };
  });
  return { trophies };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecastCase(c))}\n`);
}
