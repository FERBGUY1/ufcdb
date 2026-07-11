/**
 * features.js — the feature vector shared by trainModel.js and predictionEngine.js
 *
 * One definition so training and serving can never drift. Every feature is a
 * DIFFERENTIAL (fighter A minus fighter B) over stats computed by statsEngine
 * snapshots — at training time with a cutoff date (only fights before the
 * fight being predicted), at serving time over the full career.
 * Missing values on either side make the differential 0 (neutral).
 */

const FEATURES = [
  'slpm',               // sig strikes landed / min
  'sapm',               // sig strikes absorbed / min
  'str_acc',            // striking accuracy %
  'str_def',            // striking defense %
  'td_avg',             // takedowns landed / 15 min
  'td_acc',             // takedown accuracy %
  'td_def',             // takedown defense %
  'sub_avg',            // submission attempts / 15 min
  'kd_per15',           // knockdowns scored / 15 min
  'kd_absorbed_per15',  // knockdowns absorbed / 15 min
  'cardio_degradation', // output drop R1->R3 % (negative = increases)
  'experience',         // completed UFC fights
  'win_rate',           // career win % (of decided fights)
  'recent_win_rate',    // win % over last 3 stats-fights
  'form_trend',         // recent SLpM minus career SLpM (rising/fading output)
  'age',                // age in years at fight time
  'reach',              // reach in inches
  'height',             // height in inches
  'layoff_days',        // days since last fight
];

/**
 * Per-fighter feature values.
 *   snap        full snapshot (statsEngine.snapshot with optional cutoff)
 *   snapRecent  last-3 snapshot (same cutoff)
 *   fighter     fighters row with date_of_birth, reach_inches, height_inches
 *   asOfDate    ISO date the features are computed for
 */
function sideValues(snap, snapRecent, fighter, asOfDate) {
  const asOf = new Date(asOfDate);
  const decided = snap.record.wins + snap.record.losses;
  return {
    slpm: snap.slpm, sapm: snap.sapm, str_acc: snap.str_acc, str_def: snap.str_def,
    td_avg: snap.td_avg, td_acc: snap.td_acc, td_def: snap.td_def, sub_avg: snap.sub_avg,
    kd_per15: snap.kd_per15, kd_absorbed_per15: snap.kd_absorbed_per15,
    cardio_degradation: snap.cardio_degradation,
    experience: snap.total_fights,
    win_rate: decided > 0 ? (snap.record.wins / decided) * 100 : null,
    recent_win_rate: snapRecent.stats_win_rate,
    form_trend: snapRecent.slpm != null && snap.slpm != null ? snapRecent.slpm - snap.slpm : null,
    age: fighter?.date_of_birth ? (asOf - new Date(fighter.date_of_birth)) / (365.25 * 86400000) : null,
    reach: fighter?.reach_inches ?? null,
    height: fighter?.height_inches ?? null,
    layoff_days: snap.last_fight_date ? (asOf - new Date(snap.last_fight_date)) / 86400000 : null,
  };
}

// A-minus-B differentials in FEATURES order; null on either side -> 0
function diffVector(a, b) {
  return FEATURES.map(k => (a[k] != null && b[k] != null ? a[k] - b[k] : 0));
}

module.exports = { FEATURES, sideValues, diffVector };
