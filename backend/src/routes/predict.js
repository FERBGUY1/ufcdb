const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { generatePrediction } = require('../ml/predictionEngine');

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

    const [{ data: f1 }, { data: f2 }] = await Promise.all([
      supabase.from('fighters').select('id').eq('slug', fighter1Slug).single(),
      supabase.from('fighters').select('id').eq('slug', fighter2Slug).single(),
    ]);

    if (!f1 || !f2) return res.status(404).json({ error: 'Fighter(s) not found' });

    const { data: cached } = await supabase
      .from('fight_predictions')
      .select('*')
      .or(`and(fighter1_id.eq.${f1.id},fighter2_id.eq.${f2.id}),and(fighter1_id.eq.${f2.id},fighter2_id.eq.${f1.id})`)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (cached) return res.json(cached);

    // Not cached — generate fresh
    const prediction = await generatePrediction(f1.id, f2.id, null);
    res.json(prediction);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
