/**
 * ufcstats-fight-stats.js — Per-fight results, totals and per-round stats from ufcstats.com
 *
 * Fills, for every completed fight matched to a ufcstats fight page:
 *   - result (only with --write-results): winner_id, result ('win'/'draw'/
 *     'no_contest'), method, round, time — read from the EVENT page fight rows
 *     (col 0 flag = winner, who is listed first; cols 7/8/9 = method/round/time).
 *     Orientation A: on a win, fighter1_id/fighter2_id are swapped when the DB
 *     has the loser as fighter1, so fighter1_id is always the winner (DB
 *     convention); the rounds_data f1/f2 mapping is aligned to the same
 *     winner-first order in the same write.
 *   - fight totals: fighter1/2 kd, sig_str ("x of y"), sig_str_pct, total_str,
 *     td, td_pct, sub_att, rev
 *   - judge scorecards (judge1/2/3_score) and time_format
 *   - rounds_data JSONB: per-round totals + significant-strike breakdown by
 *     target (head/body/leg) and position (distance/clinch/ground), keyed
 *     f1/f2 to match the DB fighter1_id/fighter2_id (NOT the page order)
 *
 * Access: ufcstats.com sits behind a JS proof-of-work gate. A headless Chrome
 * (playwright-core, same binary as tapology-scraper) solves it once; the _fmc
 * cookie (7-day TTL) then lets plain axios through. If a response comes back
 * as the challenge page mid-run, the gate is re-solved automatically.
 *
 * Matching: event.ufc_id -> ufcstats event page -> fight rows keyed by the
 * fighter-details id pair -> DB fights via fighters.ufc_id (name fallback).
 *
 * Resume: progress file at repo root (ufcstats-stats-progress.json) records
 * fully-processed event ufc_ids + fights with no stats on ufcstats (early
 * era). Re-running skips both. Kill it any time — per-fight updates are
 * idempotent; the current event is simply re-swept on the next run.
 *
 * Flags:
 *   --dry-run          parse everything, write nothing to the DB
 *   --write-results    also read + write result/winner/method/round/time from the
 *                      event page (orientation A). OFF by default, so results are
 *                      never written until explicitly enabled; it also makes
 *                      fights that still lack a result eligible targets.
 *   --limit N          process at most N events
 *   --offset N         skip the first N target events
 *   --event "substr"   only events whose DB name contains substr
 *   --force            re-scrape fights even if rounds_data already set
 *   --reset-progress   ignore + overwrite the progress file
 *   --delay MS         per-request delay (default 1200)
 *   --log FILE         planned/applied payload log (default ufcstats-stats-log.json)
 *
 * Run: node -r dotenv/config src/scrapers/ufcstats-fight-stats.js --dry-run --limit 3
 */
require('dotenv').config();
const { chromium } = require('playwright-core');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const supabase = require('../db/client');

const DRY    = process.argv.includes('--dry-run');
const FORCE  = process.argv.includes('--force');
const RESET  = process.argv.includes('--reset-progress');
const WRITE_RESULTS = process.argv.includes('--write-results');
const LIMIT  = (() => { const i = process.argv.indexOf('--limit');  return i > -1 ? parseInt(process.argv[i + 1]) : Infinity; })();
const OFFSET = (() => { const i = process.argv.indexOf('--offset'); return i > -1 ? parseInt(process.argv[i + 1]) : 0; })();
const EVARG  = (() => { const i = process.argv.indexOf('--event');  return i > -1 ? process.argv[i + 1] : null; })();
const DELAY  = (() => { const i = process.argv.indexOf('--delay');  return i > -1 ? parseInt(process.argv[i + 1]) : 1200; })();
const LOGFILE = (() => { const i = process.argv.indexOf('--log');   return i > -1 ? process.argv[i + 1] : 'ufcstats-stats-log.json'; })();

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'http://ufcstats.com';
const PROGRESS_FILE = path.resolve(__dirname, '../../../ufcstats-stats-progress.json');
const TODAY = new Date().toISOString().split('T')[0];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// ── Gate solving + gated HTTP ────────────────────────────────────────────────
let cookieJar = '';

