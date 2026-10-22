/**
 * computeGlickoRatings.js — precompute every fighter's Glicko-2 rating into the
 * glicko_ratings table (migration 2026-10-15-glicko-ratings.sql) so the
 * predictor never replays the Sherdog history at request time.
 *
 *   node -r dotenv/config src/ml/computeGlickoRatings.js [--dry-run]
 *
 * Replays UFC fights + the non-UFC Sherdog bouts (glickoEngine.js, seed from
 * trainModel.TRAIN_CONFIG so serving matches training by construction) and
 * upserts one row per DB fighter with the state AFTER their last rated bout.
 * predictionEngine.js inflates the RD to today the same way the engine does
 * for a fight date. Fighters with no rated bout get the fresh state (1500 /
 * initialRd) so the feature is defined for every matchup, as in training.
 * Run by `npm run weekly` after sherdog-history.js.
 */
const supabase = require('../db/client');
const { loadAll, loadSherdogHistory, TRAIN_CONFIG, FIGHT_COLS } = require('./trainModel');
const { computeGlicko, glickoOptions } = require('./glickoEngine');

const DRY = process.argv.includes('--dry-run');

async function main() {
  const [events, fights, fighters, sherdog] = await Promise.all([
    loadAll('events', 'id, date'), loadAll('fights', FIGHT_COLS), loadAll('fighters', 'id'), loadSherdogHistory(),
  ]);
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const opts = { ...glickoOptions(TRAIN_CONFIG), sherdog };
  if (opts.seed === 'off') { console.error('TRAIN_CONFIG.glickoSeed is off — nothing to compute'); process.exit(1); }
  const g = computeGlicko(fights, eventById, opts);
  console.log(`Glicko-2 replay: ${g.bouts} bouts (seed ${opts.seed}, tau ${opts.tau}, RD0 ${opts.initialRd}, finish x${opts.finishMult}); Sherdog history ${sherdog ? sherdog.byFighter.size + ' fighters' : 'NOT loaded'}`);

  const computedAt = new Date().toISOString();
  const rows = fighters.map(f => {
    const h = g.history.get(f.id) || [];
    const s = g.stateAsOf(f.id, null);
    const last = h.length ? h[h.length - 1] : null;
    // history: post-bout states in date order (fantasy snapshots read the state "as of" a past
    // date from here, glickoEngine.ratingsFromTable); peak: highest post-bout rating over UFC bouts.
    let n = 0, u = 0, peak = null;
    const history = h.map(e => {
      n++; if (e.ufc) u++;
      if (e.ufc && (!peak || e.post.r > peak.r)) peak = { r: e.post.r, d: e.date };
      return { d: e.date, r: +e.post.r.toFixed(2), rd: +e.post.rd.toFixed(2), s: +e.sigma.toFixed(5), n, u, ufc: !!e.ufc };
    });
    return {
      fighter_id: f.id, rating: s.r, rd: s.rd, volatility: last ? last.sigma : opts.initialVol,
      fights: s.fights, ufc_fights: s.ufcFights, last_fight_date: last ? last.date : null,
      history, peak_rating: peak ? +peak.r.toFixed(2) : null, peak_date: peak ? peak.d : null,
      config: g.config, computed_at: computedAt,
    };
  });
  const withBouts = rows.filter(r => r.fights > 0).length;
  if (DRY) { console.log(`Dry run: would upsert ${rows.length} fighters (${withBouts} with rated bouts)`); return; }

  let errors = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('glicko_ratings').upsert(rows.slice(i, i + 500), { onConflict: 'fighter_id' });
    if (error) {
      errors++; console.error(`batch ${i / 500}: ${error.message}`);
      if (/history|peak_/.test(error.message)) { console.error('glicko_ratings lacks the history/peak columns — run src/db/migrations/2026-10-16-glicko-history.sql in the Supabase SQL editor first'); break; }
    }
  }
  console.log(`Done: ${rows.length} fighters rated (${withBouts} with rated bouts), ${errors} errors`);
  process.exit(errors ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
