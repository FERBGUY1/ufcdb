/**
 * crosscheckMarketLines.js — compare the BestFightOdds closing lines
 * (src/ml/data/market-lines.json) with an independent odds file: the Kaggle
 * "Ultimate UFC Dataset" ufc-master.csv (one closing-ish American line per
 * corner, R_fighter / B_fighter / R_odds / B_odds / date / Winner).
 *
 * Matches CSV rows to DB fights by both fighter names (norm()) and the event
 * date ±1 day, then checks, fight by fight, whether the CSV line falls inside
 * (or within a tolerance of) the BestFightOdds closing range.
 *
 * Reads the DB and the two files; writes nothing except an optional --out JSON.
 * Run: node -r dotenv/config src/ml/crosscheckMarketLines.js --csv PATH [--out PATH] [--since 2010-01-01]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadAll } = require('./trainModel');
const { norm } = require('../scrapers/bestfightodds-lines');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] != null ? argv[i + 1] : d; };
const CSV = opt('csv', null);
const LINES = opt('lines', path.join(__dirname, 'data', 'market-lines.json'));
const OUT = opt('out', null);
const SINCE = opt('since', '2010-01-01');
if (!CSV) { console.error('--csv PATH required'); process.exit(1); }

const implied = a => (a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100));
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

function parseCsv(text) {
  const rows = []; let cur = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field.replace(/\r$/, '')); rows.push(cur); cur = []; field = ''; }
    else field += c;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  const head = rows.shift();
  return rows.filter(r => r.length >= 7).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function main() {
  const csv = parseCsv(fs.readFileSync(CSV, 'utf8')).filter(r => r.date >= SINCE);
  const lines = JSON.parse(fs.readFileSync(LINES, 'utf8'));
  const [events, fights, fighters] = await Promise.all([
    loadAll('events', 'id, name, date'), loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, result'), loadAll('fighters', 'id, first_name, last_name'),
  ]);
  const eventById = new Map(events.map(e => [e.id, e]));
  const nameOf = new Map(fighters.map(f => [f.id, `${f.first_name || ''} ${f.last_name || ''}`.trim()]));
  const target = fights.filter(f => ['win', 'draw', 'no_contest'].includes(f.result) && f.fighter1_id && f.fighter2_id)
    .map(f => ({ ...f, date: eventById.get(f.event_id)?.date })).filter(f => f.date && f.date >= SINCE);
  // index: pair key (sorted norms) -> fights
  const byPair = new Map();
  for (const f of target) {
    const k = [norm(nameOf.get(f.fighter1_id)), norm(nameOf.get(f.fighter2_id))].sort().join('|');
    if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(f);
  }

  let matched = 0, unmatched = [], both = 0, inside = 0, near = 0, far = 0, csvOnly = 0;
  const farList = [], diffs = [];
  const tol = 0.03; // implied-probability tolerance outside the closing range
  for (const r of csv) {
    const k = [norm(r.R_fighter), norm(r.B_fighter)].sort().join('|');
    const cands = (byPair.get(k) || []).filter(f => Math.abs(dayDiff(f.date, r.date)) <= 1);
    if (cands.length !== 1) { unmatched.push({ date: r.date, red: r.R_fighter, blue: r.B_fighter, why: cands.length ? 'ambiguous' : 'no-db-fight' }); continue; }
    matched++;
    const f = cands[0], L = lines[f.id];
    const rOdds = parseFloat(r.R_odds), bOdds = parseFloat(r.B_odds);
    if (!Number.isFinite(rOdds) || !Number.isFinite(bOdds)) continue;
    if (!L) { csvOnly++; continue; }
    both++;
    // orient: CSV red/blue -> DB fighter1/fighter2
    const redIs1 = norm(r.R_fighter) === norm(nameOf.get(f.fighter1_id));
    const side = (csvOdds, bfo) => {
      const vals = [bfo.closeMin, bfo.closeMax].filter(x => x != null).map(implied);
      if (!vals.length) return null;
      const lo = Math.min(...vals), hi = Math.max(...vals), p = implied(csvOdds);
      const d = p < lo ? lo - p : p > hi ? p - hi : 0;
      return d;
    };
    const d1 = side(redIs1 ? rOdds : bOdds, L.f1), d2 = side(redIs1 ? bOdds : rOdds, L.f2);
    if (d1 == null || d2 == null) { both--; continue; }
    const d = Math.max(d1, d2); diffs.push(d);
    if (d === 0) inside++; else if (d <= tol) near++; else { far++; farList.push({ date: f.date, fight: `${nameOf.get(f.fighter1_id)} vs ${nameOf.get(f.fighter2_id)}`, csv: `${redIs1 ? rOdds : bOdds} / ${redIs1 ? bOdds : rOdds}`, bfoClose: `${L.f1.closeMin}…${L.f1.closeMax} / ${L.f2.closeMin}…${L.f2.closeMax}`, bfoOpen: `${L.f1.open} / ${L.f2.open}`, gap: +d.toFixed(3) }); }
  }
  diffs.sort((a, b) => a - b);
  const med = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
  console.log(`Kaggle CSV rows since ${SINCE}: ${csv.length}  |  matched to a DB fight by names + date ±1: ${matched} (${(100 * matched / csv.length).toFixed(1)}%)  |  unmatched ${unmatched.length}`);
  console.log(`Fights with BOTH a CSV line and a BestFightOdds closing range: ${both}  |  CSV line but no BFO line: ${csvOnly}`);
  console.log(`CSV line inside the BFO closing range: ${inside} (${(100 * inside / both).toFixed(1)}%)  |  within ${tol} implied prob of it: ${near} (${(100 * near / both).toFixed(1)}%)  |  further: ${far} (${(100 * far / both).toFixed(1)}%)  |  median gap ${med?.toFixed(4)}`);
  const whyCount = unmatched.reduce((m, u) => (m[u.why] = (m[u.why] || 0) + 1, m), {});
  console.log('Unmatched CSV rows by reason:', whyCount);
  console.log('Sample unmatched:', unmatched.slice(0, 15).map(u => `${u.date} ${u.red} vs ${u.blue} (${u.why})`).join('\n  '));
  console.log('Largest disagreements:', farList.sort((a, b) => b.gap - a.gap).slice(0, 10));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), csvRows: csv.length, matched, both, csvOnly, inside, near, far, medianGap: med, unmatched, far: farList }, null, 1));
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