async function solveGate() {
  console.log('  [gate] solving proof-of-work challenge via headless Chrome...');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(BASE + '/statistics/events/completed', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/event-details/"]', { timeout: 30000 });
    const cookies = await ctx.cookies(BASE);
    cookieJar = cookies.map(c => c.name + '=' + c.value).join('; ');
    console.log('  [gate] solved');
  } finally {
    await browser.close();
  }
}

const isChallenge = body => /Checking your browser/i.test(body) && body.length < 20000;

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data, status } = await axios.get(url, {
        timeout: 25000, validateStatus: () => true,
        headers: { 'User-Agent': UA, Cookie: cookieJar },
      });
      const body = (data || '').toString();
      if (status === 200 && !isChallenge(body)) return body;
      if (isChallenge(body)) { await solveGate(); continue; }
      throw new Error('HTTP ' + status);
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(3000 * attempt);
    }
  }
}

// ── Parsing helpers ─────────────────────────────────────────────────────────
const ofPair = t => {
  const m = (t || '').match(/(\d+)\s+of\s+(\d+)/);
  return m ? { landed: +m[1], att: +m[2] } : null;
};
const toInt = t => { const n = parseInt((t || '').trim(), 10); return Number.isNaN(n) ? null : n; };
const ctrlSec = t => {
  const m = (t || '').match(/(\d+):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
};
const cleanPct = t => { const m = (t || '').match(/\d+%/); return m ? m[0] : null; };

// Map a ufcstats method label onto the DB method vocabulary (CLAUDE.md).
// Unrecognized labels pass through unchanged so they surface rather than being
// silently coerced (the run log flags anything outside the known set).
function mapMethod(raw) {
  const m = (raw || '').trim();
  const U = m.toUpperCase();
  if (U === 'KO/TKO') return 'KO/TKO';
  if (U === 'SUB' || U === 'SUBMISSION') return 'SUB';
  if (U === 'U-DEC') return 'U-DEC';
  if (U === 'S-DEC') return 'S-DEC';
  if (U === 'M-DEC') return 'M-DEC';
  if (U === 'DEC') return 'DEC';
  if (U === 'DQ') return 'DQ';
  if (U === 'OVERTURNED') return 'Overturned';
  if (U === 'CNC' || /COULD NOT CONTINUE/.test(U)) return 'CNC';
  if (U === 'DRAW') return 'Draw';
  return m || null;
}

// Result type from the event-row flag(s). ufcstats lists the winner first, so a
// 'win' flag attributes to the first-listed fighter; draws/NCs have no winner.
function resultFromFlags(flags) {
  const s = new Set(flags);
  if (s.has('win')) return 'win';
  if (s.has('draw')) return 'draw';
  if (s.has('nc')) return 'no_contest';
  return null;
}

// Every stats-table cell holds two <p>: index 0 = first page fighter, 1 = second.
function cellPair($, td) {
  const ps = $(td).find('p');
  return [$(ps[0]).text().replace(/\s+/g, ' ').trim(), $(ps[1]).text().replace(/\s+/g, ' ').trim()];
}

// Totals-style row (KD, Sig str, Sig str %, Total str, Td, Td %, Sub att, Rev, Ctrl)
function parseTotalsRow($, tr) {
  const tds = $(tr).find('td');
  if (tds.length < 10) return null;
  const grab = i => cellPair($, tds[i]);
  const out = [{}, {}];
  const [kdA, kdB] = grab(1);
  const [sigA, sigB] = grab(2);
  const [sigPctA, sigPctB] = grab(3);
  const [totA, totB] = grab(4);
  const [tdA, tdB] = grab(5);
  const [tdPctA, tdPctB] = grab(6);
  const [subA, subB] = grab(7);
  const [revA, revB] = grab(8);
  const [ctrlA, ctrlB] = grab(9);
  const fill = (o, kd, sig, sigPct, tot, td, tdPct, sub, rev, ctrl) => {
    o.kd = toInt(kd); o.sig = ofPair(sig); o.sig_pct = cleanPct(sigPct); o.total = ofPair(tot);
    o.td = ofPair(td); o.td_pct = cleanPct(tdPct); o.sub_att = toInt(sub); o.rev = toInt(rev);
    o.ctrl_sec = ctrlSec(ctrl);
  };
  fill(out[0], kdA, sigA, sigPctA, totA, tdA, tdPctA, subA, revA, ctrlA);
  fill(out[1], kdB, sigB, sigPctB, totB, tdB, tdPctB, subB, revB, ctrlB);
  return out;
}

// Sig-strikes-style row (Sig str, Sig str %, Head, Body, Leg, Distance, Clinch, Ground)
function parseSigRow($, tr) {
  const tds = $(tr).find('td');
  if (tds.length < 9) return null;
  const out = [{}, {}];
  const keys = ['head', 'body', 'leg', 'distance', 'clinch', 'ground'];
  keys.forEach((k, i) => {
    const [a, b] = cellPair($, tds[3 + i]);
    out[0][k] = ofPair(a);
    out[1][k] = ofPair(b);
  });
  return out;
}

function flattenRound(tot, sig) {
  const f = {};
  if (tot) {
    f.kd = tot.kd; f.sub_att = tot.sub_att; f.rev = tot.rev; f.ctrl_sec = tot.ctrl_sec;
    f.sig_landed = tot.sig?.landed ?? null;   f.sig_att = tot.sig?.att ?? null;
    f.total_landed = tot.total?.landed ?? null; f.total_att = tot.total?.att ?? null;
    f.td_landed = tot.td?.landed ?? null;     f.td_att = tot.td?.att ?? null;
  }
  if (sig) {
    for (const k of ['head', 'body', 'leg', 'distance', 'clinch', 'ground']) {
      f[k + '_landed'] = sig[k]?.landed ?? null;
      f[k + '_att'] = sig[k]?.att ?? null;
    }
  }
  return f;
}

/**
 * Parse a fight-details page.
 * Returns { pageFighters: [{ufcId, name, status}], totals: [a, b], rounds: [...page order...],
 *           timeFormat, judges: ["Name: S1-S2", ...] } or null when the page has no stats.
 */
function parseFightPage(html) {
  const $ = cheerio.load(html);

  const pageFighters = $('.b-fight-details__person').map((_, d) => ({
    ufcId: ($(d).find('.b-fight-details__person-name a').attr('href') || '').split('/').pop() || null,
    name: $(d).find('.b-fight-details__person-name a').text().trim(),
    status: $(d).find('.b-fight-details__person-status').text().trim(),
  })).get();
  if (pageFighters.length !== 2) return null;

  // header: time format + judge scorecards
  let timeFormat = null;
  const headerTxt = $('.b-fight-details__text').first().text().replace(/\s+/g, ' ');
  const tfm = headerTxt.match(/Time format:\s*(.+?)\s*Referee:/i) || headerTxt.match(/Time format:\s*(.+)$/i);
  if (tfm) timeFormat = tfm[1].trim();

  // scores kept structured: a/b = first/second page fighter, remapped to DB
  // fighter1/fighter2 order in buildPayload
  const judges = [];
  $('.b-fight-details__text').eq(1).find('i.b-fight-details__text-item').each((_, it) => {
    const t = $(it).text().replace(/\s+/g, ' ').trim();
    const m = t.match(/^(.+?)\s+(\d+)\s*-\s*(\d+)\s*\.?$/);
    if (m) judges.push({ name: m[1].trim(), a: +m[2], b: +m[3] });
  });

  // stats tables: 0=totals, 1=per-round totals, 2=sig totals, 3=per-round sig
  const tables = $('table').toArray();
  if (tables.length < 1) return { pageFighters, totals: null, rounds: [], timeFormat, judges };

  const totalsRow = $(tables[0]).find('tbody tr').first();
  const totals = totalsRow.length ? parseTotalsRow($, totalsRow) : null;
  if (!totals || (totals[0].sig === null && totals[0].total === null && totals[0].kd === null)) {
    return { pageFighters, totals: null, rounds: [], timeFormat, judges };
  }

  const roundTotals = tables[1] ? $(tables[1]).find('tbody tr').toArray().map(tr => parseTotalsRow($, tr)) : [];
  const roundSig    = tables[3] ? $(tables[3]).find('tbody tr').toArray().map(tr => parseSigRow($, tr)) : [];
  const nRounds = Math.max(roundTotals.length, roundSig.length);
  const rounds = [];
  for (let r = 0; r < nRounds; r++) {
    rounds.push({
      round: r + 1,
      a: flattenRound(roundTotals[r]?.[0], roundSig[r]?.[0]),
      b: flattenRound(roundTotals[r]?.[1], roundSig[r]?.[1]),
    });
  }
  return { pageFighters, totals, rounds, timeFormat, judges };
}

const ofStr = p => (p ? `${p.landed} of ${p.att}` : null);

// Build the DB update payload with page fighters mapped onto DB fighter1/fighter2.
// idx1 = index (0|1) of the page fighter corresponding to DB fighter1_id.
function buildPayload(parsed, idx1) {
  const idx2 = 1 - idx1;
  const A = parsed.totals[idx1], B = parsed.totals[idx2];
  const payload = {
    fighter1_kd: A.kd,            fighter2_kd: B.kd,
    fighter1_sig_str: ofStr(A.sig),     fighter2_sig_str: ofStr(B.sig),
    fighter1_sig_str_pct: A.sig_pct,    fighter2_sig_str_pct: B.sig_pct,
    fighter1_total_str: ofStr(A.total), fighter2_total_str: ofStr(B.total),
    fighter1_td: ofStr(A.td),           fighter2_td: ofStr(B.td),
    fighter1_td_pct: A.td_pct,          fighter2_td_pct: B.td_pct,
    fighter1_sub_att: A.sub_att,        fighter2_sub_att: B.sub_att,
    fighter1_rev: A.rev,                fighter2_rev: B.rev,
    rounds_data: parsed.rounds.map(r => ({
      round: r.round,
      f1: idx1 === 0 ? r.a : r.b,
      f2: idx1 === 0 ? r.b : r.a,
    })),
  };
  if (parsed.timeFormat) payload.time_format = parsed.timeFormat;
  // judge scores stored fighter1-first regardless of page order
  const scoreStr = j => `${j.name}: ${idx1 === 0 ? j.a : j.b}-${idx1 === 0 ? j.b : j.a}`;
  if (parsed.judges[0]) payload.judge1_score = scoreStr(parsed.judges[0]);
  if (parsed.judges[1]) payload.judge2_score = scoreStr(parsed.judges[1]);
  if (parsed.judges[2]) payload.judge3_score = scoreStr(parsed.judges[2]);
  return payload;
}

// ── DB loading ───────────────────────────────────────────────────────────────
async function loadAll(table, cols, mod) {
  const all = [];
  let page = 0;
  while (true) {
    let q = supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (mod) q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`loadAll(${table}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

// ── Progress ────────────────────────────────────────────────────────────────
function loadProgress() {
  if (RESET || !fs.existsSync(PROGRESS_FILE)) return { completedEvents: {}, noStatsFights: {}, unmatched: [] };
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { completedEvents: {}, noStatsFights: {}, unmatched: [] }; }
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`ufcstats fight-stats scraper ${DRY ? '*** DRY RUN ***' : '*** APPLY ***'}${WRITE_RESULTS ? '  [+result-reader]' : ''}\n`);

  const events = await loadAll('events', 'id, ufc_id, name, date');
  const fighters = await loadAll('fighters', 'id, ufc_id, first_name, last_name');
  const fights = await loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, result, rounds_data');
  console.log(`Loaded ${events.length} events, ${fighters.length} fighters, ${fights.length} fights`);

  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const fighterByUfcId = {};
  fighters.forEach(f => { if (f.ufc_id) fighterByUfcId[f.ufc_id] = f; });
  const fname = id => { const f = fighterById[id]; return f ? `${f.first_name} ${f.last_name}` : id; };

  const fightsByEvent = {};
  fights.forEach(f => { (fightsByEvent[f.event_id] = fightsByEvent[f.event_id] || []).push(f); });

  const progress = loadProgress();
  // With --write-results, fights that still lack a result become eligible too
  // (that's the point — nothing else writes results for 2026+ events). Without
  // it, targeting is exactly as before (needs a result already set + no stats).
  const needsResult = f => WRITE_RESULTS && (!f.result || f.result === 'upcoming');
  const needsStats = f => needsResult(f) ||
    (f.result && f.result !== 'upcoming' && (FORCE || (!f.rounds_data && !progress.noStatsFights[f.id])));

  let targets = events
    .filter(e => e.ufc_id && e.date < TODAY)
    .filter(e => (fightsByEvent[e.id] || []).some(needsStats))
    .filter(e => !EVARG || e.name.toLowerCase().includes(EVARG.toLowerCase()))
    .filter(e => FORCE || !progress.completedEvents[e.ufc_id])
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(OFFSET, OFFSET + LIMIT);

  console.log(`Target events: ${targets.length} (progress file: ${Object.keys(progress.completedEvents).length} done, ${Object.keys(progress.noStatsFights).length} known no-stats fights)\n`);
  if (!targets.length) { console.log('Nothing to do.'); return; }

  await solveGate();

  const log = { updated: [], noStats: [], unmatched: [], errors: [], samplePayloads: [] };
  let processed = 0, totalUpdated = 0, totalNoStats = 0, totalResults = 0;

  for (const ev of targets) {
    processed++;
    const evLabel = `${ev.name} (${ev.date})`;
    let evUpdated = 0, evNoStats = 0, evUnmatched = 0, evErrors = 0;

    let evHtml;
    await sleep(DELAY);
    try { evHtml = await get(`${BASE}/event-details/${ev.ufc_id}`); }
    catch (e) { log.errors.push(`${evLabel}: event page failed (${e.message})`); continue; }

    const $ = cheerio.load(evHtml);
    const pageRows = $('tr[data-link*="/fight-details/"]').map((_, tr) => {
      const cols = $(tr).find('td');
      const fids = $(tr).find('a[href*="/fighter-details/"]').map((_, a) => ({
        ufcId: ($(a).attr('href') || '').split('/').pop(),
        name: $(a).text().trim(),
      })).get();
      const colP = i => $(cols[i]).find('p').map((_, x) => $(x).text().replace(/\s+/g, ' ').trim()).get();
      return {
        fightId: ($(tr).attr('data-link') || '').split('/').pop(),
        fighters: fids.slice(0, 2),
        // result columns on the event page: 0 flag | 7 method | 8 round | 9 time
        flags: $(cols[0]).find('.b-flag__text').map((_, x) => $(x).text().trim().toLowerCase()).get(),
        methodRaw: (colP(7)[0] || '').trim(),
        round: parseInt((colP(8)[0] || '').trim(), 10) || null,
        time: (colP(9)[0] || '').trim() || null,
      };
    }).get().filter(r => r.fightId && r.fighters.length === 2);

    // index DB fights by ufc_id pair and by normalized-name pair (consume on match)
    const dbFights = (fightsByEvent[ev.id] || []).filter(needsStats);
    const matched = new Set();
    const findDbFight = row => {
      const [pa, pb] = row.fighters;
      const da = fighterByUfcId[pa.ufcId], db = fighterByUfcId[pb.ufcId];
      let hit = dbFights.find(f => !matched.has(f.id) && da && db &&
        ((f.fighter1_id === da.id && f.fighter2_id === db.id) || (f.fighter1_id === db.id && f.fighter2_id === da.id)));
      if (hit) return hit;
      const na = norm(pa.name), nb = norm(pb.name);
      hit = dbFights.find(f => {
        if (matched.has(f.id)) return false;
        const n1 = norm(fname(f.fighter1_id)), n2 = norm(fname(f.fighter2_id));
        return (n1 === na && n2 === nb) || (n1 === nb && n2 === na);
      });
      return hit || null;
    };

    for (const row of pageRows) {
      const dbf = findDbFight(row);
      if (!dbf) {
        evUnmatched++;
        log.unmatched.push(`${evLabel}: ${row.fighters[0].name} vs ${row.fighters[1].name} (${row.fightId})`);
        if (DRY) console.log(`    ! unmatched source row (no DB fight): ${row.fighters[0].name} vs ${row.fighters[1].name}`);
        continue;
      }
      matched.add(dbf.id);

      // ── result parsed from the event-page row (winner is listed first) ──
      const rowResult = resultFromFlags(row.flags);
      let winnerId = null;
      if (rowResult === 'win') {
        const w = row.fighters[0];
        winnerId = [dbf.fighter1_id, dbf.fighter2_id].find(id => fighterById[id]?.ufc_id && fighterById[id].ufc_id === w.ufcId)
                || [dbf.fighter1_id, dbf.fighter2_id].find(id => norm(fname(id)) === norm(w.name)) || null;
      }
      // Orientation A: on a win, fighter1_id must be the winner — swap when the
      // DB has the loser as fighter1. Only reorder when actually writing results,
      // so with the flag off the stats mapping is identical to before.
      const swap = WRITE_RESULTS && rowResult === 'win' && winnerId && winnerId !== dbf.fighter1_id;
      const desiredF1 = swap ? winnerId : dbf.fighter1_id;
      const desiredF2 = swap ? dbf.fighter1_id : dbf.fighter2_id;
      const resultFields = {};
      if (WRITE_RESULTS && rowResult) {
        if (swap) { resultFields.fighter1_id = desiredF1; resultFields.fighter2_id = desiredF2; }
        resultFields.result = rowResult;
        resultFields.winner_id = rowResult === 'win' ? winnerId : null;
        if (row.methodRaw) resultFields.method = mapMethod(row.methodRaw);
        if (row.round) resultFields.round = row.round;
        if (row.time) resultFields.time = row.time;
      }
      const label = `${fname(desiredF1)} vs ${fname(desiredF2)}`;
      const methodOut = mapMethod(row.methodRaw);
      const swapNote = swap ? '  [orientation-A SWAP: winner was DB fighter2]' : '';
      const methodKnown = /^(KO\/TKO|SUB|U-DEC|S-DEC|M-DEC|DEC|DQ|Overturned|CNC|Draw)$/.test(methodOut || '');
      const flagNote = (rowResult && rowResult !== 'win') ? `  [${rowResult.toUpperCase()} — no winner]`
                     : (rowResult === 'win' && !methodKnown) ? `  [unmapped method: "${row.methodRaw}"]` : '';
      const logPlanned = kind => {
        if (!(DRY && WRITE_RESULTS && rowResult)) return;
        const verdict = rowResult === 'win'
          ? `${fname(desiredF1)} def. ${fname(desiredF2)} by ${methodOut} R${row.round} ${row.time}`
          : `${label} — ${rowResult}`;
        console.log(`    · ${verdict}  (${kind})${swapNote}${flagNote}`);
      };

      await sleep(DELAY);
      let parsed;
      try { parsed = parseFightPage(await get(`${BASE}/fight-details/${row.fightId}`)); }
      catch (e) { evErrors++; log.errors.push(`${evLabel}: fight ${row.fightId} failed (${e.message})`); continue; }

      // No per-round stats posted: still write the result read off the event page.
      if (!parsed || !parsed.totals) {
        evNoStats++; totalNoStats++;
        progress.noStatsFights[dbf.id] = row.fightId;
        log.noStats.push(`${evLabel}: ${label}`);
        if (WRITE_RESULTS && rowResult) {
          if (!DRY) {
            const { error } = await supabase.from('fights').update(resultFields).eq('id', dbf.id);
            if (error) { evErrors++; log.errors.push(`${evLabel}: result-only update ${label} failed: ${error.message}`); continue; }
          }
          totalResults++;
          logPlanned('result-only, no stats');
          log.updated.push(`${evLabel}: ${label} — result-only ${rowResult}/${methodOut}/R${row.round} ${row.time}`);
        }
        continue;
      }

      // map page fighters onto the DESIRED fighter1 (= winner on wins)
      const wantF1 = fighterById[desiredF1];
      let idx1 = parsed.pageFighters.findIndex(p => wantF1?.ufc_id && p.ufcId === wantF1.ufc_id);
      if (idx1 === -1) idx1 = parsed.pageFighters.findIndex(p => norm(p.name) === norm(fname(desiredF1)));
      if (idx1 === -1) { evErrors++; log.errors.push(`${evLabel}: cannot map fighter1 for ${row.fightId}`); continue; }

      const payload = { ...buildPayload(parsed, idx1), ...resultFields };
      if (log.samplePayloads.length < 3) log.samplePayloads.push({ fight: label, event: evLabel, payload });

      if (!DRY) {
        const { error } = await supabase.from('fights').update(payload).eq('id', dbf.id);
        if (error) { evErrors++; log.errors.push(`${evLabel}: update ${label} failed: ${error.message}`); continue; }
      }
      evUpdated++; totalUpdated++;
      if (WRITE_RESULTS && rowResult) totalResults++;
      logPlanned('stats+result');
      log.updated.push(`${evLabel}: ${label} — ${payload.rounds_data.length} rounds${payload.judge1_score ? ', scorecards' : ''}${WRITE_RESULTS && rowResult ? `, ${rowResult}/${methodOut}` : ''}`);
    }

    if (!DRY && !evErrors && evUnmatched === 0) {
      progress.completedEvents[ev.ufc_id] = { name: ev.name, date: ev.date, updated: evUpdated, noStats: evNoStats, ts: new Date().toISOString() };
    }
    if (!DRY) saveProgress(progress);

    console.log(`  [${processed}/${targets.length}] ${evLabel}: +${evUpdated} stats, ${evNoStats} no-stats, ${evUnmatched} unmatched, ${evErrors} errors`);
  }

  console.log('\n================ SUMMARY ================');
  console.log(`Events processed: ${processed}`);
  console.log(`Fights ${DRY ? 'parsed (would update)' : 'updated'}: ${totalUpdated}`);
  console.log(`Results ${DRY ? 'parsed (would write)' : 'written'}: ${totalResults}${WRITE_RESULTS ? '' : '  (--write-results not set)'}`);
  console.log(`Fights with no stats on ufcstats: ${totalNoStats}`);
  console.log(`Unmatched page rows: ${log.unmatched.length}`);
  console.log(`Errors: ${log.errors.length}`);
  fs.writeFileSync(LOGFILE, JSON.stringify(log, null, 2));
  console.log(`\nDetails written to ${LOGFILE}`);
  if (!DRY) console.log(`Progress saved to ${PROGRESS_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
