const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { generatePrediction, getSnapshotPeak } = require('../ml/predictionEngine');

const parseRounds = r => (r == null ? null : [3, 5].includes(Number(r)) ? Number(r) : null);

// Fantasy snapshot spec per side: { mode: 'current' | 'peak' | 'asof', date?: 'YYYY-MM-DD' }
// ('asof' = the day after that fight; the Predict page sends the fight's date).
// 'title' = as of a title win on that date (age penalty neutralized; falls back to 'asof' if
// the fighter did not win a title bout that day).
const SNAP_MODES = new Set(['current', 'peak', 'asof', 'title']);
const DATED = new Set(['asof', 'title']);
function parseSnapshot(s) {
  if (s == null) return { mode: 'current' };
  if (typeof s !== 'object' || !SNAP_MODES.has(s.mode)) return null;
  if (DATED.has(s.mode) && !/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) return null;
  return DATED.has(s.mode) ? { mode: s.mode, date: s.date } : { mode: s.mode };
}

// POST /api/predict
// Body: { fighter1_slug, fighter2_slug, weight_class_slug?, rounds? (3 | 5),
//         snapshots?: { f1: { mode, date? }, f2: { mode, date? } } }
// rounds omitted -> 5 when either fighter is a current champion, else 3
// (or 5 if the pair has met in a 5-round bout; a fantasy matchup with a past
// title winner defaults to 5). Any non-current snapshot makes a FANTASY
// prediction: never cached, never logged, labelled in the response (`fantasy`).
router.post('/', async (req, res, next) => {
  try {
    const { fighter1_slug, fighter2_slug, weight_class_slug, rounds, snapshots } = req.body;
    const scheduledRounds = parseRounds(rounds);
    if (rounds != null && !scheduledRounds) return res.status(400).json({ error: "rounds must be 3 or 5" });
    let snaps = null;
    if (snapshots != null) {
      const s1 = parseSnapshot(snapshots.f1), s2 = parseSnapshot(snapshots.f2);
      if (!s1 || !s2) return res.status(400).json({ error: "snapshots.f1/f2 must be { mode: 'current' | 'peak' | 'asof' | 'title', date?: 'YYYY-MM-DD' }" });
      snaps = { f1: s1, f2: s2 };
    }

    if (!fighter1_slug || !fighter2_slug) {
      return res.status(400).json({ error: 'fighter1_slug and fighter2_slug are required' });
    }
    if (fighter1_slug === fighter2_slug) {
      return res.status(400).json({ error: 'Cannot predict a fighter against themselves' });
    }

    // Look up fighters
    const [{ data: f1, error: e1 }, { data: f2, error: e2 }] = await Promise.all([
      supabase.from('fighters').select('id, first_name, last_name, primary_weight_class_id').eq('slug', fighter1_slug).single(),
      supabase.from('fighters').select('id, first_name, last_name, primary_weight_class_id').eq('slug', fighter2_slug).single(),
    ]);

    if (e1 || !f1) return res.status(404).json({ error: `Fighter not found: ${fighter1_slug}` });
    if (e2 || !f2) return res.status(404).json({ error: `Fighter not found: ${fighter2_slug}` });

    // Weight class
    let weightClassId = null;
    if (weight_class_slug) {
      const { data: wc } = await supabase.from('weight_classes').select('id').eq('slug', weight_class_slug).single();
      weightClassId = wc?.id ?? null;
    }
    // When no weight class is specified, generatePrediction derives it from f1's fight history

    const prediction = await generatePrediction(f1.id, f2.id, weightClassId, { scheduledRounds, snapshots: snaps });
    res.json(prediction);
  } catch (err) {
    next(err);
  }
});

// GET /api/predict/snapshots/:slug — what the Predict page needs to offer the
// snapshot selector for one fighter: status, the rating peak (date, rating,
// whether it is confirmed, i.e. retired or the rating has since dropped), and
// the fighter's UFC fights (date, opponent, event, result, title win) for the
// "As of fight" / "As of title win" options.
router.get('/snapshots/:slug', async (req, res, next) => {
  try {
    const { data: f } = await supabase.from('fighters').select('id, slug, first_name, last_name, status').eq('slug', req.params.slug).single();
    if (!f) return res.status(404).json({ error: 'Fighter not found' });
    const [{ data: fights }, peak] = await Promise.all([
      supabase.from('fights')
        .select('id, result, method, winner_id, is_title_fight, is_interim_title, fighter1_id, fighter2_id, events ( name, date ), fighter1:fighters!fighter1_id ( slug, first_name, last_name ), fighter2:fighters!fighter2_id ( slug, first_name, last_name )')
        .or(`fighter1_id.eq.${f.id},fighter2_id.eq.${f.id}`)
        .limit(300),
      getSnapshotPeak(f),
    ]);
    const list = (fights || [])
      .filter(x => x.events?.date && x.result && x.result !== 'upcoming')
      .map(x => {
        const opp = x.fighter1_id === f.id ? x.fighter2 : x.fighter1;
        const won = x.winner_id === f.id;
        return { id: x.id, date: x.events.date, event: x.events.name, opponent: opp ? `${opp.first_name} ${opp.last_name}` : null, opponent_slug: opp?.slug ?? null,
          result: x.result === 'win' ? (won ? 'win' : 'loss') : x.result, method: x.method, title_win: !!(x.is_title_fight && won), interim: !!x.is_interim_title };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json({ fighter: f, status: f.status, retired: f.status === 'retired', peak, fights: list });
  } catch (err) {
    next(err);
  }
});

// GET /api/predict/:fighter1Slug/vs/:fighter2Slug?rounds=3|5
// generatePrediction serves its own cache (oriented to fighter1, matched on
// model version, weight class and scheduled rounds).
router.get('/:fighter1Slug/vs/:fighter2Slug', async (req, res, next) => {
  try {
    const { fighter1Slug, fighter2Slug } = req.params;

    // Full rows, not just ids: the cached row carries no fighter objects, and
    // the client needs them to render names/slugs/styles.
    const [{ data: f1 }, { data: f2 }] = await Promise.all([
      supabase.from('fighters').select('*').eq('slug', fighter1Slug).single(),
      supabase.from('fighters').select('*').eq('slug', fighter2Slug).single(),
    ]);

    if (!f1 || !f2) return res.status(404).json({ error: 'Fighter(s) not found' });

    const scheduledRounds = parseRounds(req.query.rounds);
    const prediction = await generatePrediction(f1.id, f2.id, null, { scheduledRounds });
    res.json(prediction);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
