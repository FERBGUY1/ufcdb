const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// GET /api/track-record
// Every logged pick from prediction_log (written before each event, never
// edited) plus summary metrics over the graded ones. Void picks (draw, no
// contest, cancelled or changed bout) are listed but excluded from metrics.
//
// Toss-ups (rule fixed 2026-10-15, before any pick was graded): a pick whose
// win probability is under TOSSUP_PCT is labelled a toss-up and left out of
// accuracy (hit / miss counts), but still counts in log loss, Brier and
// calibration, which score the probability rather than the side.
const TOSSUP_PCT = 52;
const isTossup = r => r.predicted_win_pct < TOSSUP_PCT;
const CONFIDENCE = ['high', 'medium', 'low'];
const BINS = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 100.01]];
const EPS = 1e-6;

// Display-only annotations, keyed by prediction_log id. The log row itself is
// immutable; a note explains a pick without changing or excluding it.
const PICK_NOTES = {
  // Cerminara vs Stiller: logged while Cerminara's 17 UFC bouts sat on a duplicate
  // "Katlyn Chookagian" row (merged 2026-10-16).
  '2ca001a5-e5a3-4e65-a066-dd72d2016ba2': 'Logged before a duplicate-profile fix — the model didn\'t see her 17 prior UFC fights.',
};

// n / log_loss / brier over every row; accuracy over the non-toss-ups only
// (scored = its denominator, correct = its numerator).
function metrics(rows) {
  const n = rows.length;
  let correct = 0, scored = 0, ll = 0, brier = 0;
  for (const r of rows) {
    const p = Math.min(Math.max(r.predicted_win_pct / 100, EPS), 1 - EPS);
    const y = r.correct ? 1 : 0;
    if (!isTossup(r)) { scored++; correct += y; }
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    brier += (p - y) ** 2;
  }
  return {
    n, scored, tossups: n - scored, correct,
    accuracy: scored ? correct / scored : null,
    log_loss: n ? ll / n : null,
    brier: n ? brier / n : null,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = [];
    for (let page = 0; ; page++) {
      const { data, error } = await supabase.from('prediction_log').select('*')
        .order('event_date', { ascending: false }).range(page * 1000, (page + 1) * 1000 - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    for (const r of rows) r.predicted_win_pct = parseFloat(r.predicted_win_pct);

    // slugs for links (fighters / events may have been renamed; names come from the log)
    const fighterIds = [...new Set(rows.flatMap(r => [r.fighter1_id, r.fighter2_id]))];
    const eventIds = [...new Set(rows.map(r => r.event_id))];
    const slugOf = {}, eventSlug = {};
    for (let i = 0; i < fighterIds.length; i += 100) {
      const { data } = await supabase.from('fighters').select('id, slug').in('id', fighterIds.slice(i, i + 100));
      (data || []).forEach(f => { slugOf[f.id] = f.slug; });
    }
    for (let i = 0; i < eventIds.length; i += 100) {
      const { data } = await supabase.from('events').select('id, slug').in('id', eventIds.slice(i, i + 100));
      (data || []).forEach(e => { eventSlug[e.id] = e.slug; });
    }

    const graded = rows.filter(r => r.outcome === 'graded');
    const summary = {
      overall: metrics(graded),
      by_confidence: CONFIDENCE.map(c => ({ confidence: c, ...metrics(graded.filter(r => r.confidence === c)) })),
      calibration: BINS.map(([lo, hi]) => {
        const inBin = graded.filter(r => r.predicted_win_pct >= lo && r.predicted_win_pct < hi);
        const n = inBin.length;  // toss-ups included: calibration scores the probability
        return {
          bin: `${lo}–${Math.min(hi, 100).toFixed(0)}%`, lo, hi: Math.min(hi, 100), n,
          predicted: n ? inBin.reduce((s, r) => s + r.predicted_win_pct, 0) / n / 100 : null,
          actual: n ? inBin.filter(r => r.correct).length / n : null,
        };
      }),
      counts: {
        logged: rows.length,
        graded: graded.length,
        void: rows.filter(r => r.outcome === 'void').length,
        pending: rows.filter(r => !r.outcome).length,
      },
      model_versions: [...new Set(rows.map(r => r.model_version))],
      tossup_pct: TOSSUP_PCT,
    };

    const events = [];
    const byEvent = new Map();
    for (const r of rows) {
      if (!byEvent.has(r.event_id)) {
        const ev = { event_id: r.event_id, name: r.event_name, date: r.event_date, slug: eventSlug[r.event_id] || null, picks: [] };
        byEvent.set(r.event_id, ev);
        events.push(ev);
      }
      const winnerIs1 = r.predicted_winner_id === r.fighter1_id;
      byEvent.get(r.event_id).picks.push({
        id: r.id,
        fighter1: { id: r.fighter1_id, name: r.fighter1_name, slug: slugOf[r.fighter1_id] || null, win_pct: parseFloat(r.fighter1_win_pct) },
        fighter2: { id: r.fighter2_id, name: r.fighter2_name, slug: slugOf[r.fighter2_id] || null, win_pct: parseFloat(r.fighter2_win_pct) },
        pick: { id: r.predicted_winner_id, name: winnerIs1 ? r.fighter1_name : r.fighter2_name, win_pct: r.predicted_win_pct, method: r.predicted_method },
        confidence: r.confidence,
        tossup: isTossup(r),
        scheduled_rounds: r.scheduled_rounds,
        is_title_fight: r.is_title_fight,
        model_version: r.model_version,
        logged_at: r.logged_at,
        status: r.outcome === 'graded' ? (r.correct ? 'hit' : 'miss') : r.outcome === 'void' ? 'void' : 'pending',
        void_reason: r.void_reason,
        note: PICK_NOTES[r.id] || null,
        result: r.outcome ? {
          winner_name: r.actual_winner_id ? (r.actual_winner_id === r.fighter1_id ? r.fighter1_name : r.fighter2_name) : null,
          result: r.actual_result, method: r.actual_method, round: r.actual_round, time: r.actual_time,
        } : null,
      });
    }

    res.json({ summary, events });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
