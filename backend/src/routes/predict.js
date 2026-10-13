const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { generatePrediction } = require('../ml/predictionEngine');

const parseRounds = r => (r == null ? null : [3, 5].includes(Number(r)) ? Number(r) : null);

// POST /api/predict
// Body: { fighter1_slug, fighter2_slug, weight_class_slug?, rounds? (3 | 5) }
// rounds omitted -> 5 when either fighter is a current champion, else 3
// (or 5 if the pair has met in a 5-round bout).
router.post('/', async (req, res, next) => {
  try {
    const { fighter1_slug, fighter2_slug, weight_class_slug, rounds } = req.body;
    const scheduledRounds = parseRounds(rounds);
    if (rounds != null && !scheduledRounds) return res.status(400).json({ error: "rounds must be 3 or 5" });

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

    const prediction = await generatePrediction(f1.id, f2.id, weightClassId, { scheduledRounds });
    res.json(prediction);
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
