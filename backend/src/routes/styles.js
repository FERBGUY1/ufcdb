const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// GET /api/styles/matchups — all style vs style stats
router.get('/matchups', async (req, res, next) => {
  try {
    const { style1, style2, weight_class, min_fights = 5 } = req.query;

    let query = supabase
      .from('style_matchups')
      .select('*')
      .gte('total_fights', parseInt(min_fights))
      .order('total_fights', { ascending: false });

    if (style1) query = query.or(`style1.eq.${style1},style2.eq.${style1}`);
    if (style2) query = query.or(`style1.eq.${style2},style2.eq.${style2}`);
    if (weight_class) {
      const { data: wc } = await supabase.from('weight_classes').select('id').eq('slug', weight_class).single();
      if (wc) query = query.eq('weight_class_id', wc.id);
      else query = query.is('weight_class_id', null);
    } else {
      query = query.is('weight_class_id', null);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ matchups: data || [] });
  } catch (err) { next(err); }
});

// GET /api/styles/list — all available styles
router.get('/list', async (req, res) => {
  const styles = [
    'Boxer', 'Kickboxer', 'Muay Thai', 'Karate', 'Taekwondo',
    'Wrestler (Collegiate)', 'Wrestler (Freestyle)', 'Wrestler (Greco-Roman)',
    'Sambo', 'Judo', 'BJJ Specialist', 'Grappler',
    'Pressure Fighter', 'Counter Striker', 'Dirty Boxer',
    'Clinch Fighter', 'Submission Hunter', 'Switch Hitter', 'All-Rounder',
  ];
  res.json({ styles });
});

// GET /api/styles/matchups/:style1/vs/:style2
router.get('/matchups/:style1/vs/:style2', async (req, res, next) => {
  try {
    const { style1, style2 } = req.params;
    const s1 = decodeURIComponent(style1);
    const s2 = decodeURIComponent(style2);

    const { data, error } = await supabase
      .from('style_matchups')
      .select('*, notable_fights')
      .or(`and(style1.eq.${s1},style2.eq.${s2}),and(style1.eq.${s2},style2.eq.${s1})`)
      .is('weight_class_id', null)
      .single();

    if (error || !data) {
      return res.json({
        matchup: null,
        message: `No significant matchup data for ${s1} vs ${s2} yet`,
      });
    }

    // Normalize direction
    const normalized = data.style1 === s1 ? data : {
      ...data,
      style1: data.style2, style2: data.style1,
      style1_wins: data.style2_wins, style2_wins: data.style1_wins,
      style1_win_pct: data.style2_win_pct, style2_win_pct: data.style1_win_pct,
    };

    res.json({ matchup: normalized });
  } catch (err) { next(err); }
});

// GET /api/styles/fighters?style=Wrestler (Collegiate)
router.get('/fighters', async (req, res, next) => {
  try {
    const { style, limit = 20 } = req.query;
    if (!style) return res.status(400).json({ error: 'style param required' });

    const { data, error } = await supabase
      .from('fighters')
      .select('id, slug, first_name, last_name, wins, losses, draws, primary_style, secondary_style, rating_overall, resume_strength_score, status')
      .eq('primary_style', style)
      .order('resume_strength_score', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;
    res.json({ fighters: data || [] });
  } catch (err) { next(err); }
});

module.exports = router;
