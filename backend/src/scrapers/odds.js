/**
 * Odds Scraper / Sync
 * Pulls current UFC fight odds from The Odds API and stores them.
 * Runs on a cron schedule every 2 hours.
 */

require('dotenv').config();
const axios = require('axios');
const supabase = require('../db/client');

const ODDS_BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';
const ODDS_KEY  = process.env.ODDS_API_KEY;

const http = axios.create({ timeout: 10000 });

// Bookmakers to track (in priority order)
const BOOKMAKERS = [
  'draftkings', 'fanduel', 'betmgm', 'espnbet',
  'bovada', 'betrivers', 'pointsbetus',
];

function americanOddsToDecimal(american) {
  if (american > 0) return (american / 100) + 1;
  return (100 / Math.abs(american)) + 1;
}

function impliedProbability(american) {
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}

async function syncOdds() {
  if (!ODDS_KEY) {
    console.warn('[Odds] No ODDS_API_KEY set — skipping sync');
    return;
  }

  console.log('[Odds] Fetching current UFC odds...');

  try {
    // Get upcoming UFC events with odds
    const { data: events } = await http.get(`${ODDS_BASE}/sports/mma_mixed_martial_arts/odds`, {
      params: {
        apiKey: ODDS_KEY,
        regions: 'us',
        markets: 'h2h',
        oddsFormat: 'american',
        bookmakers: BOOKMAKERS.join(','),
      },
    });

    if (!events || !Array.isArray(events)) {
      console.warn('[Odds] Unexpected response format');
      return;
    }

    console.log(`[Odds] Found ${events.length} upcoming UFC matchups with odds`);

    for (const event of events) {
      // Match fight to our DB by fighter names
      const outcomes = event.bookmakers?.[0]?.markets?.[0]?.outcomes;
      if (!outcomes || outcomes.length < 2) continue;

      const f1Name = outcomes[0].name;
      const f2Name = outcomes[1].name;

      // Find fight in DB
      const fight = await findFightByFighterNames(f1Name, f2Name);
      if (!fight) continue;

      // Store odds from each bookmaker
      for (const bookmaker of event.bookmakers) {
        const market = bookmaker.markets?.find(m => m.key === 'h2h');
        if (!market) continue;

        const o1 = market.outcomes?.find(o => similarName(o.name, f1Name));
        const o2 = market.outcomes?.find(o => similarName(o.name, f2Name));

        if (!o1 || !o2) continue;

        await supabase.from('odds').upsert({
          fight_id:      fight.id,
          bookmaker:     bookmaker.key,
          bet_type:      'moneyline',
          fighter1_odds: Math.round(o1.price),
          fighter2_odds: Math.round(o2.price),
          line_type:     'current',
          recorded_at:   new Date().toISOString(),
        }, { onConflict: 'fight_id,bookmaker,bet_type,line_type' });
      }

      console.log(`  ✓ Odds synced: ${f1Name} vs ${f2Name}`);
    }

    // Log remaining API requests
    const remaining = events.headers?.['x-requests-remaining'];
    if (remaining) console.log(`[Odds] Requests remaining this month: ${remaining}`);

    return { synced: events.length };
  } catch (e) {
    console.error('[Odds] Sync failed:', e.message);
    throw e;
  }
}

async function findFightByFighterNames(name1, name2) {
  // Search fighters by name similarity
  const { data: f1Results } = await supabase
    .from('fighters')
    .select('id, first_name, last_name')
    .textSearch('first_name', name1.split(' ')[0])
    .limit(3);

  const { data: f2Results } = await supabase
    .from('fighters')
    .select('id, first_name, last_name')
    .textSearch('first_name', name2.split(' ')[0])
    .limit(3);

  if (!f1Results?.length || !f2Results?.length) return null;

  // Find the fight between these two fighters
  for (const f1 of f1Results) {
    for (const f2 of f2Results) {
      const { data: fight } = await supabase
        .from('fights')
        .select('id')
        .or(`and(fighter1_id.eq.${f1.id},fighter2_id.eq.${f2.id}),and(fighter1_id.eq.${f2.id},fighter2_id.eq.${f1.id})`)
        .eq('result', 'upcoming')
        .single();

      if (fight) return fight;
    }
  }
  return null;
}

function similarName(a, b) {
  const normalize = s => s.toLowerCase().replace(/[^a-z]/g, '');
  return normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a));
}

// Get odds history for a specific fight
async function getOddsHistory(fightId) {
  const { data, error } = await supabase
    .from('odds')
    .select('*')
    .eq('fight_id', fightId)
    .order('recorded_at', { ascending: true });

  if (error) throw error;
  return data;
}

// Get consensus odds (average across bookmakers)
async function getConsensusOdds(fightId) {
  const { data, error } = await supabase
    .from('odds')
    .select('fighter1_odds, fighter2_odds, bookmaker')
    .eq('fight_id', fightId)
    .eq('line_type', 'current');

  if (error || !data?.length) return null;

  const avg1 = Math.round(data.reduce((s, o) => s + o.fighter1_odds, 0) / data.length);
  const avg2 = Math.round(data.reduce((s, o) => s + o.fighter2_odds, 0) / data.length);

  return {
    fighter1_consensus: avg1,
    fighter2_consensus: avg2,
    fighter1_implied_prob: (impliedProbability(avg1) * 100).toFixed(1) + '%',
    fighter2_implied_prob: (impliedProbability(avg2) * 100).toFixed(1) + '%',
    bookmakers: data.map(o => o.bookmaker),
    last_updated: new Date().toISOString(),
  };
}

module.exports = { syncOdds, getOddsHistory, getConsensusOdds };
