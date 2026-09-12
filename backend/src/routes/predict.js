const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { generatePrediction, pickCached } = require('../ml/predictionEngine');

// POST /api/predict
// Body: { fighter1_slug, fighter2_slug, weight_class_slug? }
router.post('/', async (req, res, next) => {
  try {
    const { fighter1_slug, fighter2_slug, weight_class_slug } = req.body;

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

    const prediction = await generatePrediction(f1.id, f2.id, weightClassId);
    res.json(prediction);
  } catch (err) {
    next(err);
  }
});

// GET /api/predict/:fighter1Slug/vs/:fighter2Slug
// Cached predictions via GET
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

    // Both orderings can exist as separate rows under the ordered unique key,
    // so read the matching set (no .single() — it errors on >1) and let
    // pickCached orient it to the REQUESTED fighter1 instead of trusting
    // whichever row happens to come back first.
    const { data: rows } = await supabase
      .from('fight_predictions')
      .select('*')
      .or(`and(fighter1_id.eq.${f1.id},fighter2_id.eq.${f2.id}),and(fighter1_id.eq.${f2.id},fighter2_id.eq.${f1.id})`)
      .gt('expires_at', new Date().toISOString());

    const cached = pickCached(rows, f1.id);
    // Same response shape as generatePrediction, so both paths render alike.
    if (cached) return res.json({ ...cached, fighter1: f1, fighter2: f2 });

    // Not cached — generate fresh
    const prediction = await generatePrediction(f1.id, f2.id, null);
    res.json(prediction);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
