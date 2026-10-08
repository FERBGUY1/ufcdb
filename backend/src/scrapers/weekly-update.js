/**
 * weekly-update.js — one command for the weekly post-event refresh.
 *
 *   1. Find completed ufcstats events dated after the latest is_complete event in
 *      the DB (and before today, so a card still in progress is left alone).
 *   2. For each, oldest first: dry-run backfill-event.js. If the plan is clean it is
 *      applied with --title set from the ufcstats UFC title bouts (belt icons on
 *      TUF/Road to UFC tournament finals are excluded by backfill-event.js); if not,
 *      the run stops there and reports why. Clean means: the script did not abort (identity
 *      conflict, unsafe stale delete, slug collision, ...), the final card count
 *      equals the source count, no VARIANT (spelling) matches, and no fighter
 *      creation with a SUSPECT near-match (same surname, similar first name), and
 *      no interim title bout (is_interim_title has to be set by hand).
 *      A namesake still blocks; resolve it with backfill-event.js --new-fighter.
 *   3. Fill null card_position from neighbouring bouts (both neighbours agree, or
 *      the only neighbour at either end of the card). Disagreeing neighbours are
 *      a main/prelim boundary and are left for a human.
 *   4. If any event was applied: rankings.js -> computeCareerStats.js ->
 *      computeRatings.js (both scoped to the applied cards' fighters) ->
 *      fix-fighter-records.js -> validate.js. These still run when a later event
 *      was unclean, so the events that did land are never left half-processed.
 *
 * Output is one line per step; full child output goes to a log file in the OS temp
 * dir (path printed at the end). Exits 1 if anything stopped or failed.
 *
 * Flags: --dry-run           find + dry-run the new events only; write nothing
 *        --since YYYY-MM-DD  process events dated after this instead of after the
 *                            latest complete DB event (re-check / re-run a window)
 *
 * Run: npm run weekly   (or: node -r dotenv/config src/scrapers/weekly-update.js)
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const DRY = process.argv.includes('--dry-run');
const SINCE = (() => { const i = process.argv.indexOf('--since'); return i > -1 ? process.argv[i + 1] : null; })();
if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) { console.error('--since takes YYYY-MM-DD'); process.exit(1); }
const BACKEND = path.resolve(__dirname, '../..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MONTHS = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06', July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG = path.join(os.tmpdir(), `ufcdb-weekly-${STAMP}.log`);

let failed = false;
const step = (label, msg, ok = true) => {
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(22)} ${msg}`);
};
const log = text => fs.appendFileSync(LOG, text);

function run(args) {
  log(`\n\n$ node -r dotenv/config ${args.join(' ')}\n`);
  const res = spawnSync('node', ['-r', 'dotenv/config', ...args], {
    cwd: BACKEND, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  log(out);
  return { status: res.status, out };
}
const lastMatch = (out, re) => { const all = [...out.matchAll(new RegExp(re, 'g'))]; return all.length ? all[all.length - 1] : null; };

async function loadAll(table, cols, filter = q => q) {
  const all = [];
  for (let page = 0; ; page++) {
    const { data, error } = await filter(supabase.from(table).select(cols)).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

// ── 1. new events ───────────────────────────────────────────────────────────
async function fetchCompletedListing() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await (await browser.newContext({ userAgent: UA })).newPage();
    await page.goto('http://ufcstats.com/statistics/events/completed', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/event-details/"]', { timeout: 30000 });
    const $ = cheerio.load(await page.content());
    return $('tr.b-statistics__table-row').map((_, tr) => {
      const a = $(tr).find('a.b-link[href*="/event-details/"]').first();
      const m = $(tr).find('span.b-statistics__date').first().text().trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
      if (!a.length || !m) return null;
      return { id: a.attr('href').split('/').pop(), name: a.text().replace(/\s+/g, ' ').trim(), date: `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` };
    }).get().filter(Boolean);
  } finally { await browser.close(); }
}

// ── 2. dry run -> clean? -> apply ────────────────────────────────────────────
function backfill(ev, apply, titleBouts) {
  const sumPath = path.join(os.tmpdir(), `ufcdb-weekly-${ev.id}-${apply ? 'apply' : 'dry'}.json`);
  try { fs.unlinkSync(sumPath); } catch (_) { /* none */ }
  const args = ['src/scrapers/backfill-event.js', '--ufc-id', ev.id, '--summary-json', sumPath];
  if (apply) args.push('--apply');
  if (titleBouts && titleBouts.length) args.push('--title', titleBouts.join(','));
  const { status } = run(args);
  let s = null;
  try { s = JSON.parse(fs.readFileSync(sumPath, 'utf8')); } catch (_) { /* missing = crashed */ }
  return { status, s };
}

