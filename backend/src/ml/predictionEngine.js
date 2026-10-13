/**
 * AI Fight Prediction Engine — v5
 *
 * Serves the trained logistic model (src/ml/model-v5.json, produced by
 * trainModel.js): real per-fight stats -> statsEngine snapshots under the
 * model's stored config (shrinkage toward league priors, recency decay,
 * layoff cap, z-clipping) -> standardized feature differentials -> calibrated
 * win probability. Each feature's contribution (weight x standardized diff)
 * is computed per matchup; the top contributions become key_factors carrying
 * the actual numbers, and the narrative model is given ONLY those numbers to
 * cite. API shape and the fight_predictions cache are unchanged from v2.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const supabase = require('../db/client');
const { buildTimelines, snapshot, annotateOpponentPriors } = require('./statsEngine');
const { computeElo, eloOptions } = require('./eloEngine');
const { applySizePrior } = require('./sizePrior');
const { styleProfile } = require('./styleEngine');
const { FEATURES, DEFAULT_CONFIG, sideFeatures, diffVector, standardize } = require('./features');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = require(path.join(__dirname, 'model-v5.json'));
const MODEL_VERSION = MODEL.version || 'v5';
const CFG = { ...DEFAULT_CONFIG, ...(MODEL.config || {}) };
const PRIORS = MODEL.priors || null;
const MODEL_IDX = MODEL.features.map(n => FEATURES.indexOf(n)); // model subset -> FEATURES positions
const DATA_TTL_MS = 6 * 60 * 60 * 1000;
const THIN_SAMPLE_MINUTES = 30; // rate-stat factors cite this when a side has less stat time

// ── WEIGHT CLASS CONTEXT (unchanged from v2) ──────────────────────────────
async function deriveNaturalWeightClassId(fighterId) {
  const { data: fights } = await supabase
    .from('fights')
    .select('weight_class_id')
    .or(`fighter1_id.eq.${fighterId},fighter2_id.eq.${fighterId}`)
    .not('weight_class_id', 'is', null);
  if (!fights || fights.length === 0) return null;
  const counts = {};
  for (const f of fights) counts[f.weight_class_id] = (counts[f.weight_class_id] || 0) + 1;
  return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

async function computeWeightClassContext(f1, f2, weightClassId) {
  if (!weightClassId) return null;
  const { data: allWCs } = await supabase.from('weight_classes').select('id, name, slug, sort_order, limit_lbs');
  if (!allWCs) return null;
  const wcById = Object.fromEntries(allWCs.map(w => [w.id, w]));
  const targetWC = wcById[weightClassId];
  if (!targetWC) return null;
  const [f1NaturalId, f2NaturalId] = await Promise.all([
    deriveNaturalWeightClassId(f1.id),
    deriveNaturalWeightClassId(f2.id),
  ]);
  const f1PrimaryWC = f1NaturalId ? wcById[f1NaturalId] : null;
  const f2PrimaryWC = f2NaturalId ? wcById[f2NaturalId] : null;
  const f1Diff = (targetWC.limit_lbs != null && f1PrimaryWC?.limit_lbs != null) ? targetWC.limit_lbs - f1PrimaryWC.limit_lbs : 0;
  const f2Diff = (targetWC.limit_lbs != null && f2PrimaryWC?.limit_lbs != null) ? targetWC.limit_lbs - f2PrimaryWC.limit_lbs : 0;
  return {
    weight_class: targetWC.name,
    weight_class_slug: targetWC.slug,
    f1_primary_class: f1PrimaryWC?.name ?? null,
    f2_primary_class: f2PrimaryWC?.name ?? null,
    f1_at_natural_weight: f1Diff === 0,
    f2_at_natural_weight: f2Diff === 0,
    f1_moving_up: f1Diff > 0, f2_moving_up: f2Diff > 0,
    f1_moving_down: f1Diff < 0, f2_moving_down: f2Diff < 0,
    f1_class_diff: f1Diff, f2_class_diff: f2Diff,
    has_size_mismatch: Math.abs(f1Diff - f2Diff) >= 30,
    uncertainty_flag: Math.abs(f1Diff) >= 30 || Math.abs(f2Diff) >= 30,
  };
}

// ── DATA CACHE (fights/events loaded once per process, refreshed on TTL) ──
let dataCache = null;

async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadAll(${table}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

async function getData() {
  if (dataCache && Date.now() - dataCache.loadedAt < DATA_TTL_MS) return dataCache;
  const events = await loadAll('events', 'id, date');
  const fights = await loadAll('fights',
    'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, time_format, is_title_fight, weight_class_id, rounds_data, judge1_score, judge2_score, judge3_score');
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const timelines = annotateOpponentPriors(buildTimelines(fights, eventById));
  const elo = computeElo(fights, eventById, eloOptions(CFG));
  const wcs = await loadAll('weight_classes', 'id, limit_lbs');
  const limitByWc = Object.fromEntries(wcs.filter(w => w.limit_lbs != null).map(w => [w.id, w.limit_lbs]));
  dataCache = { timelines, elo, limitByWc, league: leagueBaselines(timelines), loadedAt: Date.now() };
  return dataCache;
}

// League baselines for the method and round engines, from the same timelines:
//   method  share of UFC wins by KO/TKO, SUB, DEC (wins with one of those methods)
//   roundRatio[r]  league output in round r relative to round 1 of the SAME fight
//                  (paired, full 5:00 rounds only, so finishes and selection into
//                  later rounds do not bias it). ~1.09 / 1.13 / 1.18 / 1.25 for R2-R5.
//   r1Pace  league sig attempts per minute in round 1
//   finishHazard[r]  { ko, sub, n }: among 5-round bouts that REACHED round r,
//                  the share ending in that round by KO/TKO or SUB (n = bouts
//                  reaching it). Rounds 4-5 drive the 5-round method extension.
function leagueBaselines(timelines) {
  const m = { ko: 0, sub: 0, dec: 0 };
  const rr = {}; let r1Att = 0, r1Sec = 0;
  const hz = {}; for (let r = 1; r <= 5; r++) hz[r] = { ko: 0, sub: 0, n: 0 };
  for (const tl of timelines.values()) {
    for (const e of tl) {
      const k = methodKey(e.method);
      if (e.result === 'win' && k) m[k]++;
      // each decided fight appears exactly once as a 'win' entry
      if (e.result === 'win' && k && e.scheduledRounds === 5) {
        const fr = k === 'dec' ? 5 : e.finishRound;
        if (fr != null) for (let r = 1; r <= Math.min(5, fr); r++) {
          hz[r].n++;
          if (k !== 'dec' && fr === r) hz[r][k]++;
        }
      }
      const r1 = e.rounds.find(r => r.no === 1);
      if (!r1 || r1.me.sig_att == null) continue;
      r1Att += r1.me.sig_att; r1Sec += r1.sec;
      if (r1.sec < 300) continue;
      for (const r of e.rounds) {
        if (r.no < 2 || r.no > 5 || r.sec < 300 || r.me.sig_att == null) continue;
        if (!rr[r.no]) rr[r.no] = { a: 0, b: 0 };
        rr[r.no].a += r.me.sig_att; rr[r.no].b += r1.me.sig_att;
      }
    }
  }
  const n = m.ko + m.sub + m.dec || 1;
  const roundRatio = { 1: 1 };
  for (let r = 2; r <= 5; r++) roundRatio[r] = rr[r]?.b ? rr[r].a / rr[r].b : 1;
  const finishHazard = {};
  for (let r = 1; r <= 5; r++) finishHazard[r] = { ko: hz[r].n ? hz[r].ko / hz[r].n : 0, sub: hz[r].n ? hz[r].sub / hz[r].n : 0, n: hz[r].n };
  return { method: { ko: m.ko / n, sub: m.sub / n, dec: m.dec / n }, roundRatio, finishHazard, r1Pace: r1Sec ? r1Att / (r1Sec / 60) : 8 };
}
const methodKey = m => (!m ? null : /KO/i.test(m) ? 'ko' : /SUB/i.test(m) ? 'sub' : /DEC/i.test(m) ? 'dec' : null);

// ── MODEL ──────────────────────────────────────────────────────────────────
const sigmoid = z => 1 / (1 + Math.exp(-z));

// diffs: full FEATURES-order vector; the model reads its own subset.
function predictProb(diffs) {
  const z = standardize(MODEL_IDX.map(k => diffs[k]), MODEL.mu, MODEL.sigma, CFG.clipZ);
  const score = z.reduce((s, x, j) => s + x * MODEL.w[j], MODEL.b);
  const rawZ = standardize(MODEL_IDX.map(k => diffs[k]), MODEL.mu, MODEL.sigma, 0);
  return { p: sigmoid(score), contributions: z.map((x, j) => x * MODEL.w[j]), rawZ };
}

// ── FACTOR EXPLANATIONS (real numbers, computed values) ───────────────────
const fmt = (v, dp = 1) => (v == null ? '?' : (+v).toFixed(dp));
// Every factor leads with the ADVANTAGED fighter (L = the fighter the model's
// contribution favors) so "who's favored" is unambiguous. The clause is chosen
// from the ACTUAL values, never from an assumed "good direction" — several model
// weights are counterintuitive (e.g. height and cardio_degradation favor the
// shorter / faster-fading fighter), so when the leader sits on the intuitively
// WORSE raw side we say so ("is favored despite …") instead of inventing an
// advantage that contradicts the printed numbers.
//   meta: sfx (per-number suffix, e.g. '%'), desc (trailing descriptor shown
//         once), dp (decimals), hib (higher-is-intuitively-better),
//         adv/despite = row clause when the leader is on the better / worse raw
//         side; advP/despiteP = the same as a bare noun phrase for prose.
const FACTOR_META = {
  slpm:              { sfx: '',  desc: 'sig strikes/min',         dp: 2, hib: true,  adv: 'lands the greater striking volume', despite: 'grades ahead despite lower volume',       advP: 'more striking volume',       despiteP: 'lower striking volume' },
  sapm:              { sfx: '',  desc: 'sig strikes/min absorbed',dp: 2, hib: false, adv: 'absorbs less damage',               despite: 'grades ahead despite absorbing more',     advP: 'less damage absorbed',       despiteP: 'more damage absorbed' },
  str_acc:           { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'is the more accurate striker',      despite: 'grades ahead despite lower accuracy',     advP: 'better striking accuracy',   despiteP: 'lower striking accuracy' },
  str_def:           { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'has the better striking defense',   despite: 'grades ahead despite weaker defense',     advP: 'better striking defense',    despiteP: 'weaker striking defense' },
  td_avg:            { sfx: '',  desc: 'TD/15min',                dp: 2, hib: true,  adv: 'holds the takedown-volume edge',    despite: 'grades ahead despite fewer takedowns',    advP: 'more takedown volume',       despiteP: 'fewer takedowns' },
  td_acc:            { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'is more accurate on takedowns',     despite: 'grades ahead despite lower TD accuracy',  advP: 'better takedown accuracy',   despiteP: 'lower takedown accuracy' },
  td_def:            { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'defends takedowns better',          despite: 'grades ahead despite weaker TD defense',  advP: 'better takedown defense',    despiteP: 'weaker takedown defense' },
  sub_avg:           { sfx: '',  desc: 'sub attempts/15min',      dp: 2, hib: true,  adv: 'is the bigger submission threat',   despite: 'grades ahead despite fewer sub attempts', advP: 'a bigger submission threat', despiteP: 'fewer submission attempts' },
  kd_per15:          { sfx: '',  desc: 'KD/15min',                dp: 2, hib: true,  adv: 'carries more knockdown power',      despite: 'grades ahead despite fewer knockdowns',   advP: 'more knockdown power',       despiteP: 'fewer knockdowns' },
  kd_absorbed_per15: { sfx: '',  desc: 'KD absorbed/15min',       dp: 2, hib: false, adv: 'is dropped less often',             despite: 'grades ahead despite being dropped more', advP: 'a sturdier chin',            despiteP: 'being dropped more often' },
  cardio_degradation:{ sfx: '%', desc: 'output drop R1→R3',       dp: 1, hib: false, adv: 'fades less into round 3',           despite: 'grades ahead despite fading more late',   advP: 'better late-round cardio',   despiteP: 'more fade late' },
  experience:        { sfx: '',  desc: 'UFC fights',              dp: 0, hib: true,  adv: 'is the more experienced fighter',   despite: 'grades ahead despite less experience',    advP: 'more UFC experience',        despiteP: 'less UFC experience' },
  win_rate:          { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'has the stronger career win rate',  despite: 'grades ahead despite a lower win rate',   advP: 'a stronger career win rate', despiteP: 'a lower career win rate' },
  recent_win_rate:   { sfx: '%', desc: 'over last 3',             dp: 0, hib: true,  adv: 'is in better recent form',          despite: 'grades ahead despite cooler form',        advP: 'better recent form',         despiteP: 'cooler recent form' },
  form_trend:        { sfx: '',  desc: 'SLpM vs career avg',      dp: 2, hib: true,  adv: 'has rising output momentum',        despite: 'grades ahead despite fading output',      advP: 'rising output momentum',     despiteP: 'fading output' },
  age:               { sfx: '',  desc: 'yrs',                     dp: 0, hib: false, adv: 'is the younger fighter',            despite: 'grades ahead despite being older',        advP: 'a youth edge',               despiteP: 'an age disadvantage' },
  layoff_days:       { sfx: '',  desc: 'days since last fight',   dp: 0, hib: false, adv: 'comes in with less ring rust',      despite: 'grades ahead despite a longer layoff',    advP: 'less ring rust',             despiteP: 'a longer layoff' },
  stats_minutes:     { sfx: '',  desc: 'min of UFC stat data',    dp: 0, hib: true,  adv: 'has the deeper statistical track record', despite: 'grades ahead despite a thinner track record', advP: 'a deeper track record', despiteP: 'a thinner track record' },
  pro_win_rate:      { sfx: '%', desc: 'pro MMA win rate',        dp: 1, hib: true,  adv: 'owns the stronger pro record',      despite: 'grades ahead despite a weaker pro record', advP: 'a stronger pro record',     despiteP: 'a weaker pro record' },
  pro_fights:        { sfx: '',  desc: 'pro fights',              dp: 0, hib: true,  adv: 'is the more seasoned pro',          despite: 'grades ahead despite fewer pro fights',   advP: 'more pro experience',        despiteP: 'less pro experience' },
  elo:               { sfx: '',  desc: 'UFC Elo',                 dp: 0, hib: true,  adv: 'holds the higher UFC rating',       despite: 'grades ahead despite the lower rating',   advP: 'a higher UFC rating',        despiteP: 'a lower UFC rating' },
  sos:               { sfx: '',  desc: 'avg opponent Elo',        dp: 0, hib: true,  adv: 'has faced the tougher schedule',    despite: 'grades ahead despite the softer schedule', advP: 'a tougher schedule',        despiteP: 'a softer schedule' },
  elo_best_win:      { sfx: '',  desc: 'best win Elo',            dp: 0, hib: true,  adv: 'owns the bigger signature win',     despite: 'grades ahead despite the lesser best win', advP: 'a bigger signature win',    despiteP: 'a lesser best win' },
  elo_trend:         { sfx: '',  desc: 'Elo change, last 3',      dp: 0, hib: true,  adv: 'is on the stronger rating run',     despite: 'grades ahead despite a rating slide',     advP: 'rating momentum',            despiteP: 'a rating slide' },
  opp_adj_slpm:      { sfx: '',  desc: 'SLpM vs opponents\' norm', dp: 2, hib: true,  adv: 'outstrikes what the opposition usually allows', despite: 'grades ahead despite below-par output for the opposition faced', advP: 'opponent-adjusted volume', despiteP: 'below-par opponent-adjusted volume' },
  opp_adj_sapm:      { sfx: '',  desc: 'SApM vs opponents\' norm', dp: 2, hib: false, adv: 'absorbs less than the opposition usually lands', despite: 'grades ahead despite absorbing more than the opposition usually lands', advP: 'opponent-adjusted defense', despiteP: 'below-par opponent-adjusted defense' },
  opp_adj_td_avg:    { sfx: '',  desc: 'TD/15 vs league-avg defense', dp: 2, hib: true, adv: 'holds the opponent-adjusted takedown edge', despite: 'grades ahead despite fewer adjusted takedowns', advP: 'opponent-adjusted takedowns', despiteP: 'fewer adjusted takedowns' },
  age_sq:            { sfx: '',  desc: 'yrs from 30, squared',     dp: 0, hib: false, adv: 'is closer to athletic prime',        despite: 'grades ahead despite being further from prime', advP: 'proximity to prime',    despiteP: 'distance from prime' },
  years_active:      { sfx: '',  desc: 'yrs in the UFC',           dp: 1, hib: true,  adv: 'has the longer UFC tenure',         despite: 'grades ahead despite the shorter tenure', advP: 'longer UFC tenure',          despiteP: 'shorter UFC tenure' },
  ko_losses_career:  { sfx: '',  desc: 'career KO losses',         dp: 0, hib: false, adv: 'has been stopped less often',       despite: 'grades ahead despite more KO losses',     advP: 'fewer career KO losses',     despiteP: 'more career KO losses' },
  ko_losses_24m:     { sfx: '',  desc: 'KO losses, last 2 yrs',    dp: 0, hib: false, adv: 'has taken less recent damage',      despite: 'grades ahead despite recent KO losses',   advP: 'less recent damage',         despiteP: 'recent KO losses' },
  fights_12m:        { sfx: '',  desc: 'fights, last 12 months',   dp: 0, hib: true,  adv: 'has been the more active fighter',  despite: 'grades ahead despite less activity',      advP: 'more recent activity',       despiteP: 'less recent activity' },
  five_round_fights: { sfx: '',  desc: '5-round bouts',            dp: 0, hib: true,  adv: 'has more five-round experience',    despite: 'grades ahead despite less five-round experience', advP: 'more five-round experience', despiteP: 'less five-round experience' },
  five_round_fights_sched: { sfx: '', desc: '5-round bouts (this is one)', dp: 0, hib: true, adv: 'brings more five-round experience to a five-round fight', despite: 'grades ahead despite less five-round experience', advP: 'five-round experience', despiteP: 'less five-round experience' },
  late_round_cardio: { sfx: '',  desc: 'R4-5 vs R1-3 output ratio', dp: 2, hib: true, adv: 'holds output better in championship rounds', despite: 'grades ahead despite fading in championship rounds', advP: 'championship-round cardio', despiteP: 'a championship-round fade' },
  natural_limit:     { sfx: '',  desc: 'lbs, natural division',    dp: 0, hib: true,  adv: 'is the naturally bigger fighter',   despite: 'grades ahead despite being the smaller fighter', advP: 'a size advantage',      despiteP: 'a size disadvantage' },
  moving_up_lbs:     { sfx: '',  desc: 'lbs above natural division', dp: 0, hib: false, adv: 'is closer to his natural weight', despite: 'grades ahead despite moving up further', advP: 'fighting nearer natural weight', despiteP: 'moving up in weight' },
  off_division_fights: { sfx: '', desc: 'fights outside modal division', dp: 0, hib: true, adv: 'has more experience outside the home division', despite: 'grades ahead despite less cross-division experience', advP: 'cross-division experience', despiteP: 'less cross-division experience' },
  // (age-30)*(elo-1500)/100: high = an older fighter carrying a high rating, which the
  // data says overstates current form; lower is better.
  age_elo:           { sfx: '',  desc: 'age × rating index',       dp: 0, hib: false, adv: 'carries less age-on-rating risk',   despite: 'grades ahead despite an aging high rating', advP: 'a rating less exposed to age', despiteP: 'an aging high rating' },
  // reach & height read as an inch advantage when the leader is the bigger one.
  reach:             { dp: 0, dim: 'reach' },
  height:            { dp: 0, dim: 'height' },
};

function factorText(feature, L, lv, tv) {
  const meta = FACTOR_META[feature];
  const a = lv[feature], b = tv[feature];
  const av = fmt(a, meta.dp), bv = fmt(b, meta.dp);
  if (meta.dim) {
    const d = fmt(Math.abs(a - b), 0);
    return a >= b
      ? `${L} has a ${d}-inch ${meta.dim} advantage (${av}" vs ${bv}")`
      : `${L} is favored despite giving up ${d} inches of ${meta.dim} (${av}" vs ${bv}")`;
  }
  const leaderOnBetterSide = meta.hib ? a >= b : a <= b;
  const clause = leaderOnBetterSide ? meta.adv : meta.despite;
  const nums = `${av}${meta.sfx} vs ${bv}${meta.sfx}${meta.desc ? ' ' + meta.desc : ''}`;
  return `${L} ${clause} (${nums})`;
}

// Top-5 model contributions as structured factors. Each carries the finished
// evidence `row` string plus fields the prose fallback reuses (leader, whether
// the leader sits on the intuitively better side, a bare noun `phrase`, `nums`).
// Rate stats rest on cage time with round data. When either side has less
// than THIN_SAMPLE_MINUTES the factor row says so (the model already shrinks
// such numbers toward the league prior; the caveat is for the reader).
const RATE_FEATURES = new Set(['slpm', 'sapm', 'str_acc', 'str_def', 'td_avg', 'td_acc', 'td_def', 'sub_avg', 'kd_per15', 'kd_absorbed_per15', 'cardio_degradation', 'form_trend']);
function thinSampleNote(feature, valsA, valsB, nameA, nameB) {
  if (!RATE_FEATURES.has(feature)) return '';
  const thin = [[nameA, valsA.stats_minutes], [nameB, valsB.stats_minutes]]
    .filter(([, m]) => m != null && m < THIN_SAMPLE_MINUTES)
    .map(([n, m]) => `${n} ${Math.round(m)} min`);
  return thin.length ? ` — thin sample: ${thin.join(', ')} of stat data` : '';
}

// A gap beyond CFG.clipZ standard deviations of the training matchups is an
// outlier: the model caps it, and it usually rests on a small or unusual
// record, so the row always says so and names each side's sample.
//   sample: { [name]: { fights, minutes } }  UFC fights / minutes of stat data
function outlierNote(z, nameA, nameB, sample) {
  if (!(Math.abs(z) > CFG.clipZ)) return '';
  const side = n => `${n} ${sample[n].fights} UFC fight${sample[n].fights === 1 ? '' : 's'} / ${Math.round(sample[n].minutes)} min of stat data`;
  return ` — outlier: ${Math.abs(z).toFixed(1)} SD from a typical matchup gap, capped at ${CFG.clipZ} SD in the model; sample: ${side(nameA)}, ${side(nameB)}`;
}

function computeFactors(nameA, nameB, valsA, valsB, contributions, rawZ, sample) {
  return contributions
    .map((c, j) => ({ feature: MODEL.features[j], c, z: rawZ[j] }))
    .filter(({ feature, c }) => Math.abs(c) > 0.01 && FACTOR_META[feature] && valsA[feature] != null && valsB[feature] != null)
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
    .slice(0, 5)
    .map(({ feature, c, z }) => {
      // c > 0 means the feature favors fighter A; phrase from the favored side.
      const leaderIsA = c > 0;
      const leader = leaderIsA ? nameA : nameB;
      const lv = leaderIsA ? valsA : valsB;
      const tv = leaderIsA ? valsB : valsA;
      const meta = FACTOR_META[feature];
      const a = lv[feature], b = tv[feature];
      const leaderBetter = meta.dim ? a >= b : (meta.hib ? a >= b : a <= b);
      const pts = Math.max(1, Math.round(Math.abs(c * 25))); // rough logit->prob-points at p~0.5
      const av = fmt(a, meta.dp), bv = fmt(b, meta.dp);
      const nums = meta.dim
        ? `${av}" vs ${bv}"`
        : `${av}${meta.sfx} vs ${bv}${meta.sfx}${meta.desc ? ' ' + meta.desc : ''}`;
      const phrase = meta.dim
        ? `a ${fmt(Math.abs(a - b), 0)}-inch ${meta.dim} ${a >= b ? 'advantage' : 'disadvantage'}`
        : (leaderBetter ? meta.advP : meta.despiteP);
      return {
        feature, leader, leaderBetter, pts, phrase, nums,
        row: `${factorText(feature, leader, lv, tv)} (~${pts} pts of win probability)${thinSampleNote(feature, valsA, valsB, nameA, nameB)}${outlierNote(z, nameA, nameB, sample)}`,
      };
    });
}

// Join a list into readable prose: "a", "a and b", "a, b, and c".
function proseList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// No-API-key fallback narrative: natural prose from the same structured factors.
// Only intuitive-direction edges are woven into "the case" / "the path" so the
// prose never reads backwards; counterintuitive factors still show as evidence
// rows but are omitted here. Purely factual — pick, probability, and numbers.
// sizeNote (from the size/weight-cut prior, or null): { favoured, before, after,
// reason } — percentages for `favoured` on skill alone and after the prior.
function fallbackNarrative(name1, name2, f1Pct, f2Pct, factors, sizeNote = null) {
  const favIsF1 = f1Pct >= f2Pct;
  const favName = favIsF1 ? name1 : name2;
  const dogName = favIsF1 ? name2 : name1;
  const favPct = favIsF1 ? f1Pct : f2Pct;
  const dogPct = favIsF1 ? f2Pct : f1Pct;
  const item = f => `${f.phrase} (${f.nums})`;
  const favSup = factors.filter(f => f.leader === favName && f.leaderBetter);
  const dogSup = factors.filter(f => f.leader === dogName && f.leaderBetter);
  const margin = favPct - dogPct;
  const pct = p => `${p.toFixed(1)}%`;

  const s1 = `The model makes ${favName} the pick at ${pct(favPct)} to ${dogName}'s ${pct(dogPct)}.`;
  let s2;
  if (sizeNote && sizeNote.favoured === favName) {
    // the prior moved the odds toward the favourite: say how much is size, not skill
    const skill = sizeNote.before >= 50
      ? `${favName} would be ${pct(sizeNote.before)}`
      : `${dogName} would be the pick at ${pct(100 - sizeNote.before)}`;
    s2 = `Most of that comes from size, not skill: on the fight statistics alone ${skill}, and a hand-set weight-cut adjustment (${sizeNote.reason}) moves ${favName} to ${pct(sizeNote.after)}.` +
      (favSup.length ? ` On the statistics, ${favName} also has ${proseList(favSup.slice(0, 2).map(item))}.` : '');
  } else {
    s2 = favSup.length
      ? `Its case is built on ${proseList(favSup.map(item))}.`
      : margin < 12
        ? `Its edge is thin and rests on small statistical margins rather than any one dominant advantage.`
        : `No single statistic carries it; the edge comes from many small margins adding up.`;
    if (sizeNote) s2 += ` A hand-set weight-cut adjustment (${sizeNote.reason}) pulls it toward ${dogName}, from ${pct(100 - sizeNote.before)} on statistics alone.`;
  }
  const s3 = dogSup.length
    ? ` ${dogName}'s path runs through ${proseList(dogSup.slice(0, 2).map(item))}.`
    : '';
  const sizeDriven = sizeNote && sizeNote.favoured === favName && sizeNote.before < 60;
  const s4 = sizeDriven ? ` The verdict rests on the size assumption rather than on fight data.`
           : margin >= 25 ? ` The model reads this as a clear edge for ${favName}.`
           : margin >= 12 ? ` On balance it gives ${favName} the nod.`
           : ` It rates the matchup close, with ${favName} a slight favorite.`;
  return s1 + ' ' + s2 + s3 + s4;
}

// ── METHOD BREAKDOWN (each fighter's own finish history, shrunk) ───────────
// How A wins = A's own UFC win-method shares, shrunk toward the league shares
// with METHOD_SHRINK pseudo-wins, so a fighter with no KO wins in ten stays near
// zero instead of borrowing the opponent's history. The opponent enters only as
// a bounded multiplier: their loss-method share (shrunk the same way) relative
// to the league, clamped to [VULN_MIN, VULN_MAX]. Shares are renormalised and
// scaled by A's win probability.
const METHOD_SHRINK = 2;
const VULN_MIN = 0.5, VULN_MAX = 1.5;

function methodCounts(timeline, result) {
  const c = { ko: 0, sub: 0, dec: 0, n: 0 };
  for (const e of timeline) {
    if (e.result !== result) continue;
    const k = methodKey(e.method);
    if (k) { c[k]++; c.n++; }
  }
  return c;
}

function computeMethodBreakdown(tlWinner, tlLoser, winProb, league) {
  const L = league.method;
  const w = methodCounts(tlWinner, 'win');
  const l = methodCounts(tlLoser, 'loss');
  const own = k => (w[k] + METHOD_SHRINK * L[k]) / (w.n + METHOD_SHRINK);
  const vuln = k => Math.min(VULN_MAX, Math.max(VULN_MIN, ((l[k] + METHOD_SHRINK * L[k]) / (l.n + METHOD_SHRINK)) / L[k]));
  const raw = { ko: own('ko') * vuln('ko'), sub: own('sub') * vuln('sub'), dec: own('dec') * vuln('dec') };
  const norm = raw.ko + raw.sub + raw.dec || 1;
  return {
    shares: { ko: raw.ko / norm, sub: raw.sub / norm, dec: raw.dec / norm },
    winProb,
    history: w,
  };
}

// Weight-cut durability shift. A fighter who has to make an extreme cut (or one
// they cannot realistically make) comes in depleted: dehydration lowers the
// ability to absorb strikes, so the opponent at (or nearer) natural weight
// finishes more often. A fraction of that opponent's SUB and DEC share moves to
// KO/TKO. Hand-set, like the size prior itself.
const CUT_KO_SHIFT = { cantMakeWeight: 0.5, extremeCut: 0.2 };

function applyCutToMethods(m, depletedMove) {
  const f = depletedMove?.cantMakeWeight ? CUT_KO_SHIFT.cantMakeWeight : depletedMove?.extremeCut ? CUT_KO_SHIFT.extremeCut : 0;
  if (!f) return { ...m, cutShift: 0 };
  const s = m.shares;
  return { ...m, cutShift: f, koBefore: s.ko, shares: { ko: s.ko + f * (s.sub + s.dec), sub: s.sub * (1 - f), dec: s.dec * (1 - f) } };
}

// Five-round extension. A fighter's method shares come from a mostly 3-round
// history, so they describe "how the fight ends inside 15 minutes". In a 5-round
// bout the decision share must survive rounds 4 and 5 as well: for each extra
// round the league finish hazard (finishHazard[r], 5-round bouts that reached
// round r) is scaled by this fighter's own finish propensity relative to the
// league (own share / league share, clamped) and that slice of the decision
// path becomes a KO/TKO or SUB path. Probability is conserved, so the shares
// still sum to 1 and the win probability is untouched.
const PROPENSITY_MIN = 0.25, PROPENSITY_MAX = 3;

function extendMethodsToRounds(m, rounds, league) {
  if (!(rounds > 3)) return { ...m, roundsExt: null };
  const L = league.method;
  const s = { ...m.shares };
  const before = { ...m.shares };
  const prop = k => Math.min(PROPENSITY_MAX, Math.max(PROPENSITY_MIN, L[k] ? s[k] / L[k] : 1));
  for (let r = 4; r <= Math.min(5, rounds); r++) {
    const h = league.finishHazard[r];
    if (!h || !h.n) continue;
    const hKo = Math.min(0.5, h.ko * prop('ko')), hSub = Math.min(0.5, h.sub * prop('sub'));
    const moved = s.dec * Math.min(1, hKo + hSub);
    const tot = hKo + hSub || 1;
    s.ko += moved * (hKo / tot); s.sub += moved * (hSub / tot); s.dec -= moved;
  }
  return { ...m, shares: s, roundsExt: { before, rounds } };
}

const methodPcts = m => ({
  ko: (m.shares.ko * m.winProb * 100).toFixed(1),
  sub: (m.shares.sub * m.winProb * 100).toFixed(1),
  dec: (m.shares.dec * m.winProb * 100).toFixed(1),
});

// ── ROUND PROJECTIONS ──────────────────────────────────────────────────────
// Scheduled rounds for a hypothetical matchup, derived from what the prediction
// already knows: the two fighters' SHARED bout history in the loaded timelines.
// Each timeline entry carries scheduledRounds (5 when time_format is "5 Rnd",
// else 3) and an isTitle flag. A title bout in their history -> 5; otherwise the
// max scheduled rounds across their shared bouts (captures 5-round main events).
// Never-fought pairings have no reliable signal -> default 3 (never 5).
// Default for the Predict page: 5 when either fighter is a current champion
// (title fights are five rounds), else whatever the pair's history says.
function defaultRounds(f1, f2, tl1) {
  if (f1.is_champion || f2.is_champion) return 5;
  return scheduledRoundsForMatchup(tl1, f2.id);
}

function scheduledRoundsForMatchup(tl1, id2) {
  const shared = (tl1 || []).filter(e => e.oppId === id2);
  if (!shared.length) return 3;
  return shared.some(e => e.isTitle)
    ? 5
    : Math.max(...shared.map(e => e.scheduledRounds || 3));
}

// Output per round = the fighter's round-1 pace x their round-r / round-1 ratio.
// The old version averaged each round over whichever fights reached it, so a
// late round rested on a handful of (mostly high-volume, decision) fights while
// round 1 included grappling-heavy openings and quick finishes — Chimaev's R3
// came from 4 fights and read 11.9 against a 6.4 R1. Now:
//   - R1 pace is shrunk toward the league R1 pace (PACE_SHRINK_MIN minutes);
//   - the ratio is PAIRED (round r vs round 1 of the same fight, full rounds
//     only), shrunk toward the league ratio with RATIO_SHRINK_FIGHTS pseudo-
//     fights, and clamped to [RATIO_MIN, RATIO_MAX] — the league itself rises
//     only ~9-25% from R1 to R2-R5.
//   - a fighter on an extreme or unrealistic cut gets no late rise (ratio <= 1)
//     and fades by CUT_FADE per round.
const PACE_SHRINK_MIN = 15;
const RATIO_SHRINK_FIGHTS = 6;
const RATIO_MIN = 0.75, RATIO_MAX = 1.35;
const CUT_FADE = { cantMakeWeight: { start: 0.9, perRound: 0.85 }, extremeCut: { start: 0.95, perRound: 0.93 } };

function roundCurve(timeline, league, rounds, move) {
  let r1Att = 0, r1Sec = 0;
  const pr = {};
  for (const e of timeline) {
    const r1 = e.rounds.find(r => r.no === 1);
    if (!r1 || r1.me.sig_att == null) continue;
    r1Att += r1.me.sig_att; r1Sec += r1.sec;
    if (r1.sec < 300 || !r1.me.sig_att) continue;
    for (const r of e.rounds) {
      if (r.no < 2 || r.no > 5 || r.sec < 300 || r.me.sig_att == null) continue;
      if (!pr[r.no]) pr[r.no] = { a: 0, b: 0, n: 0 };
      pr[r.no].a += r.me.sig_att; pr[r.no].b += r1.me.sig_att; pr[r.no].n++;
    }
  }
  const pace = (r1Att + PACE_SHRINK_MIN * league.r1Pace) / (r1Sec / 60 + PACE_SHRINK_MIN);
  const fade = move?.cantMakeWeight ? CUT_FADE.cantMakeWeight : move?.extremeCut ? CUT_FADE.extremeCut : null;
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    const Lr = league.roundRatio[r] ?? 1;
    let ratio = 1;
    if (r > 1) {
      const p = pr[r];
      const obs = p && p.b ? p.a / p.b : Lr;
      const n = p ? p.n : 0;
      ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, (n * obs + RATIO_SHRINK_FIGHTS * Lr) / (n + RATIO_SHRINK_FIGHTS)));
    }
    // a depleted fighter never gets a late-round rise, only the fade
    if (fade) ratio = Math.min(1, ratio);
    const cut = fade ? fade.start * Math.pow(fade.perRound, r - 1) : 1;
    out.push(pace * ratio * cut);
  }
  return out;
}

function computeRoundProjections(f1, f2, tl1, tl2, league, scheduledRounds = 3, move1 = null, move2 = null) {
  const c1 = roundCurve(tl1, league, scheduledRounds, move1);
  const c2 = roundCurve(tl2, league, scheduledRounds, move2);
  return c1.map((o1, i) => {
    const o2 = c2[i];
    const share = o1 / (o1 + o2 || 1);
    return {
      round: i + 1,
      f1_output: o1.toFixed(2),
      f2_output: o2.toFixed(2),
      projected_control: share > 0.52 ? `${f1.first_name} ${f1.last_name}` : share < 0.48 ? `${f2.first_name} ${f2.last_name}` : 'Even',
      f1_control_pct: (share * 100).toFixed(0),
    };
  });
}

// ── NARRATIVE (grounded: gets ONLY the computed factors and numbers) ───────
const NARRATIVE_MODEL = 'claude-opus-4-8';

// n: { rounds, weightClass, limitLbs, natural1, natural2, skill1 (null when no
// size adjustment), methods1/2 ({ ko, sub, dec } = P(win by method), summing to
// the fighter's win probability), hist1/2 }
async function generateNarrative(f1, f2, stats, keyFactors, n, model = NARRATIVE_MODEL) {
  const name1 = `${f1.first_name} ${f1.last_name}`, name2 = `${f2.first_name} ${f2.last_name}`;
  const fin = m => (parseFloat(m.ko) + parseFloat(m.sub)).toFixed(1);
  const side = (name, winPct, m, hist) =>
    `- ${name}: wins ${winPct}% = by KO/TKO ${m.ko}% + by SUB ${m.sub}% + by DEC ${m.dec}%. ` +
    `Total chance to win by finish (KO/TKO + SUB) ${fin(m)}%. ${hist}.`;
  const prompt = [
    'You are an MMA analyst for UFCDB. Write a 3-paragraph fight breakdown in plain prose.',
    '',
    'STRICT RULES:',
    '- Cite ONLY the numbers and facts listed below. Do not invent numbers, records, fight history, styles or attributes. If a dimension is not listed, do not speculate about it.',
    '- Every percentage below has a label. Keep the label when you cite it: "chance to win by KO/TKO" is not "chance to win by finish", and neither is a share of that fighter\'s wins. Do not combine, divide or re-base percentages.',
    '- The skill-only win probability (if given) is before the size adjustment; the final win probability includes it. Never present one as the other.',
    '- Do not predict a specific round, a specific method, or a scorecard type (unanimous, split, majority). Describe likely outcomes only through the listed method probabilities.',
    `- The bout is at ${n.weightClass}. Name no other weight class for the bout, and do not describe it as a "<division>-to-<division> bout". A fighter's natural division may be mentioned only as listed.`,
    '- No markdown headings, no bold titles, no bullet lists. No "in conclusion", no AI disclaimers.',
    '',
    `MATCHUP: ${name1} vs ${name2}`,
    `BOUT: ${n.weightClass}${n.limitLbs ? ` (${n.limitLbs} lb limit)` : ''}, ${n.rounds} rounds scheduled.`,
    `NATURAL DIVISION (most frequent UFC weight class): ${name1} ${n.natural1 ?? 'unknown'}; ${name2} ${n.natural2 ?? 'unknown'}.`,
    `FINAL WIN PROBABILITY: ${name1} ${stats.f1WinPct}% | ${name2} ${stats.f2WinPct}%`,
    n.skill1 != null
      ? `SKILL-ONLY WIN PROBABILITY (same-size comparison, before the hand-set size adjustment): ${name1} ${n.skill1}% | ${name2} ${(100 - n.skill1).toFixed(1)}%`
      : 'No size adjustment applies; the final win probability is the skill model\'s.',
    'METHOD PROBABILITIES (unconditional; each fighter\'s three add up to that fighter\'s final win probability):',
    side(name1, stats.f1WinPct, n.methods1, n.hist1),
    side(name2, stats.f2WinPct, n.methods2, n.hist2),
    '',
    'THE DECIDING FACTORS (model contributions, largest first):',
    ...keyFactors.map((k, i) => `${i + 1}. ${k}`),
    '',
    'Paragraph 1: the case for the favorite, citing the factors (if a size adjustment applies, say how much of the probability comes from it).',
    'Paragraph 2: the underdog\'s realistic path, citing the factors that lean their way.',
    'Paragraph 3: how the fight is likely to go, staying within the listed probabilities. Be concrete, no hedging boilerplate.',
  ].join('\n');

  const message = await anthropic.messages.create({
    model,
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text;
}

// ── CACHE ORIENTATION ──────────────────────────────────────────────────────
// fight_predictions is keyed UNIQUE(fighter1_id, fighter2_id, weight_class_id),
// so (A,B) and (B,A) are DIFFERENT rows — but the cache lookup matches either
// ordering. A row stored as (A,B) and served to a (B,A) request carries A's
// numbers under the fighter1_* prefix while the caller reads fighter1 as B, so
// the payload contradicts itself: fighter1_id !== fighter1.id.
//
// Orientation-DEPENDENT, mirrored below: the id pair, the win/ko/sub/dec
// percentages, and the per-round f1/f2 outputs. f1_control_pct is fighter1's
// SHARE of projected output, so mirroring it is 100 - x, not a swap.
//
// Orientation-INDEPENDENT, deliberately left untouched: draw_pct and confidence
// (both symmetric), weight_class_id, and — critically — key_factors,
// ai_breakdown and round_projections[].projected_control. Those three are
// RENDERED TEXT with the fighter names already interpolated at generation time;
// they read correctly in either ordering and swapping them would corrupt
// strings that are already right.
function mirrorPrediction(row) {
  const mirrorShare = v => (v == null ? v : (100 - parseFloat(v)).toFixed(0));
  return {
    ...row,
    fighter1_id:      row.fighter2_id,      fighter2_id:      row.fighter1_id,
    fighter1_win_pct: row.fighter2_win_pct, fighter2_win_pct: row.fighter1_win_pct,
    fighter1_ko_pct:  row.fighter2_ko_pct,  fighter2_ko_pct:  row.fighter1_ko_pct,
    fighter1_sub_pct: row.fighter2_sub_pct, fighter2_sub_pct: row.fighter1_sub_pct,
    fighter1_dec_pct: row.fighter2_dec_pct, fighter2_dec_pct: row.fighter1_dec_pct,
    round_projections: Array.isArray(row.round_projections)
      ? row.round_projections.map(r => ({
          ...r,
          f1_output: r.f2_output,
          f2_output: r.f1_output,
          f1_control_pct: mirrorShare(r.f1_control_pct),
          // projected_control stays as-is: it is a rendered fighter name.
        }))
      : row.round_projections,
  };
}

// Pick a cached row and return it oriented so fighter1_* refers to wantF1Id.
// Both orderings can legitimately exist as separate rows under the ordered
// unique key, so this never uses .maybeSingle() — that errors on >1 row.
// Prefer a row already in the requested orientation; otherwise mirror the
// reverse one. A row not involving wantF1Id at all is treated as a miss.
function pickCached(rows, wantF1Id) {
  if (!rows || !rows.length) return null;
  const row = rows.find(r => r.fighter1_id === wantF1Id) || rows[0];
  if (row.fighter1_id === wantF1Id) return row;
  if (row.fighter2_id === wantF1Id) return mirrorPrediction(row);
  return null;
}

// ── MAIN ───────────────────────────────────────────────────────────────────
async function generatePrediction(fighter1Id, fighter2Id, weightClassId, opts = {}) {
  const [{ data: f1 }, { data: f2 }] = await Promise.all([
    supabase.from('fighters').select('*').eq('id', fighter1Id).single(),
    supabase.from('fighters').select('*').eq('id', fighter2Id).single(),
  ]);
  if (!f1 || !f2) throw new Error('One or both fighters not found');

  if (!weightClassId) {
    // No bout weight given: use the HEAVIER fighter's natural division, so the
    // default does not depend on slot order (A-vs-B must mirror B-vs-A).
    const { limitByWc: lim } = await getData();
    const [n1, n2] = await Promise.all([deriveNaturalWeightClassId(f1.id), deriveNaturalWeightClassId(f2.id)]);
    const c1 = n1 ?? f1.primary_weight_class_id ?? null, c2 = n2 ?? f2.primary_weight_class_id ?? null;
    const l1 = c1 != null ? lim[c1] ?? -1 : -1, l2 = c2 != null ? lim[c2] ?? -1 : -1;
    weightClassId = l2 > l1 ? c2 : (c1 ?? c2);
  }
  const weightClassContext = await computeWeightClassContext(f1, f2, weightClassId);

  // Rounds requested (3 or 5), else the default. scheduled_rounds is part of
  // the cache key, so 3- and 5-round versions of a matchup are cached separately.
  const wantRounds = opts.scheduledRounds === 5 || opts.scheduledRounds === 3 ? opts.scheduledRounds : null;

  if (!opts.skipCache) {
    const cacheFilter = 'and(fighter1_id.eq.' + fighter1Id + ',fighter2_id.eq.' + fighter2Id + '),and(fighter1_id.eq.' + fighter2Id + ',fighter2_id.eq.' + fighter1Id + ')';
    let query = supabase
      .from('fight_predictions').select('*')
      .or(cacheFilter)
      .eq('model_version', MODEL_VERSION)
      .gt('expires_at', new Date().toISOString());
    // weight_class_id is part of the upsert conflict target, so it has to be
    // part of the read too — without it a lookup can straddle two weight
    // classes and return a row that was computed for a different one.
    query = weightClassId == null
      ? query.is('weight_class_id', null)
      : query.eq('weight_class_id', weightClassId);
    const { data: rows } = await query;
    // (scheduled_rounds is matched in JS below so the default can be derived once)
    const { timelines: tls } = await getData();
    const rounds = wantRounds || defaultRounds(f1, f2, tls.get(fighter1Id) || []);
    const cached = pickCached((rows || []).filter(r => (r.scheduled_rounds ?? 3) === rounds), fighter1Id);
    if (cached) {
      return { ...cached, fighter1: f1, fighter2: f2, weight_class_context: weightClassContext,
        style_profiles: { fighter1: styleProfile(snapshot(tls.get(fighter1Id) || [])), fighter2: styleProfile(snapshot(tls.get(fighter2Id) || [])) } };
    }
  }

  const { timelines, elo, limitByWc, league } = await getData();
  const tl1 = timelines.get(fighter1Id) || [];
  const tl2 = timelines.get(fighter2Id) || [];
  // Bout context the model was trained with: scheduled rounds (caller may
  // pass opts.scheduledRounds for a known 5-round bout; otherwise inferred
  // from the pair's shared history) and the bout's weight limit.
  const scheduledRounds = wantRounds || defaultRounds(f1, f2, tl1);
  const bout = { scheduledRounds, weightClassId: weightClassId ?? null, limitLbs: weightClassId != null ? (limitByWc[weightClassId] ?? null) : null };
  const today = new Date().toISOString().split('T')[0];

  // Model features: full career as of today under the model's config
  // (shrunk, decayed, capped — exactly what training saw). Raw snapshots stay
  // for the round projections, which are display numbers.
  const snap1 = snapshot(tl1), snap2 = snapshot(tl2);
  const vals1 = sideFeatures(tl1, f1, today, null, CFG, PRIORS, elo, bout, limitByWc);
  const vals2 = sideFeatures(tl2, f2, today, null, CFG, PRIORS, elo, bout, limitByWc);
  const { p: skillProb, contributions, rawZ } = predictProb(diffVector(vals1, vals2));

  // Size / weight-cut prior (sizePrior.js): a hand-set log-odds shift that
  // depends on the BOUT weight. Each fighter moves from natural division to
  // the bout limit: moving up 2+ divisions costs the escalating size penalty,
  // cutting down 2 is an extreme cut, cutting 3+ is treated as a cut the
  // fighter cannot realistically make. It is an assumption, not learned from
  // fight data — UFC cards hold no such bouts — so it is applied on top of the
  // model's skill estimate and shown as its own factor. Moves of 0-1 divisions
  // get nothing. An unknown bout weight defaults to the heavier fighter's
  // division (slot-order independent, so A-vs-B still mirrors B-vs-A).
  const size = applySizePrior(skillProb, vals1.natural_limit, vals2.natural_limit, bout.limitLbs);
  const f1WinProb = size.p;
  const f2WinProb = 1 - f1WinProb;
  const crossWeight = Math.max(Math.abs(size.a.move ?? 0), Math.abs(size.b.move ?? 0)) >= 2;

  const name1 = `${f1.first_name} ${f1.last_name}`, name2 = `${f2.first_name} ${f2.last_name}`;
  const sample = {
    [name1]: { fights: tl1.length, minutes: snap1.stats_seconds / 60 },
    [name2]: { fights: tl2.length, minutes: snap2.stats_seconds / 60 },
  };
  const factors = computeFactors(name1, name2, vals1, vals2, contributions, rawZ, sample);
  const keyFactors = factors.map(f => f.row);
  let sizeNote = null;
  if (size.shift) {
    const favoured = size.shift > 0 ? name1 : name2;
    const pFavBefore = size.shift > 0 ? size.pBefore : 1 - size.pBefore;
    const pFavAfter = size.shift > 0 ? size.p : 1 - size.p;
    const divs = n => `${n.toFixed(n % 1 ? 1 : 0)} division${Math.abs(n - 1) < 1e-9 ? '' : 's'}`;
    const describe = (name, m) => {
      if (!m.move) return null;
      if (m.cantMakeWeight) return `${name} would have to cut ${divs(m.down)} (natural ${m.natural} lb to a ${size.boutLimit} lb bout) — not a realistic weight cut`;
      if (m.extremeCut) return `${name} would have to cut ${divs(m.down)} (natural ${m.natural} lb to a ${size.boutLimit} lb bout) — an extreme cut`;
      if (m.down > 0) return `${name} drops ${divs(m.down)} (${m.natural} to ${size.boutLimit} lb) — routine, no penalty`;
      if (m.up >= 2) return `${name} moves up ${divs(m.up)} (natural ${m.natural} lb to a ${size.boutLimit} lb bout), giving away size`;
      return `${name} moves up ${divs(m.up)} (${m.natural} to ${size.boutLimit} lb) — no penalty`;
    };
    const parts = [describe(name1, size.a), describe(name2, size.b)].filter(Boolean);
    const unrealistic = size.a.cantMakeWeight ? name1 : size.b.cantMakeWeight ? name2 : null;
    sizeNote = { favoured, before: pFavBefore * 100, after: pFavAfter * 100, reason: parts.join("; ") };
    keyFactors.unshift(
      (unrealistic ? `Weight cut not realistic — ` : `Size adjustment — `) +
      `assumption, not learned from fight data: ${parts.join('; ')}. ` +
      `A hand-set prior of +${Math.abs(size.shift).toFixed(2)} log-odds toward ${favoured} moved ${favoured} from ${(pFavBefore * 100).toFixed(1)}% on skill alone to ${(pFavAfter * 100).toFixed(1)}%. ` +
      (unrealistic
        ? `The odds are shifted strongly toward the fighter at natural weight because ${unrealistic} could not realistically make this weight; the skill numbers below compare the two as if same-sized.`
        : `No UFC bouts span a gap this size, so the skill numbers below compare the two as if same-sized.`));
  }
  // Thin data on either side caps confidence at low: fewer than 2 stats-fights
  // or under THIN_SAMPLE_MINUTES of stat time. A size mismatch in the bout
  // context caps it at medium; a 2+ division natural gap forces low (the
  // probability then rests on the prior, not on evidence).
  const lowData = snap1.stats_fights < 2 || snap2.stats_fights < 2
    || snap1.stats_seconds / 60 < THIN_SAMPLE_MINUTES || snap2.stats_seconds / 60 < THIN_SAMPLE_MINUTES;
  const sizeMismatch = !!weightClassContext?.has_size_mismatch;

  // Method: each side's own finish history; a depleted opponent (extreme or
  // unrealistic cut) moves part of this side's SUB/DEC share to KO/TKO.
  const m1 = applyCutToMethods(extendMethodsToRounds(computeMethodBreakdown(tl1, tl2, f1WinProb, league), scheduledRounds, league), size.b);
  const m2 = applyCutToMethods(extendMethodsToRounds(computeMethodBreakdown(tl2, tl1, f2WinProb, league), scheduledRounds, league), size.a);
  const f1Methods = methodPcts(m1), f2Methods = methodPcts(m2);
  if (scheduledRounds > 3) {
    const pct = (sh, wp) => (sh * wp * 100).toFixed(1);
    const fin = m => `${pct(m.roundsExt.before.ko + m.roundsExt.before.sub, m.winProb)}% → ${pct(m.shares.ko + m.shares.sub, m.winProb)}%`;
    const h4 = league.finishHazard[4], h5 = league.finishHazard[5];
    keyFactors.push(
      `Five-round bout — win probability is unchanged: five-round experience and championship-round cardio features did not pass the model's evaluation gate, so the model has no learned five-round effect. ` +
      `Method shares do account for the extra time: in UFC five-round bouts, ${((h4.ko + h4.sub) * 100).toFixed(1)}% of fights reaching round 4 end there (${(h4.ko * 100).toFixed(1)}% KO/TKO, ${(h4.sub * 100).toFixed(1)}% SUB, n=${h4.n}) and ${((h5.ko + h5.sub) * 100).toFixed(1)}% of those reaching round 5 end there (n=${h5.n}); ` +
      `each fighter's decision path gives up that share, scaled by their own finish rate relative to the league. Chance of a finish: ${name1} ${fin(m1)}, ${name2} ${fin(m2)}.`);
  }
  for (const [m, name, oppName] of [[m1, name1, name2], [m2, name2, name1]]) {
    if (!m.cutShift) continue;
    const ko = p => (p * m.winProb * 100).toFixed(1);
    const cut = m.cutShift === CUT_KO_SHIFT.cantMakeWeight ? 'could not realistically make the weight' : 'would be making an extreme cut';
    keyFactors.splice(1, 0,
      `Method adjustment — ${oppName} ${cut}; a fighter depleted by the cut absorbs strikes worse (lower durability), so ` +
      `${Math.round(m.cutShift * 100)}% of ${name}'s submission and decision paths were moved to KO/TKO: ` +
      `${name} by KO/TKO ${ko(m.koBefore)}% → ${ko(m.shares.ko)}%. ${oppName}'s projected output also fades each round. Hand-set assumption, not learned from fight data.`);
  }
  const roundProjections = computeRoundProjections(f1, f2, tl1, tl2, league, scheduledRounds, size.a, size.b);
  const stats = { f1WinPct: (f1WinProb * 100).toFixed(1), f2WinPct: (f2WinProb * 100).toFixed(1) };
  const hist = m => `UFC wins ${m.history.n}: ${m.history.ko} KO/TKO, ${m.history.sub} SUB, ${m.history.dec} DEC`;

  let aiBreakdown = '';
  if (!opts.skipNarrative) {
    try {
      aiBreakdown = await generateNarrative(f1, f2, stats, keyFactors, {
        rounds: scheduledRounds,
        weightClass: weightClassContext?.weight_class ?? "an unspecified weight class",
        limitLbs: bout.limitLbs,
        natural1: weightClassContext?.f1_primary_class, natural2: weightClassContext?.f2_primary_class,
        skill1: size.shift ? (size.pBefore * 100).toFixed(1) : null,
        methods1: f1Methods, methods2: f2Methods, hist1: hist(m1), hist2: hist(m2),
      }, opts.narrativeModel);
    } catch (e) {
      console.error('AI narrative failed:', e.message);
      aiBreakdown = fallbackNarrative(name1, name2, parseFloat(stats.f1WinPct), parseFloat(stats.f2WinPct), factors, sizeNote);
    }
  }

  const probDiff = Math.abs(f1WinProb - f2WinProb);
  let confidence = probDiff > 0.25 ? 'high' : probDiff > 0.12 ? 'medium' : 'low';
  if (sizeMismatch && confidence === 'high') confidence = 'medium';
  if (lowData || crossWeight) confidence = 'low';

  const prediction = {
    fighter1_id: fighter1Id,
    fighter2_id: fighter2Id,
    weight_class_id: weightClassId || null,
    fighter1_win_pct: parseFloat(stats.f1WinPct),
    fighter2_win_pct: parseFloat(stats.f2WinPct),
    draw_pct: 2.0,
    fighter1_ko_pct: parseFloat(f1Methods.ko),
    fighter1_sub_pct: parseFloat(f1Methods.sub),
    fighter1_dec_pct: parseFloat(f1Methods.dec),
    fighter2_ko_pct: parseFloat(f2Methods.ko),
    fighter2_sub_pct: parseFloat(f2Methods.sub),
    fighter2_dec_pct: parseFloat(f2Methods.dec),
    round_projections: roundProjections,
    ai_breakdown: aiBreakdown,
    key_factors: keyFactors,
    confidence,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    model_version: MODEL_VERSION,
    scheduled_rounds: scheduledRounds,
  };

  if (!opts.skipCache) {
    await supabase.from('fight_predictions')
      .upsert(prediction, { onConflict: 'fighter1_id,fighter2_id,weight_class_id,scheduled_rounds' });
  }

  return { ...prediction, fighter1: f1, fighter2: f2, weight_class_context: weightClassContext,
    style_profiles: { fighter1: styleProfile(snap1), fighter2: styleProfile(snap2) } };
}

// Current (full-career, raw) style profile for one fighter — the same
// function the model path uses, so Compare / Predict / Styles pages read one
// definition. Returns styleEngine's { axes, label, hasData }.
async function getStyleProfile(fighterId) {
  const { timelines } = await getData();
  return styleProfile(snapshot(timelines.get(fighterId) || []));
}

module.exports = { generatePrediction, getStyleProfile, pickCached, mirrorPrediction };
