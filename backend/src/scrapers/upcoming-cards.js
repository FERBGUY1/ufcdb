/**
 * upcoming-cards.js — sync scheduled UFC cards into the DB and log the
 * predictor's picks for them before they happen. Manual command (no schedule).
 *
 * Per event in the window, oldest first:
 *   1. backfill-event.js --upcoming dry run. Creates the event row, inserts new
 *      bouts as result='upcoming', deletes bouts that left the card (guarded:
 *      no result data), syncs kept bouts' weight class / title flags / scheduled
 *      rounds, re-sequences bout_order, creates debutant fighter rows from their
 *      ufcstats page (same identity checks as the weekly backfill).
 *   2. Clean = no abort, no identity conflict, no VARIANT (spelling) match, no
 *      SUSPECT near-match on a fighter create, final count == source count.
 *      Not clean -> that event is reported and skipped; the rest still run.
 *   3. --apply: backfill-event.js --upcoming --apply (with --title / --interim
 *      from the ufcstats belt bouts; fix-bout-order.js sets card_position from
 *      Wikipedia), then sherdog-pro-records.js --ids <new fighters> (Sherdog pro
 *      record + sherdog_id), then log-predictions.js --void-missing (locks the
 *      first pick per bout; picks whose matchup left the card are voided).
 *
 * Source: the ufcstats upcoming listing. If it cannot be fetched (or --wiki),
 * Wikipedia's List of UFC events + event pages are used instead. That path
 * never creates fighters (no ufcstats identity to check against) and sets no
 * title flags; an unknown fighter stops that event for manual handling.
 *
 * Flags: --apply              write (default: dry run, nothing written)
 *        --days N             events dated today .. today+N (default 14)
 *        --ufc-id ID[,ID]     only these ufcstats events (ignores --days)
 *        --wiki               use the Wikipedia fallback even if ufcstats works
 *        --no-log             sync cards only, do not log predictions
 *
 * Output: one block per event; full child output in a temp-dir log.
 * Run: node -r dotenv/config src/scrapers/upcoming-cards.js [--apply]
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');
const cheerio = require('cheerio');

const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FORCE_WIKI = process.argv.includes('--wiki');
const NO_LOG = process.argv.includes('--no-log');
const DAYS = parseInt(arg('--days') || '14', 10);
const ONLY = (arg('--ufc-id') || '').split(',').map(s => s.trim()).filter(Boolean);
const BACKEND = path.resolve(__dirname, '../..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MONTHS = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06', July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG = path.join(os.tmpdir(), `ufcdb-upcoming-${STAMP}.log`);

let failed = false;
const log = text => fs.appendFileSync(LOG, text);
function run(args) {
  log(`\n\n$ node -r dotenv/config ${args.join(' ')}\n`);
  const res = spawnSync('node', ['-r', 'dotenv/config', ...args], { cwd: BACKEND, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = (res.stdout || '') + (res.stderr || '');
  log(out);
  return { status: res.status, out };
}

// ── listings ────────────────────────────────────────────────────────────────
async function fetchUfcstatsUpcoming() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await (await browser.newContext({ userAgent: UA })).newPage();
    await page.goto('http://ufcstats.com/statistics/events/upcoming?page=all', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/event-details/"]', { timeout: 30000 });
    const $ = cheerio.load(await page.content());
    return $('tr.b-statistics__table-row').map((_, tr) => {
      const a = $(tr).find('a.b-link[href*="/event-details/"]').first();
      const m = $(tr).find('span.b-statistics__date').first().text().trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
      if (!a.length || !m) return null;
      return { id: a.attr('href').split('/').pop(), name: a.text().replace(/\s+/g, ' ').trim(),
        date: `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`, location: $(tr).find('td').eq(1).text().replace(/\s+/g, ' ').trim() };
    }).get().filter(Boolean);
  } finally { await browser.close(); }
}

// Wikipedia fallback: build a backfill-event.js --source-json card file per event.
async function wikiSources(from, to) {
  const { fetchWikiEventList, fetchWikiFightOrder } = require('./fix-bout-order');
  const events = (await fetchWikiEventList()).filter(e => e.date >= from && e.date <= to);
  const out = [];
  for (const e of events) {
    const bouts = await fetchWikiFightOrder(e.wikiUrl);
    const file = path.join(os.tmpdir(), `ufcdb-upcoming-wiki-${e.date}-${STAMP}.json`);
    fs.writeFileSync(file, JSON.stringify({
      source: 'wikipedia ' + e.wikiUrl, name: e.name, date: e.date, location: '',
      card: bouts.map(b => ({ fightId: null, fighters: [{ name: b.f1, ufcId: null }, { name: b.f2, ufcId: null }], title: false, flags: [], wc: b.wc || '' })),
    }, null, 2));
    out.push({ id: null, name: e.name, date: e.date, sourceFile: file, bouts: bouts.length });
  }
  return out;
}

// ── backfill-event.js wrapper ───────────────────────────────────────────────
function backfill(ev, apply, d) {
  const sumPath = path.join(os.tmpdir(), `ufcdb-upcoming-${ev.id || ev.date}-${apply ? 'apply' : 'dry'}.json`);
  try { fs.unlinkSync(sumPath); } catch (_) { /* none */ }
  const args = ['src/scrapers/backfill-event.js', '--upcoming', '--summary-json', sumPath];
  if (ev.sourceFile) args.push('--source-json', ev.sourceFile); else args.push('--ufc-id', ev.id);
  if (apply) args.push('--apply');
  if (d && d.titleBouts.length) args.push('--title', d.titleBouts.join(','));
  if (d && (d.interimBouts || []).length) args.push('--interim', d.interimBouts.join(','));
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
  (s.variants || []).forEach(v => r.push(`variant match needs review: ${v}`));
  (s.creates || []).filter(c => c.suspect.length).forEach(c => r.push(`create ${c.name} (${c.ufcId}) has near-match ${c.suspect.join(', ')}`));
  return r;
}

