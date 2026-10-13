/**
 * bestfightodds-lines.js — historical opening/closing moneylines for the
 * predictor's market benchmark (INTERNAL USE ONLY — never served by the API).
 *
 * Source: bestfightodds.com fighter pages (/fighters/<slug>-<id>). Each page
 * lists every fight of that fighter with the opening line, the closing range
 * (min … max across books) for both sides, the event name and the date.
 *
 * Output: src/ml/data/market-lines.json — one entry per DB fight id, oriented
 * to the DB's fighter1 / fighter2:
 *   { fightId: { date, event, f1: { bfoId, open, closeMin, closeMax },
 *                              f2: { ... }, via } }
 * plus src/ml/data/market-lines-report.json (coverage + unmatched rows).
 * The harness (src/ml/evaluate.js) reads the lines file; nothing is written
 * to the database and no route reads these numbers.
 *
 * How fighters are found (namesake-safe):
 *   1. Start from --seed slugs (default: a handful of well-connected fighters),
 *      found through /api/suggest; a page is accepted for a DB fighter only if
 *      its rows match that fighter's DB fights by date (±1 day) and opponent.
 *   2. Every matched row also tells us the OPPONENT's BestFightOdds id, and the
 *      DB fight tells us the opponent's DB id — so the id map grows along the
 *      fight graph without any name matching. Two namesakes never share an
 *      opponent on the same date, so the Anthony Romero case resolves itself.
 *   3. DB fighters never reached by the graph fall back to /api/suggest with
 *      the same date-verified acceptance rule.
 *   A fighter page is only fetched while that fighter still has an UNCOVERED
 *   target fight (one page covers both sides of each of their bouts).
 *
 * Pace: one request every --delay ms (default 2000). Raw HTML is cached under
 * --cache (default backend/.cache/bestfightodds), so re-runs are resumable and
 * never re-fetch a page.
 *
 * Flags: --since YYYY-MM-DD (target fights on/after; default 2010-01-01)
 *        --delay MS · --limit N (max page fetches this run) · --cache DIR
 *        --seed slug1,slug2 · --out PATH · --refetch-days N (re-fetch cached
 *        pages older than N days for fighters with an uncovered fight; default 0 = never)
 *        --rematch (rebuild all lines from the cached pages first; with --limit 0
 *        this is a fully offline pass, e.g. after improving the matcher)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const supabase = require('../db/client');

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt; };
const SINCE = flag('--since', '2010-01-01');
const DELAY = +flag('--delay', 2000);
const LIMIT = +flag('--limit', Infinity);
const CACHE = flag('--cache', path.join(__dirname, '..', '..', '.cache', 'bestfightodds'));
const OUT = flag('--out', path.join(__dirname, '..', 'ml', 'data', 'market-lines.json'));
const REPORT = OUT.replace(/\.json$/, '-report.json');
const REFETCH_DAYS = +flag('--refetch-days', 0);
const REMATCH = args.includes('--rematch');
const SEEDS = flag('--seed', 'jon-jones,max-holloway,charles-oliveira,jim-miller,andrei-arlovski,amanda-nunes,valentina-shevchenko,neil-magny,donald-cerrone,jessica-andrade').split(',').map(s => s.trim()).filter(Boolean);

const BASE = 'https://www.bestfightodds.com';
const http = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
  validateStatus: () => true,
});

const norm = s => (s || '').toLowerCase().replace(/[łŁ]/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const tokens = s => (s || '').toLowerCase().replace(/[łŁ]/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(t => t.length >= 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function lev(a, b) {
  const m = []; for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) for (let j = 1; j <= a.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1));
  return m[b.length][a.length];
}
// BestFightOdds display names that share no token with the DB name (norm(bfo) -> DB name)
const ALIASES = {
  thekoreanzombie: 'Chan Sung Jung', koreanzombie: 'Chan Sung Jung', cyborg: 'Cris Justino', criscyborg: 'Cris Justino',
  blooddiamond: 'Mike Mathetha', pitbull: 'Patricio Freire',
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseBfoDate(s) {
  const m = (s || '').match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()]; if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
}
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const parseLine = s => { const t = (s || '').replace(/[^\d+-]/g, ''); if (!/^[+-]?\d+$/.test(t)) return null; const v = parseInt(t, 10); return Number.isFinite(v) ? v : null; };

// ── Networking with pacing, retries and an on-disk cache ──────────────────
let lastRequestAt = 0, fetches = 0;
async function paced(url) {
  const wait = lastRequestAt + DELAY - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 1; attempt <= 4; attempt++) {
    lastRequestAt = Date.now();
    let res;
    try { res = await http.get(url); } catch (e) { res = { status: 0, data: null, error: e.message }; }
    if (res.status === 200) return res.data;
    if (res.status === 404) return null;
    const backoff = DELAY * attempt * 4;
    console.warn(`  ! ${res.status || res.error} on ${url} — retry ${attempt}/4 in ${backoff}ms`);
    await sleep(backoff);
  }
  throw new Error(`gave up on ${url}`);
}
async function fetchFighterPage(bfoId, bfoSlug) {
  const file = path.join(CACHE, 'fighters', `${bfoId}.html`);
  if (fs.existsSync(file)) {
    const ageDays = (Date.now() - fs.statSync(file).mtimeMs) / 86400000;
    if (!REFETCH_DAYS || ageDays < REFETCH_DAYS) return { html: fs.readFileSync(file, 'utf8'), cached: true };
  }
  if (fetches >= LIMIT) return { html: null, limited: true };
  fetches++;
  const html = await paced(`${BASE}/fighters/${bfoSlug || 'f'}-${bfoId}`);
  if (html == null) return { html: null, missing: true };
  fs.writeFileSync(file, html);
  return { html, cached: false };
}
async function suggest(name) {
  const file = path.join(CACHE, 'suggest', `${norm(name)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (fetches >= LIMIT) return null;
  fetches++;
  // ASCII-fold the query: the endpoint 500s on some diacritics (Uroš Jurišić)
  const q = name.replace(/[łŁ]/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
  let data;
  try { data = await paced(`${BASE}/api/suggest?q=${encodeURIComponent(q)}`); } catch (e) { console.warn(`  ! suggest failed for ${name}: ${e.message}`); data = []; }
  const list = Array.isArray(data) ? data.filter(x => x.type === 'Fighter').map(x => {
    const m = (x.url || '').match(/\/fighters\/(.*)-(\d+)$/);
    return m ? { name: x.name, slug: m[1], bfoId: +m[2] } : null;
  }).filter(Boolean) : [];
  fs.writeFileSync(file, JSON.stringify(list));
  return list;
}

// ── Page parsing ──────────────────────────────────────────────────────────
// Returns [{ self: {bfoId, slug, name, open, closeMin, closeMax}, opp: {...}, event, date }]
function parseFighterPage(html) {
  const h = html.replace(/\s+/g, ' ');
  const out = [];
  const re = /<tr class="main-row">([\s\S]*?)<\/tr>\s*<tr>([\s\S]*?)<\/tr>/g;
  let m;
  const side = seg => {
    const f = seg.match(/<a href="\/fighters\/(.*?)-(\d+)">([^<]*)<\/a>/);
    const cells = [...seg.matchAll(/<td class="moneyline"[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, '').trim());
    return f ? { bfoId: +f[2], slug: f[1], name: f[3].trim(), open: parseLine(cells[0]), closeMin: parseLine(cells[1]), closeMax: parseLine(cells[2]) } : null;
  };
  while ((m = re.exec(h))) {
    const self = side(m[1]), opp = side(m[2]);
    if (!self || !opp) continue;
    const ev = (m[1].match(/<a href="\/events\/[^"]*"\s*>([^<]*)<\/a>/) || [])[1] || null;
    const date = parseBfoDate((m[2].match(/color: #767676">([^<]*)</) || [])[1]);
    out.push({ self, opp, event: ev ? ev.trim() : null, date });
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function loadAll(table, cols) {
  const rows = []; let page = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data); if (data.length < 1000) break; page++;
  }
  return rows;
}

async function main() {
  fs.mkdirSync(path.join(CACHE, 'fighters'), { recursive: true });
  fs.mkdirSync(path.join(CACHE, 'suggest'), { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const t0 = Date.now();

  const [events, fights, fighters] = await Promise.all([
    loadAll('events', 'id, name, date'),
    loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, result'),
    loadAll('fighters', 'id, slug, first_name, last_name, nickname'),
  ]);
  const eventById = new Map(events.map(e => [e.id, e]));
  const fighterById = new Map(fighters.map(f => [f.id, f]));
  const fullName = f => `${f.first_name || ''} ${f.last_name || ''}`.trim();
  const byNorm = new Map();
  for (const f of fighters) { const k = norm(fullName(f)); if (!byNorm.has(k)) byNorm.set(k, []); byNorm.get(k).push(f); }
  const bySlug = new Map(fighters.map(f => [f.slug, f]));

  // target fights: decided, on/after SINCE, both ids present
  const target = fights.filter(f => ['win', 'draw', 'no_contest'].includes(f.result) && f.fighter1_id && f.fighter2_id)
    .map(f => ({ ...f, date: eventById.get(f.event_id)?.date, event: eventById.get(f.event_id)?.name }))
    .filter(f => f.date && f.date >= SINCE);
  const fightsByFighter = new Map(); // fighterId -> [fight]
  for (const f of target) for (const id of [f.fighter1_id, f.fighter2_id]) {
    if (!fightsByFighter.has(id)) fightsByFighter.set(id, []);
    fightsByFighter.get(id).push(f);
  }
  console.log(`Target: ${target.length} decided UFC fights since ${SINCE} across ${fightsByFighter.size} fighters`);

  // state (resumable)
  const lines = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const prev = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  const idMap = new Map(Object.entries(prev.fighterMap || {}));          // dbId -> {bfoId, slug, via}
  const bfoToDb = new Map([...idMap].map(([db, v]) => [v.bfoId, db]));
  const unmatchedRows = [];                                              // BFO rows for known fighters that matched no DB fight
  const noPage = new Map(Object.entries(prev.noPage || {}));             // dbId -> reason
  const processed = new Set(Object.keys(prev.processed || {}));          // dbIds whose page has been parsed
  // --rematch: forget prior matching and rebuild every line from the cached pages
  // (zero network for fighters already fetched; combine with --limit 0 for a fully offline pass)
  if (REMATCH) {
    for (const k of Object.keys(lines)) delete lines[k];
    for (const id of [...processed]) if (idMap.has(id) && fs.existsSync(path.join(CACHE, 'fighters', `${idMap.get(id).bfoId}.html`))) processed.delete(id);
    for (const [id] of noPage) processed.add(id);
    console.log(`--rematch: re-parsing ${idMap.size - processed.size} cached pages`);
  }
  const uncovered = id => (fightsByFighter.get(id) || []).filter(f => !lines[f.id]).length;

  // Accept a BFO page for a DB fighter candidate: match rows to that fighter's DB fights by date ±1 and opponent name.
  const oppMatches = (bfoName, dbOpp) => {
    const bfo = ALIASES[norm(bfoName)] || bfoName;
    const a = norm(bfo), b = norm(fullName(dbOpp));
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const ta = tokens(bfo), tb = tokens(fullName(dbOpp));
    // exact shared token, else a near-miss on a longer token (Spivak/Spivac, Sergey/Serghei)
    return ta.some(t => tb.includes(t)) || ta.some(t => t.length >= 5 && tb.some(u => u.length >= 5 && lev(t, u) <= (t.length >= 8 ? 2 : 1)));
  };
  function matchRows(rows, dbId) {
    const mine = fightsByFighter.get(dbId) || [];
    const matched = [], leftovers = [];
    for (const r of rows) {
      if (!r.date) { leftovers.push({ ...r, why: 'no-date' }); continue; }
      const near = mine.filter(f => Math.abs(dayDiff(f.date, r.date)) <= 1);
      if (!near.length) { leftovers.push({ ...r, why: 'no-db-fight-on-date' }); continue; }
      const byOpp = near.filter(f => oppMatches(r.opp.name, fighterById.get(f.fighter1_id === dbId ? f.fighter2_id : f.fighter1_id)));
      if (byOpp.length === 1) matched.push({ row: r, fight: byOpp[0] });
      else leftovers.push({ ...r, why: byOpp.length ? 'ambiguous' : 'opponent-name-mismatch', dbOpp: near.map(f => fullName(fighterById.get(f.fighter1_id === dbId ? f.fighter2_id : f.fighter1_id))).join(' / ') });
    }
    return { matched, leftovers };
  }
  function record(dbId, rows, via) {
    const { matched, leftovers } = matchRows(rows, dbId);
    let added = 0;
    for (const { row, fight } of matched) {
      const selfIs1 = fight.fighter1_id === dbId;
      const s = { bfoId: row.self.bfoId, open: row.self.open, closeMin: row.self.closeMin, closeMax: row.self.closeMax };
      const o = { bfoId: row.opp.bfoId, open: row.opp.open, closeMin: row.opp.closeMin, closeMax: row.opp.closeMax };
      if (!lines[fight.id]) { lines[fight.id] = { date: fight.date, bfoDate: row.date, event: row.event, f1: selfIs1 ? s : o, f2: selfIs1 ? o : s, via }; added++; }
      // graph discovery: the opponent's BFO id ↔ DB id, exact
      const oppDb = selfIs1 ? fight.fighter2_id : fight.fighter1_id;
      if (!idMap.has(oppDb)) { idMap.set(oppDb, { bfoId: row.opp.bfoId, slug: row.opp.slug, via: 'graph' }); bfoToDb.set(row.opp.bfoId, oppDb); }
    }
    for (const l of leftovers) unmatchedRows.push({ dbFighter: fullName(fighterById.get(dbId)), dbId, bfoEvent: l.event, bfoDate: l.date, bfoOpponent: l.opp.name, dbOpponentOnDate: l.dbOpp || null, why: l.why });
    return { matched: matched.length, added };
  }

  async function processFighter(dbId) {
    const info = idMap.get(dbId); if (!info) return false;
    const page = await fetchFighterPage(info.bfoId, info.slug);
    if (page.limited) return 'limited';
    if (!page.html) { noPage.set(dbId, 'bfo-404'); processed.add(dbId); return false; }
    const rows = parseFighterPage(page.html);
    const r = record(dbId, rows, info.via);
    processed.add(dbId);
    return r;
  }
  async function resolveBySuggest(dbId) {
    const f = fighterById.get(dbId); const name = fullName(f);
    const list = await suggest(name);
    if (list == null) return 'limited';
    const cands = list.filter(x => norm(x.name) === norm(name));
    const pool = cands.length ? cands : list.filter(x => tokens(x.name).some(t => tokens(name).includes(t)) && tokens(x.name).filter(t => tokens(name).includes(t)).length >= 2);
    if (!pool.length) { noPage.set(dbId, 'no-suggest-hit'); processed.add(dbId); return false; }
    // verify each candidate page by dates; keep the one with the most matching rows
    let best = null;
    for (const c of pool.slice(0, 3)) {
      if (bfoToDb.has(c.bfoId) && bfoToDb.get(c.bfoId) !== dbId) continue; // already someone else's
      const page = await fetchFighterPage(c.bfoId, c.slug);
      if (page.limited) return 'limited';
      if (!page.html) continue;
      const rows = parseFighterPage(page.html);
      const { matched } = matchRows(rows, dbId);
      if (matched.length && (!best || matched.length > best.matched.length)) best = { c, rows, matched };
    }
    if (!best) { noPage.set(dbId, `suggest-unverified(${pool.map(p => p.bfoId).join(',')})`); processed.add(dbId); return false; }
    idMap.set(dbId, { bfoId: best.c.bfoId, slug: best.c.slug, via: 'suggest' }); bfoToDb.set(best.c.bfoId, dbId);
    const r = record(dbId, best.rows, 'suggest');
    processed.add(dbId);
    return r;
  }

  const save = () => {
    fs.writeFileSync(OUT, JSON.stringify(lines, null, 0));
    const covered = target.filter(f => lines[f.id]).length;
    const perYear = {};
    for (const f of target) { const y = f.date.slice(0, 4); perYear[y] = perYear[y] || { fights: 0, lines: 0 }; perYear[y].fights++; if (lines[f.id]) perYear[y].lines++; }
    const unmatchedFights = target.filter(f => !lines[f.id]).map(f => ({ fightId: f.id, date: f.date, event: f.event, fighter1: fullName(fighterById.get(f.fighter1_id)), fighter2: fullName(fighterById.get(f.fighter2_id)),
      fighter1Status: processed.has(f.fighter1_id) ? (noPage.get(f.fighter1_id) || 'page-parsed') : (idMap.has(f.fighter1_id) ? 'id-known-not-fetched' : 'unreached'),
      fighter2Status: processed.has(f.fighter2_id) ? (noPage.get(f.fighter2_id) || 'page-parsed') : (idMap.has(f.fighter2_id) ? 'id-known-not-fetched' : 'unreached') }));
    fs.writeFileSync(REPORT, JSON.stringify({
      generatedAt: new Date().toISOString(), since: SINCE, targetFights: target.length, covered, coverage: covered / target.length, perYear,
      pagesFetchedThisRun: fetches, fighterMap: Object.fromEntries(idMap), processed: Object.fromEntries([...processed].map(id => [id, true])),
      noPage: Object.fromEntries(noPage), unmatchedFights,
      // only rows that could have been a target fight (dated, in range, not a future/unconfirmed booking)
      unmatchedBfoRows: unmatchedRows.filter(r => r.bfoDate && r.bfoDate >= SINCE && r.bfoDate <= new Date().toISOString().slice(0, 10) && !/future|unconfirmed/i.test(r.bfoEvent || '')),
    }, null, 1));
    return covered;
  };

  // seeds
  for (const slug of SEEDS) {
    const f = bySlug.get(slug); if (!f || idMap.has(f.id) || processed.has(f.id)) continue;
    const r = await resolveBySuggest(f.id);
    if (r === 'limited') break;
    console.log(`seed ${slug}: ${r ? `${r.matched} rows matched, +${r.added} lines` : 'not resolved'}`);
  }

  // main loop: always take the unprocessed fighter with the most uncovered fights,
  // preferring ones whose BFO id is already known (graph) over suggest lookups.
  let n = 0, limited = false;
  const deferred = new Set(); // would need a fetch but --limit is spent; cached pages are still parsed
  while (true) {
    let pick = null, pickScore = -1;
    for (const [id] of fightsByFighter) {
      if (processed.has(id) || deferred.has(id)) continue;
      const u = uncovered(id); if (!u) continue;
      const score = u * (idMap.has(id) ? 10 : 1);
      if (score > pickScore) { pick = id; pickScore = score; }
    }
    if (!pick) break;
    let r;
    try { r = idMap.has(pick) ? await processFighter(pick) : await resolveBySuggest(pick); }
    catch (e) { console.warn(`  ! ${fullName(fighterById.get(pick))}: ${e.message} — skipped`); noPage.set(pick, `error: ${e.message}`); processed.add(pick); save(); continue; }
    if (r === 'limited') { limited = true; deferred.add(pick); continue; }
    n++;
    if (n % 25 === 0) {
      const covered = save();
      console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min] fighters processed ${n} (fetches ${fetches}) — lines on ${covered}/${target.length} target fights (${(100 * covered / target.length).toFixed(1)}%), id map ${idMap.size}`);
    }
  }
  const covered = save();
  console.log(`\nDone${limited ? ' (hit --limit)' : ''}: lines on ${covered}/${target.length} target fights (${(100 * covered / target.length).toFixed(1)}%) — ${fetches} fetches this run, ${unmatchedRows.length} BFO rows unmatched, ${noPage.size} fighters without a verified page.`);
  console.log(`Wrote ${OUT}\n      ${REPORT}`);
}

if (require.main === module) main().catch(e => { console.error('Fatal:', e); process.exit(1); });
module.exports = { parseFighterPage, parseBfoDate, norm };
