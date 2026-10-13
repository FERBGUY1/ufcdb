/**
 * wiki-dwcs.js — Dana White's Contender Series results from Wikipedia.
 *
 * Reads every "Dana White's Contender Series season N" page through the
 * MediaWiki API (wikitext), parses each episode's {{Infobox MMA event}} date,
 * its {{MMAevent bout}} templates and the "Contract awards" list, and matches
 * each DWCS fighter to a row in the fighters table.
 *
 * Output: the dwcs_results table (migration 2026-10-14-dwcs-results.sql), one row
 * per DWCS appearance of a matched fighter. If the table does not exist yet the
 * rows go to backend/.cache/wiki-dwcs/dwcs-results.json (gitignored) and the
 * trainer reads that file instead until the migration has been run.
 *
 * Read by the predictor's training path (trainModel.loadDwcs). Pages are cached
 * under backend/.cache/wiki-dwcs so re-runs are offline.
 *
 *   node -r dotenv/config src/scrapers/wiki-dwcs.js [--dry-run] [--season N] [--refresh]
 *
 *   --refresh   re-fetch pages already in the cache (new episodes of the current season)
 *   --season N  only that season
 *
 * Name matching: full normalized name against fighters (first + last), unique;
 * a fighter whose first UFC fight predates the DWCS bout is never accepted
 * (same-name namesake guard). Unmatched names are mostly fighters who never
 * reached the UFC, which is expected.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const supabase = require('../db/client');

const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const DRY = flag('dry-run');
const REFRESH = flag('refresh');
const ONLY_SEASON = opt('season', null) ? parseInt(opt('season')) : null;
const CACHE = path.join(__dirname, '..', '..', '.cache', 'wiki-dwcs');
const FALLBACK = path.join(CACHE, 'dwcs-results.json');
const http = axios.create({ timeout: 20000, headers: { 'User-Agent': 'UFCDBBot/1.0 (https://github.com/FERBGUY1/ufcdb; research use, 1 req/s)' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '').toLowerCase().replace(/[łŁ]/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function loadAll(table, cols) {
  const all = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function fetchSeason(n) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `season-${n}.json`);
  if (!REFRESH && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const title = `Dana White's Contender Series season ${n}`;
  const { data } = await http.get('https://en.wikipedia.org/w/api.php', { params: { action: 'parse', page: title, prop: 'wikitext', format: 'json', formatversion: 2 } });
  await sleep(1500);
  if (!data.parse) return null;
  const out = { title, wikitext: data.parse.wikitext, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

// strip wiki markup from a cell: [[Target|Text]] -> Text, '''x''' -> x, <ref>...</ref> removed
const clean = s => (s || '').replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/'''?/g, '').replace(/\{\{[^}]*\}\}/g, '').trim();
const parseDate = s => { const d = new Date(clean(s)); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
function splitCells(s) {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], two = s.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; cur += two; i++; continue; }
    if (two === ']]' || two === '}}') { depth--; cur += two; i++; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === '|' && depth <= 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
const isFinish = m => /^(KO|TKO|Submission|Technical Submission)/i.test(m);

// Split the page into episodes: everything from one {{Infobox MMA event to the next.
function parseSeason(wikitext, season) {
  const bouts = [];
  const parts = wikitext.split(/(?=\{\{Infobox MMA event)/).slice(1);
  for (const part of parts) {
    const dateM = part.match(/\|\s*date\s*=\s*([^\n|}]+)/);
    const date = dateM ? parseDate(dateM[1]) : null;
    const nameM = part.match(/\|\s*name\s*=\s*([^\n|}]+)/);
    const episode = nameM ? clean(nameM[1]) : null;
    if (!date) { console.warn(`  season ${season}: episode without a date (${episode})`); continue; }
    // contract awards: bolded names between the Contract heading and the next heading
    const contracts = new Set();
    const cm = part.match(/===?\s*Contract[^=]*===?([\s\S]*?)(?=\n==|$)/i);
    if (cm) for (const b of cm[1].matchAll(/'''(.*?)'''/g)) contracts.add(norm(clean(b[1])));
    const re = /\{\{MMAevent bout\s*\|([\s\S]*?)\n\}\}/g;
    for (const m of part.matchAll(re)) {
      // cells are '|'-separated in a multi-line or a single-line layout; split on
      // pipes outside [[...]] / {{...}} / (...) so links and score lists survive
      const cells = splitCells(m[1]).map(clean);
      if (cells.length < 7) continue;
      const [weightClass, a, rel, b, method, round, time] = cells;
      const decided = /^def\.?$/i.test(rel);
      const noContest = /^(NC|No Contest)/i.test(method);
      const draw = !decided && /draw/i.test(method);
      bouts.push({ season, episode, date, weightClass, a, b, method, round: parseInt(round) || null, time,
        result: decided ? 'win' : noContest ? 'no_contest' : draw ? 'draw' : 'unknown',
        contractA: contracts.has(norm(a)), contractB: contracts.has(norm(b)) });
    }
  }
  return bouts;
}

async function main() {
  const seasons = [];
  for (let n = 1; n <= 30; n++) {
    if (ONLY_SEASON && n !== ONLY_SEASON) continue;
    const page = await fetchSeason(n);
    if (!page) { if (!ONLY_SEASON) break; else continue; }
    seasons.push({ n, bouts: parseSeason(page.wikitext, n) });
  }
  const allBouts = seasons.flatMap(s => s.bouts);
  console.log(`seasons ${seasons.map(s => s.n).join(',')}  episodes ${new Set(allBouts.map(b => b.episode)).size}  bouts ${allBouts.length}`);

  // fighters + first UFC fight date (namesake guard)
  const fighters = await loadAll('fighters', 'id, first_name, last_name, slug');
  const events = await loadAll('events', 'id, date');
  const fights = await loadAll('fights', 'fighter1_id, fighter2_id, event_id');
  const evDate = Object.fromEntries(events.map(e => [e.id, e.date]));
  const firstUfc = {};
  for (const f of fights) { const d = evDate[f.event_id]; if (!d) continue; for (const id of [f.fighter1_id, f.fighter2_id]) if (id && (!firstUfc[id] || d < firstUfc[id])) firstUfc[id] = d; }
  const byName = new Map();
  for (const f of fighters) { const k = norm(`${f.first_name} ${f.last_name}`); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(f); }
  const resolve = (name, date) => {
    const cands = (byName.get(norm(name)) || []).filter(f => !firstUfc[f.id] || firstUfc[f.id] > date);
    return cands.length === 1 ? cands[0] : null;
  };

  const rows = [];
  let unmatched = 0, ambiguous = 0;
  for (const b of allBouts) {
    for (const [side, name, opp] of [['a', b.a, b.b], ['b', b.b, b.a]]) {
      const f = resolve(name, b.date);
      if (!f) { if ((byName.get(norm(name)) || []).length > 1) ambiguous++; else unmatched++; continue; }
      const won = b.result === 'win' && side === 'a';
      rows.push({ fighter_id: f.id, dwcs_date: b.date, season: b.season, episode: b.episode, opponent: opp,
        won, finish: won && isFinish(b.method), method: b.method, result: b.result,
        contract: side === 'a' ? b.contractA : b.contractB, weight_class: b.weightClass,
        ufc_debut: firstUfc[f.id] || null,
        days_to_debut: firstUfc[f.id] ? Math.round((new Date(firstUfc[f.id]) - new Date(b.date)) / 86400000) : null });
    }
  }
  const matchedFighters = new Set(rows.map(r => r.fighter_id)).size;
  const withDebut = rows.filter(r => r.ufc_debut);
  console.log(`matched ${rows.length} appearances (${matchedFighters} fighters)  unmatched names ${unmatched}  ambiguous ${ambiguous}`);
  console.log(`matched rows: won ${rows.filter(r => r.won).length}  finish ${rows.filter(r => r.finish).length}  contract ${rows.filter(r => r.contract).length}  with a UFC debut ${withDebut.length}`);
  if (withDebut.length) {
    const d = withDebut.map(r => r.days_to_debut).sort((x, y) => x - y);
    console.log(`days to debut: median ${d[Math.floor(d.length / 2)]}  p10 ${d[Math.floor(d.length * .1)]}  p90 ${d[Math.floor(d.length * .9)]}  min ${d[0]}`);
  }
  if (DRY) { console.log('dry run — nothing written'); return; }

  const { error: probe } = await supabase.from('dwcs_results').select('fighter_id').limit(1);
  if (probe) {
    fs.writeFileSync(FALLBACK, JSON.stringify(rows, null, 1));
    console.log(`dwcs_results table not found (${probe.message}). Wrote ${rows.length} rows to ${FALLBACK}; run src/db/migrations/2026-10-14-dwcs-results.sql and re-run to load the table.`);
    return;
  }
  const payload = rows.map(({ ufc_debut, days_to_debut, ...r }) => r);
  for (let i = 0; i < payload.length; i += 100) {
    const { error } = await supabase.from('dwcs_results').upsert(payload.slice(i, i + 100), { onConflict: 'fighter_id,dwcs_date' });
    if (error) throw new Error(error.message);
  }
  if (fs.existsSync(FALLBACK)) fs.unlinkSync(FALLBACK);
  console.log(`upserted ${payload.length} rows into dwcs_results`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