const bos = a => (a && a.length ? a.map(i => 'bo' + i).join(',') : 'none');
function planText(d) {
  const lines = [
    `${d.sourceCount} bouts: ${d.matched} already in DB, ${(d.inserts || []).length} new, ${d.stale.length} leaving the card`,
    `title ${bos(d.titleBouts)}, interim ${bos(d.interimBouts)}`,
  ];
  (d.inserts || []).forEach(x => lines.push(`  + ${x}`));
  d.stale.forEach(x => lines.push(`  - ${x}`));
  (d.syncUpdates || []).forEach(x => lines.push(`  ~ ${x}`));
  d.creates.forEach(c => lines.push(`  new fighter: ${c.name} (ufcstats ${c.ufcId})`));
  return lines;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`UFCDB upcoming cards${APPLY ? ' — APPLY' : ' (DRY RUN — nothing written)'}`);
  fs.writeFileSync(LOG, `upcoming-cards ${new Date().toISOString()}${APPLY ? ' APPLY' : ' DRY RUN'}\n`);
  const today = new Date().toLocaleDateString('en-CA');
  const until = new Date(Date.now() + DAYS * 86400000).toLocaleDateString('en-CA');

  let events = null;
  if (!FORCE_WIKI) {
    try {
      const listing = await fetchUfcstatsUpcoming();
      events = ONLY.length ? listing.filter(e => ONLY.includes(e.id)) : listing.filter(e => e.date >= today && e.date <= until);
      const missing = ONLY.filter(id => !listing.some(e => e.id === id));
      if (missing.length) { console.log(`✗ not in the ufcstats upcoming listing: ${missing.join(', ')}`); failed = true; }
    } catch (e) {
      console.log(`! ufcstats upcoming listing failed (${e.message}) — falling back to Wikipedia`);
    }
  }
  if (!events) {
    if (ONLY.length) { console.log('✗ --ufc-id needs ufcstats'); failed = true; return; }
    events = await wikiSources(today, until);
    console.log(`source: Wikipedia — ${events.length} events (fighters are matched only, never created; no title flags)`);
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`${events.length} event(s)${ONLY.length ? '' : ` dated ${today} .. ${until}`}: ${events.map(e => `${e.date} ${e.name}`).join(' | ') || 'none'}`);

  for (const ev of events) {
    console.log(`\n■ ${ev.date} ${ev.name}${ev.id ? ` [${ev.id}]` : ' [wikipedia]'}`);
    const dry = backfill(ev, false);
    const reasons = uncleanReasons(dry);
    if (dry.s && dry.s.ok) planText(dry.s).forEach(l => console.log(`  ${l}`));
    if (reasons.length) {
      failed = true;
      console.log(`  ✗ NOT CLEAN — skipped: ${reasons.join('; ')}`);
      continue;
    }
    if (!APPLY) { console.log('  ✓ clean (dry run)'); continue; }

    const app = backfill(ev, true, dry.s);
    const a = app.s;
    if (!a || app.status !== 0 || !a.ok) {
      failed = true;
      console.log(`  ✗ apply FAILED: ${a ? a.abort || 'exit ' + app.status : 'no summary, exit ' + app.status}`);
      continue;
    }
    console.log(`  ✓ card synced: ${a.finalCount}/${a.sourceCount} bouts, null card_position: ${bos(a.nullCardPosition)}`);
    if (a.finalCount !== a.sourceCount) failed = true;

    if ((a.createdIds || []).length) {
      const r = run(['src/scrapers/sherdog-pro-records.js', '--ids', a.createdIds.join(',')]);
      const m = r.out.match(/Updated:\s+(\d+)[\s\S]*?No match:\s+(\d+)[\s\S]*?Mismatch:\s+(\d+)[\s\S]*?Failed:\s+(\d+)/);
      const ok = r.status === 0 && m && m[2] === '0' && m[3] === '0' && m[4] === '0';
      if (!ok) failed = true;
      console.log(`  ${ok ? '✓' : '✗'} Sherdog: ${m ? `${m[1]} of ${a.createdIds.length} new fighters matched, ${m[2]} no match, ${m[3]} mismatch, ${m[4]} failed` : `exit ${r.status}`}`);
      r.out.split('\n').filter(l => /NO MATCH|SKIP|ERROR/.test(l)).forEach(l => console.log(`    ${l.trim()}`));
    }

    if (NO_LOG) continue;
    const r = run(['src/scrapers/log-predictions.js', '--event-id', a.eventId, '--void-missing']);
    const m = r.out.match(/Done: (\d+) logged, (\d+) skipped, (\d+) voided, (\d+) errors/);
    const ok = r.status === 0 && m && m[4] === '0';
    if (!ok) failed = true;
    console.log(`  ${ok ? '✓' : '✗'} predictions: ${m ? `${m[1]} logged, ${m[2]} already logged/skipped, ${m[3]} voided, ${m[4]} errors` : `exit ${r.status}`}`);
  }
}

main()
  .catch(e => { failed = true; console.log(`✗ fatal: ${e.message}`); })
  .finally(() => {
    console.log(`\nfull log: ${LOG}`);
    process.exitCode = failed ? 1 : 0;
  });
