/**
 * sherdog-history.js — full pro (and amateur) fight history per fighter from
 * the Sherdog profile page, for the predictor's training path.
 *
 * INTERNAL TRAINING DATA ONLY. Rows go to the sherdog_fights table (migration
 * 2026-10-14-sherdog-fights.sql) and are read by trainModel.loadSherdogHistory;
 * nothing here is served by a route or shown on the site. Sherdog's terms
 * allow access at human pace: 1.5 s between requests (SCRAPE_DELAY_MS),
 * one page per fighter, raw HTML cached so re-runs and re-parses are offline.
 *
 *   node -r dotenv/config src/scrapers/sherdog-history.js [--dry-run] [--limit N]
 *                                                        [--reparse] [--refresh]
 *                                                        [--slug SLUG]
 *
 *   --limit N    stop after N fetched pages (cached fighters do not count)
 *   --reparse    rebuild rows for every cached page without fetching anything
 *   --refresh    re-fetch pages already in the cache (new fights)
 *   --slug SLUG  only that fighter
 *
 * Targets: fighters with a sherdog_id (set by sherdog.js / sherdog-pro-records.js).
 * Resumable: a fighter whose page is in backend/.cache/sherdog-history is
 * parsed from the cache, so an interrupted run just continues. Progress is
 * written to .cache/sherdog-history/progress.json after every fighter.
 * Falls back to .cache/sherdog-history/sherdog-fights.json when the table
 * does not exist yet (the trainer reads that file in that case).
 *
 * Wrong-profile guard (same rule as sherdog-pro-records.js): a page whose pro
 * win or loss count is below the fighter's UFC record is skipped and logged.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const DRY = flag('dry-run'), REPARSE = flag('reparse'), REFRESH = flag('refresh');
const LIMIT = parseInt(opt('limit', 'Infinity')) || Infinity;
const ONLY_SLUG = opt('slug', null);
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const CACHE = path.join(__dirname, '..', '..', '.cache', 'sherdog-history');
const PROGRESS = path.join(CACHE, 'progress.json');
const FALLBACK = path.join(CACHE, 'sherdog-fights.json');
const http = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: () => true,
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadAll(table, cols, filter) {
  const all = [];
  for (let page = 0; ; page++) {
    let q = supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

const pageFile = id => path.join(CACHE, `${id}.html`);
async function fetchPage(sherdogId) {
  const file = pageFile(sherdogId);
  if (!REFRESH && fs.existsSync(file)) return { html: fs.readFileSync(file, 'utf8'), cached: true };
  if (REPARSE) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await http.get(`https://www.sherdog.com/fighter/${sherdogId}`);
    await sleep(DELAY);
    if (res.status === 200) { fs.writeFileSync(file, res.data); return { html: res.data, cached: false }; }
    if (res.status === 404) return { html: null, cached: false, status: 404 };
    const wait = res.status === 429 ? 60000 * (attempt + 1) : 5000 * (attempt + 1);
    console.log(`  HTTP ${res.status} for ${sherdogId}; waiting ${wait / 1000}s`);
    await sleep(wait);
  }
  return { html: null, cached: false, status: 'gave up' };
}

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function parseDate(s) {
  const m = (s || '').match(/([A-Za-z]{3})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  return m && MONTHS[m[1].toLowerCase()] ? `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}` : null;
}
function methodClass(raw) {
  const s = (raw || '').toLowerCase();
  if (!s) return null;
  if (/no contest|^nc\b/.test(s)) return 'NC';
  if (/draw/.test(s)) return 'Draw';
  if (/disqualif|^dq/.test(s)) return 'DQ';
  if (/submission/.test(s)) return 'SUB';
  if (/^t?ko\b|knockout|technical knockout/.test(s)) return 'KO/TKO';
  if (/decision/.test(s)) return 'DEC';
  return 'Other';
}
const slugOf = href => { const m = (href || '').match(/\/(?:fighter|events)\/([^/?#]+)/); return m ? m[1] : null; };

// The page lists two "FIGHT HISTORY - PRO|AMATEUR" headers; each precedes its
// div.module.fight_history in document order.
function parseHistory(html) {
  const $ = cheerio.load(html);
  const rows = [];
  let amateur = false;
  const counts = { win: 0, loss: 0, draw: 0, nc: 0 };
  $('div.slanted_title, div.module.fight_history').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim().toUpperCase();
    if ($(el).hasClass('slanted_title')) { if (/FIGHT HISTORY - AMATEUR/.test(t)) amateur = true; else if (/FIGHT HISTORY/.test(t)) amateur = false; return; }
    let seq = 0;
    $(el).find('tr').each((_, tr) => {
      const td = $(tr).children('td');
      if (td.length < 6 || !td.eq(0).find('.final_result').length) return; // header row
      const resRaw = td.eq(0).text().trim().toLowerCase();
      const result = /^win/.test(resRaw) ? 'win' : /^loss/.test(resRaw) ? 'loss' : /draw/.test(resRaw) ? 'draw' : /nc|no contest/.test(resRaw) ? 'nc' : 'unknown';
      const oppA = td.eq(1).find('a').first();
      const evA = td.eq(2).find('a').first();
      const methodRaw = td.eq(3).find('b').first().text().replace(/\s+/g, ' ').trim() || td.eq(3).text().replace(/\s+/g, ' ').trim().split('  ')[0];
      rows.push({
        seq: seq++, is_amateur: amateur, result,
        date: parseDate(td.eq(2).find('.sub_line').text()),
        opponent_name: (oppA.text() || td.eq(1).text()).replace(/\s+/g, ' ').trim() || null,
        opponent_sherdog_id: slugOf(oppA.attr('href')),
        event_name: evA.text().replace(/\s+/g, ' ').trim() || null,
        event_sherdog_id: slugOf(evA.attr('href')),
        method: methodClass(methodRaw), method_raw: methodRaw || null,
        round: parseInt(td.eq(4).text()) || null, time: td.eq(5).text().trim() || null,
      });
      if (!amateur && counts[result] != null) counts[result]++;
    });
  });
  return { rows, pro: counts };
}

function readProgress() { try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch { return { done: {}, skipped: {} }; } }
function writeProgress(p) { fs.writeFileSync(PROGRESS, JSON.stringify(p)); }

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const progress = readProgress();
  let fighters = await loadAll('fighters', 'id, slug, first_name, last_name, sherdog_id, wins, losses', q => q.not('sherdog_id', 'is', null));
  if (ONLY_SLUG) fighters = fighters.filter(f => f.slug === ONLY_SLUG);
  fighters.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const { error: probe } = await supabase.from('sherdog_fights').select('fighter_id').limit(1);
  const haveTable = !probe;
  if (!haveTable && !DRY) console.log(`sherdog_fights table not found (${probe.message}); rows will be appended to ${FALLBACK} — run src/db/migrations/2026-10-14-sherdog-fights.sql, then --reparse to load the table.`);
  const fallback = !haveTable && !DRY && fs.existsSync(FALLBACK) ? JSON.parse(fs.readFileSync(FALLBACK, 'utf8')) : {};

  const cachedCount = fighters.filter(f => fs.existsSync(pageFile(f.sherdog_id))).length;
  console.log(`${fighters.length} fighters with a sherdog_id, ${cachedCount} pages cached, ${Object.keys(progress.done).length} done, ${Object.keys(progress.skipped).length} skipped${REPARSE ? ' (reparse: offline)' : ''}${DRY ? ' (dry run)' : ''}`);

  let fetched = 0, parsed = 0, rowsWritten = 0, skipped = 0, missing = 0;
  for (const f of fighters) {
    const name = `${f.first_name} ${f.last_name}`;
    const cachedBefore = fs.existsSync(pageFile(f.sherdog_id));
    if (!REPARSE && !REFRESH && progress.done[f.id] && cachedBefore) continue;
    if (!REPARSE && !REFRESH && progress.skipped[f.id]) continue;
    if (!cachedBefore && fetched >= LIMIT) break;
    const page = await fetchPage(f.sherdog_id);
    if (!page) continue;                                   // --reparse and no cached page
    if (!page.cached) fetched++;
    if (!page.html) { missing++; progress.skipped[f.id] = page.status; writeProgress(progress); console.log(`  ${name}: ${page.status}`); continue; }
    const { rows, pro } = parseHistory(page.html);
    if (pro.win < (f.wins || 0) || pro.loss < (f.losses || 0)) {
      skipped++; progress.skipped[f.id] = `wrong-profile ${pro.win}-${pro.loss} vs UFC ${f.wins}-${f.losses}`; writeProgress(progress);
      console.log(`  SKIP ${name}: Sherdog ${pro.win}-${pro.loss} smaller than UFC ${f.wins}-${f.losses} (${f.sherdog_id})`);
      continue;
    }
    parsed++;
    if (DRY) { console.log(`  [dry] ${name}: ${rows.length} rows (pro ${pro.win}-${pro.loss}-${pro.draw}${pro.nc ? ` ${pro.nc}NC` : ''}, amateur ${rows.filter(r => r.is_amateur).length})`); continue; }
    const payload = rows.map(r => ({ fighter_id: f.id, sherdog_id: f.sherdog_id, ...r }));
    if (haveTable) {
      await supabase.from('sherdog_fights').delete().eq('fighter_id', f.id);
      for (let i = 0; i < payload.length; i += 100) {
        const { error } = await supabase.from('sherdog_fights').insert(payload.slice(i, i + 100));
        if (error) throw new Error(`${name}: ${error.message}`);
      }
    } else { fallback[f.id] = payload; fs.writeFileSync(FALLBACK, JSON.stringify(fallback)); }
    rowsWritten += payload.length;
    progress.done[f.id] = new Date().toISOString(); delete progress.skipped[f.id]; writeProgress(progress);
    if ((parsed % 50) === 0) console.log(`  ... ${parsed} parsed, ${fetched} fetched, ${rowsWritten} rows`);
  }
  console.log(`\nDone: ${parsed} fighters parsed (${fetched} fetched, rest from cache), ${rowsWritten} rows written, ${skipped} wrong-profile skips, ${missing} missing pages`);
}

module.exports = { parseHistory, methodClass, parseDate };
if (require.main === module) main().catch(e => { console.error('Fatal:', e); process.exit(1); });