function uncleanReasons({ status, s }) {
  if (!s) return [`backfill-event.js exited ${status} with no summary (crash — see log)`];
  const r = [];
  if (status !== 0 || !s.ok) r.push(`aborted: ${s.abort || 'exit ' + status}`);
  (s.conflicts || []).forEach(c => r.push(`identity conflict: ${c}`));
  if (s.ok && s.finalCount !== s.sourceCount) r.push(`fight count ${s.finalCount} != source ${s.sourceCount}`);
  s.variants.forEach(v => r.push(`variant match needs review: ${v}`));
  s.creates.filter(c => c.suspect.length).forEach(c => r.push(`create ${c.name} (${c.ufcId}) has near-match ${c.suspect.join(', ')}`));
  (s.interimBouts || []).forEach(i => r.push(`interim title bout on bo${i} — backfill-event.js cannot set is_interim_title`));
  return r;
}

// ── 3. null card_position from neighbours ───────────────────────────────────
async function fixCardPositions(eventId) {
  const { data: rows, error } = await supabase.from('fights')
    .select('id, bout_order, card_position').eq('event_id', eventId).order('bout_order');
  if (error) return { fixed: [], left: [`query error: ${error.message}`] };
  const fixed = [], left = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].card_position) continue;
    const prev = rows.slice(0, i).reverse().find(r => r.card_position);
    const next = rows.slice(i + 1).find(r => r.card_position);
    const pos = prev && next ? (prev.card_position === next.card_position ? prev.card_position : null)
      : (prev || next || {}).card_position || null;
    if (!pos) { left.push(`bo${rows[i].bout_order}`); continue; }
    const { error: e } = await supabase.from('fights').update({ card_position: pos }).eq('id', rows[i].id).is('card_position', null);
    if (e) left.push(`bo${rows[i].bout_order} (${e.message})`);
    else fixed.push(`bo${rows[i].bout_order}->${pos}`);
  }
  return { fixed, left };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`UFCDB weekly update${DRY ? ' (DRY RUN — nothing written)' : ''}`);
  fs.writeFileSync(LOG, `weekly-update ${new Date().toISOString()}${DRY ? ' DRY RUN' : ''}\n`);

  const { data: latest, error } = await supabase.from('events').select('date, name')
    .eq('is_complete', true).order('date', { ascending: false }).limit(1);
  if (error || !latest.length) { step('find new events', `cannot read latest DB event: ${error ? error.message : 'none'}`, false); return; }
  const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
  const listing = await fetchCompletedListing();
  const after = SINCE || latest[0].date;
  const todo = listing.filter(e => e.date > after && e.date < today).sort((a, b) => a.date.localeCompare(b.date));
  step('find new events', `${SINCE ? `--since ${SINCE}` : `latest in DB ${latest[0].date} (${latest[0].name})`}; ${todo.length} newer on ufcstats${todo.length ? ': ' + todo.map(e => `${e.date} ${e.name}`).join(' | ') : ''}`);
  if (!todo.length) return;

  const applied = []; // { ev, eventId }
  for (const ev of todo) {
    const dry = backfill(ev, false);
    const reasons = uncleanReasons(dry);
    if (reasons.length) {
      step(`dry run ${ev.date}`, `${ev.name}: NOT CLEAN — stopping. ${reasons.join('; ')}`, false);
      break;
    }
    const d = dry.s;
    const plan = `${d.sourceCount} bouts, ${d.matched} matched, ${d.stale.length} stale, ${d.creates.length} new fighters${d.creates.length ? ' (' + d.creates.map(c => c.name).join(', ') + ')' : ''}, title ${d.titleBouts.length ? d.titleBouts.map(i => 'bo' + i).join(',') : 'none'}${(d.tournamentBouts || []).length ? `, tournament finals bo${d.tournamentBouts.join(',bo')} (not flagged)` : ''}`;
    if (DRY) { step(`dry run ${ev.date}`, `${ev.name}: clean — ${plan}`); continue; }

    const app = backfill(ev, true, d.titleBouts);
    const a = app.s;
    if (!a || app.status !== 0 || !a.ok) {
      step(`apply ${ev.date}`, `${ev.name}: FAILED — ${a ? a.abort || 'exit ' + app.status : 'no summary, exit ' + app.status} — stopping`, false);
      if (a && a.eventId) applied.push({ ev, eventId: a.eventId });
      break;
    }
    applied.push({ ev, eventId: a.eventId });
    const cp = await fixCardPositions(a.eventId);
    const problems = [];
    if (a.unresolved.length) problems.push(`no result on bo${a.unresolved.join(',bo')}`);
    if ((a.orientationViolations || []).length) problems.push(`winner!=fighter1 on bo${a.orientationViolations.join(',bo')}`);
    if (!a.isComplete) problems.push('is_complete not set');
    if (cp.left.length) problems.push(`card_position still null: ${cp.left.join(', ')}`);
    step(`apply ${ev.date}`,
      `${ev.name}: ${a.finalCount}/${a.sourceCount} bouts — ${plan}; card_position fixed ${cp.fixed.length ? cp.fixed.join(', ') : 'none needed'}${problems.length ? ' — ' + problems.join('; ') : ''}`,
      !problems.length);
  }

  if (DRY || !applied.length) {
    if (!DRY) step('post-event scripts', 'skipped — no event applied', !failed);
    return;
  }

  // ── 4. post-event scripts ─────────────────────────────────────────────────
  const fights = [];
  for (const { eventId } of applied) {
    fights.push(...await loadAll('fights', 'fighter1_id, fighter2_id', q => q.eq('event_id', eventId)));
  }
  const ids = [...new Set(fights.flatMap(f => [f.fighter1_id, f.fighter2_id]).filter(Boolean))];
  const fighters = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('fighters').select('id, first_name, last_name').in('id', ids.slice(i, i + 100));
    fighters.push(...(data || []));
  }

  let r = run(['src/scrapers/rankings.js']);
  let m = lastMatch(r.out, /Done — (\d+) champions, (\d+) ranked fighters updated/);
  step('rankings.js', m ? `${m[1]} champions, ${m[2]} ranked fighters updated` : `exit ${r.status}, no completion line`, r.status === 0 && !!m);

  const names = fighters.map(f => `${f.first_name} ${f.last_name}`.toLowerCase()).join(',');
  r = run(['src/ml/computeCareerStats.js', '--fighter', names, '--apply']);
  m = lastMatch(r.out, /Updated: (\d+)\s*\|\s*no stats fights \(untouched\): (\d+)\s*\|\s*errors: (\d+)/);
  step('computeCareerStats.js', m ? `${m[1]} updated, ${m[2]} without stats, ${m[3]} errors (${ids.length} card fighters)` : `exit ${r.status}, no completion line`, r.status === 0 && !!m && m[3] === '0');

  let rated = 0, rateErr = 0, rateOk = true;
  for (let i = 0; i < ids.length; i += 100) {
    r = run(['src/ml/computeRatings.js', '--ids', ids.slice(i, i + 100).join(','), '--apply']);
    m = lastMatch(r.out, /Updated ratings for (\d+) fighters\s*\|\s*errors: (\d+)/);
    if (r.status !== 0 || !m) { rateOk = false; continue; }
    rated += +m[1]; rateErr += +m[2];
  }
  step('computeRatings.js', rateOk ? `${rated} updated, ${rateErr} errors` : `a batch failed (exit ${r.status}) — see log`, rateOk && rateErr === 0);

  r = run(['src/scrapers/fix-fighter-records.js']);
  m = lastMatch(r.out, /Done -- (\d+) updated, (\d+) errors/);
  step('fix-fighter-records.js', m ? `${m[1]} fighters updated, ${m[2]} errors` : `exit ${r.status}, no completion line`, r.status === 0 && !!m && m[2] === '0');

  r = run(['src/validate.js']);
  const pass = /All checks passed/.test(r.out);
  m = lastMatch(r.out, /Total issues found: (\d+)/);
  step('validate.js', pass ? 'all checks passed' : `${m ? m[1] + ' issues found' : 'exit ' + r.status} — see log`, r.status === 0 && pass);
}

main()
  .catch(e => step('fatal', e.message, false))
  .finally(() => {
    console.log(`\nfull log: ${LOG}`);
    process.exitCode = failed ? 1 : 0;
  });
