/**
 * backfill-event.js — one-shot post-event backfill for a single UFC event,
 * targeted by ufcstats event id (never by name substring).
 *
 * Generalizes the manual sequence used for UFC Fight Night: Du Plessis vs.
 * Usman (2026-07-18), where the DB held a stale pre-imported booking:
 *   1. Event row: create it, or sync ufc_id/name (slug is NEVER changed on an
 *      existing row — EventPage resolves by slug via .single(); on create the
 *      slug is uniqueness-checked and the run aborts on collision).
 *   2. Diff the ufcstats card against DB fights: MATCHED / VARIANT (spelling,
 *      e.g. Tommy vs Thomas Petersen — one fighter exact + partner surname
 *      match) / STALE (cancelled or opponent replaced) / MISSING.
 *   3. DELETE stale rows. Guard: every stale row must have result NULL or
 *      'upcoming', no winner_id, no rounds_data — otherwise the whole run
 *      aborts before any write.
 *   4. CREATE missing fighter rows, gated by a near-match search (exact name,
 *      surname-only, initials-vs-full, first-name spelling lev<=2). An exact
 *      full-name hit ABORTS for manual review (namesakes are real: two Bruno
 *      Silvas). ufcstats "Record:" is the PRO record -> pro_*; UFC W/L stay 0.
 *   5. INSERT missing bouts as result='upcoming' (card_position null) and
 *      re-sequence bout_order of kept rows to the ufcstats page order (0 =
 *      main event). VARIANT-matched fighters get ufc_id backfilled when null
 *      so the results scraper can match them.
 *   6. Spawn ufcstats-fight-stats.js --write-results --ufc-id <id> (results,
 *      rounds_data, orientation-A swaps — winner becomes fighter1 atomically).
 *   7. Spawn fix-bout-order.js --event "<exact DB name>" for card_position,
 *      then report any row Wikipedia missed (manual follow-up).
 *   8. Set events.is_complete=true once every fight has a result.
 *
 * Deliberately NOT run here (defer until a batch of events is done):
 * fix-fighter-records.js, computeCareerStats.js, computeRatings.js,
 * validate.js, sherdog-pro-records.js.
 *
 * Flags:
 *   --ufc-id ID     (required) ufcstats event id, e.g. 681d07e328798ec0
 *   --apply         execute; default is dry-run (prints full plan, writes nothing)
 *   --title "0,3"   bout_order values (final card order) to flag is_title_fight
 *   --skip-results  stop after phase 5 (no results scraper, no bout-order fix)
 *   --delay MS      per-request delay for ufcstats fetches (default 1200)
 *
 * Run:  node -r dotenv/config src/scrapers/backfill-event.js --ufc-id <id>
 */
require('dotenv').config();
const { chromium } = require('playwright-core');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const supabase = require('../db/client');

const UFCID  = (() => { const i = process.argv.indexOf('--ufc-id'); return i > -1 ? process.argv[i + 1] : null; })();
const APPLY  = process.argv.includes('--apply');
const SKIP_RESULTS = process.argv.includes('--skip-results');
const DELAY  = (() => { const i = process.argv.indexOf('--delay'); return i > -1 ? parseInt(process.argv[i + 1]) : 1200; })();
const TITLE_BOS = (() => {
  const i = process.argv.indexOf('--title');
  return i > -1 ? process.argv[i + 1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n)) : [];
})();

if (!UFCID || !/^[0-9a-f]{16}$/.test(UFCID)) {
  console.error('Usage: backfill-event.js --ufc-id <16-hex ufcstats event id> [--apply]');
  process.exit(1);
}

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'http://ufcstats.com';
const BACKEND = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── name helpers ────────────────────────────────────────────────────────────
function norm(s) {
  return (s || '').toLowerCase().replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}
const slugify = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function lev(a, b) {
  const m = []; for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) for (let j = 1; j <= a.length; j++)
    m[i][j] = b[i - 1] === a[j - 1] ? m[i - 1][j - 1] : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
  return m[b.length][a.length];
}

// ── gated HTTP (same path as ufcstats-fight-stats.js) ───────────────────────
let cookieJar = '';
async function solveGate() {
  console.log('  [gate] solving proof-of-work challenge via headless Chrome...');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(BASE + '/statistics/events/completed', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/event-details/"]', { timeout: 30000 });
    cookieJar = (await ctx.cookies(BASE)).map(c => c.name + '=' + c.value).join('; ');
    console.log('  [gate] solved');
  } finally { await browser.close(); }
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

// ── source parsing ──────────────────────────────────────────────────────────
const MONTHS = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06', July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };
const isoDate = t => {
  const m = (t || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  return m ? `${m[3]}-${MONTHS[m[1]]}-${String(m[2]).padStart(2, '0')}` : null;
};

async function fetchListingEntry() {
  const $ = cheerio.load(await get(`${BASE}/statistics/events/completed?page=all`));
  let hit = null;
  $('tr.b-statistics__table-row').each((_, tr) => {
    const a = $(tr).find('a.b-link[href*="/event-details/"]').first();
    if (!a.length) return;
    const id = (a.attr('href') || '').split('/').pop();
    if (id !== UFCID) return;
    hit = {
      id,
      name: a.text().replace(/\s+/g, ' ').trim(),
      date: isoDate($(tr).find('span.b-statistics__date').first().text().replace(/\s+/g, ' ').trim()),
      location: $(tr).find('td').eq(1).text().replace(/\s+/g, ' ').trim(),
    };
  });
  return hit;
}

async function fetchSourceCard() {
  const $ = cheerio.load(await get(`${BASE}/event-details/${UFCID}`));
  return $('tr[data-link*="/fight-details/"]').map((_, tr) => {
    const cols = $(tr).find('td');
    const fids = $(tr).find('a[href*="/fighter-details/"]').map((_, a) => ({
      ufcId: ($(a).attr('href') || '').split('/').pop(),
      name: $(a).text().trim(),
    })).get();
    const colP = i => $(cols[i]).find('p').map((_, x) => $(x).text().replace(/\s+/g, ' ').trim()).get();
    return {
      fightId: ($(tr).attr('data-link') || '').split('/').pop(),
      fighters: fids.slice(0, 2),
      flags: $(cols[0]).find('.b-flag__text').map((_, x) => $(x).text().trim().toLowerCase()).get(),
      wc: (colP(6)[0] || '').trim(),
      methodRaw: (colP(7)[0] || '').trim(),
      round: parseInt((colP(8)[0] || '').trim(), 10) || null,
      time: (colP(9)[0] || '').trim() || null,
    };
  }).get().filter(r => r.fightId && r.fighters.length === 2);
}

function parseFighterPage(html) {
  const $ = cheerio.load(html);
  const recTxt = $('span.b-content__title-record').text().replace(/\s+/g, ' ').trim();
  const rec = (recTxt.match(/Record:\s*(\d+)-(\d+)-(\d+)(?:\s*\((\d+)\s*NC\))?/) || []);
  const nickname = $('p.b-content__Nickname').text().replace(/\s+/g, ' ').trim() || null;
  const info = {};
  $('li.b-list__box-list-item').each((_, li) => {
    const t = $(li).text().replace(/\s+/g, ' ').trim();
    const m = t.match(/^([^:]+):\s*(.*)$/);
    if (m) info[m[1].trim().toUpperCase()] = m[2].trim();
  });
  const hM = (info['HEIGHT'] || '').match(/(\d+)'\s*(\d+)/);
  const rM = (info['REACH'] || '').match(/(\d+)/);
  const wM = (info['WEIGHT'] || '').match(/(\d+)/);
  const dM = (info['DOB'] || '').match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  const MO = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return {
    nickname,
    height_inches: hM ? (+hM[1] * 12 + +hM[2]) : null,
    reach_inches: rM ? +rM[1] : null,
    weight_lbs: wM ? +wM[1] : null,
    stance: info['STANCE'] || null,
    date_of_birth: dM ? `${dM[3]}-${MO[dM[1].slice(0, 3)]}-${String(dM[2]).padStart(2, '0')}` : null,
    pro_w: rec[1] ? +rec[1] : null, pro_l: rec[2] ? +rec[2] : null,
    pro_d: rec[3] ? +rec[3] : null, pro_nc: rec[4] ? +rec[4] : 0,
    raw: { HEIGHT: info['HEIGHT'], REACH: info['REACH'], STANCE: info['STANCE'], DOB: info['DOB'], record: recTxt },
  };
}

// ── DB loading ──────────────────────────────────────────────────────────────
async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadAll(${table}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

// ── child script runner ─────────────────────────────────────────────────────
function runChild(label, args) {
  console.log(`\n  >> node -r dotenv/config ${args.join(' ')}`);
  const res = spawnSync('node', ['-r', 'dotenv/config', ...args], { cwd: BACKEND, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`  *** ${label} exited ${res.status} — stopping here; later phases not run.`);
    process.exit(1);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`backfill-event ${APPLY ? '*** APPLY ***' : '*** DRY RUN — plan only, nothing written ***'}`);
  console.log(`target ufcstats id: ${UFCID}\n`);

  await solveGate();
  const src = await fetchListingEntry();
  if (!src) { console.error(`ABORT: ${UFCID} not found in the ufcstats completed-events listing.`); process.exit(1); }
  console.log(`SOURCE EVENT: "${src.name}"  ${src.date}  [${src.location}]`);

  await sleep(DELAY);
  const card = await fetchSourceCard();
  console.log(`SOURCE CARD : ${card.length} bouts\n`);
  if (!card.length) { console.error('ABORT: event page has no fight rows.'); process.exit(1); }

  const events = await loadAll('events', 'id, ufc_id, name, slug, date, is_complete');
  const fighters = await loadAll('fighters', 'id, ufc_id, first_name, last_name, nickname, slug, wins, losses, draws, no_contests, career_wins, career_losses, pro_wins, pro_losses, status, date_of_birth');
  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcByNorm = {}; (wcs || []).forEach(w => { wcByNorm[norm(w.name)] = w; });
  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const fighterByUfcId = {}; fighters.forEach(f => { if (f.ufc_id) fighterByUfcId[f.ufc_id] = f; });
  const fname = id => { const f = fighterById[id]; return f ? `${f.first_name} ${f.last_name}` : String(id); };

  // ── phase 1: event row ────────────────────────────────────────────────────
  console.log('━━━━ PHASE 1 — EVENT ROW ━━━━');
  let eventRow = events.find(e => e.ufc_id === UFCID) || null;
  let eventByDate = null;
  if (!eventRow) {
    const sameDate = events.filter(e => e.date === src.date);
    if (sameDate.length > 1) {
      console.error(`ABORT: no event has ufc_id ${UFCID}, and ${sameDate.length} events share date ${src.date} — resolve by hand.`);
      sameDate.forEach(e => console.error(`   ${e.id}  ${e.name}  ufc_id=${e.ufc_id}`));
      process.exit(1);
    }
    eventByDate = sameDate[0] || null;
  }
  const eventPlan = { updates: {}, create: null };
  if (eventRow) {
    console.log(`  found by ufc_id: ${eventRow.id}  "${eventRow.name}"  slug=${eventRow.slug}  (${eventRow.date})`);
    if (eventRow.name !== src.name) { eventPlan.updates.name = src.name; console.log(`  name differs -> UPDATE name to "${src.name}" (display-only; slug untouched)`); }
  } else if (eventByDate) {
    eventRow = eventByDate;
    console.log(`  found by date: ${eventRow.id}  "${eventRow.name}"  ufc_id=${eventRow.ufc_id}`);
    if (eventRow.ufc_id && eventRow.ufc_id !== UFCID) {
      console.error(`ABORT: date-matched event carries a DIFFERENT ufc_id (${eventRow.ufc_id}) — resolve by hand.`);
      process.exit(1);
    }
    eventPlan.updates.ufc_id = UFCID;
    console.log(`  -> UPDATE ufc_id to ${UFCID}`);
    if (eventRow.name !== src.name) { eventPlan.updates.name = src.name; console.log(`  name differs -> UPDATE name to "${src.name}" (slug untouched)`); }
  } else {
    const [city, state, country] = src.location.split(',').map(s => s.trim());
    const slug = slugify(src.name);
    const holder = events.find(e => e.slug === slug);
    if (holder) {
      console.error(`ABORT: proposed slug "${slug}" already held by ${holder.id} (${holder.name}) — resolve by hand.`);
      process.exit(1);
    }
    eventPlan.create = {
      id: crypto.randomUUID(), promotion_id: null, ufc_id: UFCID, name: src.name, slug,
      event_number: null, event_type: 'numbered', date: src.date, venue: null,
      city: city || null, state: state || null, country: country || null,
      attendance: null, ppv_buys: null, is_complete: false, main_event: null,
    };
    console.log(`  no event row -> CREATE ${eventPlan.create.id}  slug=${slug} (verified unique)  ${src.date}  ${src.location}`);
  }
  const EVENT_DB_ID = eventRow ? eventRow.id : eventPlan.create.id;

  // ── phase 2: diff ─────────────────────────────────────────────────────────
  console.log('\n━━━━ PHASE 2 — CARD DIFF ━━━━');
  const { data: dbFights } = eventRow
    ? await supabase.from('fights')
        .select('id, fighter1_id, fighter2_id, result, winner_id, method, round, time, bout_order, card_position, rounds_data, is_title_fight, judge1_score, judge2_score, judge3_score')
        .eq('event_id', EVENT_DB_ID).order('bout_order')
    : { data: [] };
  console.log(`  DB fights on event: ${dbFights.length}`);

  // score a source fighter against a DB fighter id
  const scoreFighter = (srcF, dbId) => {
    const dbF = fighterById[dbId];
    if (!dbF) return 0;
    if (dbF.ufc_id && dbF.ufc_id === srcF.ufcId) return 2;
    const sN = norm(srcF.name), dN = norm(`${dbF.first_name} ${dbF.last_name}`);
    if (sN === dN) return 2;
    const [sFirst, sLast] = [norm(srcF.name.split(' ')[0]), norm(srcF.name.split(' ').slice(1).join(' '))];
    const dFirst = norm(dbF.first_name || ''), dLast = norm(dbF.last_name || '');
    if (sLast && sLast === dLast) {
      if (lev(sFirst, dFirst) <= 2) return 1;                       // Tommy/Thomas, Damien/Damian
      if ((sFirst.length <= 3 || dFirst.length <= 3) && sFirst[0] === dFirst[0]) return 1; // RJ vs Robert
    }
    return 0;
  };

  const matchedDb = new Set();
  const pairing = []; // { row, pageIdx, dbf, kind }
  // pass 1: exact pairs (both fighters score 2)
  for (let i = 0; i < card.length; i++) {
    const row = card[i];
    const hit = dbFights.find(f => !matchedDb.has(f.id) &&
      ((scoreFighter(row.fighters[0], f.fighter1_id) === 2 && scoreFighter(row.fighters[1], f.fighter2_id) === 2) ||
       (scoreFighter(row.fighters[0], f.fighter2_id) === 2 && scoreFighter(row.fighters[1], f.fighter1_id) === 2)));
    if (hit) { matchedDb.add(hit.id); pairing.push({ row, pageIdx: i, dbf: hit, kind: 'MATCHED' }); }
    else pairing.push({ row, pageIdx: i, dbf: null, kind: null });
  }
  // pass 2: variant pairs (one exact + partner surname/spelling >= 1; total >= 3)
  for (const p of pairing.filter(x => !x.dbf)) {
    const row = p.row;
    let best = null;
    for (const f of dbFights) {
      if (matchedDb.has(f.id)) continue;
      const s1 = scoreFighter(row.fighters[0], f.fighter1_id) + scoreFighter(row.fighters[1], f.fighter2_id);
      const s2 = scoreFighter(row.fighters[0], f.fighter2_id) + scoreFighter(row.fighters[1], f.fighter1_id);
      const s = Math.max(s1, s2);
      const hasExact = [f.fighter1_id, f.fighter2_id].some(id =>
        scoreFighter(row.fighters[0], id) === 2 || scoreFighter(row.fighters[1], id) === 2);
      if (s >= 3 && hasExact && (!best || s > best.s)) best = { f, s };
    }
    if (best) { matchedDb.add(best.f.id); p.dbf = best.f; p.kind = 'VARIANT'; }
  }
  for (const p of pairing) if (!p.dbf) p.kind = 'MISSING';
  const stale = dbFights.filter(f => !matchedDb.has(f.id));

  console.log('\n  page | kind    | source bout');
  for (const p of pairing) {
    const extra = p.dbf ? `  -> DB ${p.dbf.id.slice(0, 8)} (${fname(p.dbf.fighter1_id)} vs ${fname(p.dbf.fighter2_id)}, bo=${p.dbf.bout_order})` : '';
    console.log(`   ${String(p.pageIdx).padStart(2)}  | ${p.kind.padEnd(7)} | ${p.row.fighters[0].name} vs ${p.row.fighters[1].name}${extra}`);
  }
  console.log(`\n  STALE DB rows (${stale.length}):`);
  for (const f of stale) {
    const reasons = [];
    for (const [id, otherId] of [[f.fighter1_id, f.fighter2_id], [f.fighter2_id, f.fighter1_id]]) {
      const onCard = card.find(r => r.fighters.some(sf => scoreFighter(sf, id) === 2));
      if (onCard) {
        const real = onCard.fighters.find(sf => scoreFighter(sf, id) !== 2);
        reasons.push(`${fname(id)} IS on the card vs ${real.name} (replaced ${fname(otherId)})`);
      }
    }
    console.log(`    ${f.id.slice(0, 8)}  bo=${f.bout_order}  ${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)}  [${reasons.length ? reasons.join('; ') : 'neither fighter on card — cancelled'}]`);
  }
  console.log(`\n  summary: matched=${pairing.filter(p => p.kind === 'MATCHED').length}  variant=${pairing.filter(p => p.kind === 'VARIANT').length}  missing=${pairing.filter(p => p.kind === 'MISSING').length}  stale=${stale.length}`);

  // ── phase 3 plan: delete guard ────────────────────────────────────────────
  console.log('\n━━━━ PHASE 3 — STALE DELETES ━━━━');
  let deleteBlocked = false;
  for (const f of stale) {
    const bad = [];
    if (f.result && f.result !== 'upcoming') bad.push(`result="${f.result}"`);
    if (f.winner_id) bad.push('winner_id set');
    if (f.rounds_data) bad.push('rounds_data set');
    console.log(`  DELETE ${f.id}  ${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)}  result=${JSON.stringify(f.result)} winner=${JSON.stringify(f.winner_id)}  ${bad.length ? '*** HAS REAL DATA: ' + bad.join(', ') + ' ***' : 'safe'}`);
    if (bad.length) deleteBlocked = true;
  }
  if (!stale.length) console.log('  none');
  if (deleteBlocked) { console.error('\nABORT: a stale row carries real result data — nothing written.'); process.exit(1); }

  // ── phase 4 plan: fighter resolution / creation ───────────────────────────
  console.log('\n━━━━ PHASE 4 — FIGHTER RESOLUTION ━━━━');
  const resolvedId = {};       // source name -> db fighter id
  const ufcIdBackfill = [];    // { dbId, ufcId } for variant matches with null ufc_id
  const toCreate = [];         // source fighter objects needing new rows
  let createBlocked = false;

  for (const p of pairing) {
    for (const sf of p.row.fighters) {
      if (resolvedId[sf.name] !== undefined) continue;
      // direct identity
      const byId = fighterByUfcId[sf.ufcId];
      if (byId) { resolvedId[sf.name] = byId.id; continue; }
      const exact = fighters.find(f => norm(`${f.first_name} ${f.last_name}`) === norm(sf.name));
      if (exact && !exact.ufc_id) {
        resolvedId[sf.name] = exact.id;
        ufcIdBackfill.push({ dbId: exact.id, ufcId: sf.ufcId, name: sf.name });
        console.log(`  ${sf.name.padEnd(26)} -> existing ${exact.id.slice(0, 8)} (exact name, ufc_id null -> backfill ${sf.ufcId})`);
        continue;
      }
      if (exact && exact.ufc_id && exact.ufc_id !== sf.ufcId) {
        console.log(`  ${sf.name.padEnd(26)} *** exact-name row ${exact.id.slice(0, 8)} carries DIFFERENT ufc_id ${exact.ufc_id} — namesake or bad id. STOP for manual review. ***`);
        createBlocked = true; continue;
      }
      // variant within a matched pair: adopt the DB fighter from that pair
      if (p.dbf) {
        const cand = [p.dbf.fighter1_id, p.dbf.fighter2_id]
          .filter(id => !Object.values(resolvedId).includes(id))
          .map(id => ({ id, s: scoreFighter(sf, id) }))
          .filter(x => x.s >= 1).sort((a, b) => b.s - a.s)[0];
        if (cand) {
          resolvedId[sf.name] = cand.id;
          const dbF = fighterById[cand.id];
          console.log(`  ${sf.name.padEnd(26)} -> existing ${cand.id.slice(0, 8)} "${dbF.first_name} ${dbF.last_name}" (VARIANT spelling${dbF.ufc_id ? '' : `; ufc_id null -> backfill ${sf.ufcId}`})`);
          if (!dbF.ufc_id) ufcIdBackfill.push({ dbId: cand.id, ufcId: sf.ufcId, name: sf.name });
          else if (dbF.ufc_id !== sf.ufcId) { console.log(`     *** variant row has DIFFERENT ufc_id ${dbF.ufc_id} — STOP for manual review ***`); createBlocked = true; }
          continue;
        }
      }
      // genuinely unresolved -> near-match report, then create
      const [first, ...rest] = sf.name.split(' ');
      const nLast = norm(rest.join(' ')), nFirst = norm(first);
      const near = fighters.filter(f => {
        const dLast = norm(f.last_name || ''), dFirst = norm(f.first_name || '');
        return dLast === nLast && (dFirst[0] === nFirst[0] || lev(dFirst, nFirst) <= 2 ||
          nFirst.length <= 3 || dFirst.length <= 3 || true); // surname-only included
      });
      console.log(`  ${sf.name.padEnd(26)} -> CREATE (ufcstats ${sf.ufcId}); near-matches (${near.length}):`);
      near.slice(0, 8).forEach(f => console.log(`       ${f.id.slice(0, 8)}  ${f.first_name} ${f.last_name}  UFC ${f.wins}-${f.losses}-${f.draws}  pro ${f.pro_wins}-${f.pro_losses}  ufc_id=${f.ufc_id}`));
      if (near.length > 8) console.log(`       ... ${near.length - 8} more (surname-only)`);
      toCreate.push(sf);
      resolvedId[sf.name] = null; // placeholder, filled on apply
    }
  }
  if (createBlocked) { console.error('\nABORT: fighter identity conflict above — nothing written.'); process.exit(1); }

  // slug collision check for creations
  for (const sf of toCreate) {
    const slug = slugify(sf.name);
    const holder = fighters.find(f => f.slug === slug);
    if (holder) {
      console.error(`ABORT: fighter slug "${slug}" already held by ${holder.id} (${holder.first_name} ${holder.last_name}) — resolve by hand.`);
      process.exit(1);
    }
  }

  // ── phase 5 plan: inserts + reorder ───────────────────────────────────────
  console.log('\n━━━━ PHASE 5 — BOUT INSERTS + REORDER ━━━━');
  const reorders = pairing.filter(p => p.dbf && p.dbf.bout_order !== p.pageIdx)
    .map(p => ({ id: p.dbf.id, from: p.dbf.bout_order, to: p.pageIdx, label: `${p.row.fighters[0].name} vs ${p.row.fighters[1].name}` }));
  const inserts = pairing.filter(p => !p.dbf);
  console.log(`  reorders (${reorders.length}):`);
  reorders.forEach(r => console.log(`    ${r.id.slice(0, 8)}  bo ${r.from} -> ${r.to}  ${r.label}`));
  console.log(`  inserts (${inserts.length}):`);
  inserts.forEach(p => {
    const wc = wcByNorm[norm(p.row.wc)];
    const title = TITLE_BOS.includes(p.pageIdx);
    console.log(`    bo=${String(p.pageIdx).padStart(2)}  ${p.row.fighters[0].name} vs ${p.row.fighters[1].name}  wc=${wc ? wc.id : 'NULL (' + p.row.wc + ')'}  is_title_fight=${title}  result=upcoming`);
  });
  const titleUpdates = pairing.filter(p => p.dbf && TITLE_BOS.includes(p.pageIdx) && !p.dbf.is_title_fight);
  if (titleUpdates.length) {
    console.log(`  title-flag updates on kept rows (${titleUpdates.length}):`);
    titleUpdates.forEach(p => console.log(`    ${p.dbf.id.slice(0, 8)}  bo=${p.pageIdx}  is_title_fight -> true`));
  }
  if (TITLE_BOS.length) console.log(`  --title bout_orders: ${TITLE_BOS.join(', ')}`);
  const finalCount = dbFights.length - stale.length + inserts.length;
  console.log(`  final card: ${dbFights.length} - ${stale.length} + ${inserts.length} = ${finalCount} rows, bout_order 0..${card.length - 1}${finalCount !== card.length ? '  *** MISMATCH vs source ' + card.length + ' ***' : ''}`);

  // ── phases 6-8 preview ────────────────────────────────────────────────────
  console.log('\n━━━━ PHASES 6-8 — RESULTS / CARD POSITION / COMPLETE ━━━━');
  const eventNameFinal = eventPlan.create ? eventPlan.create.name : (eventPlan.updates.name || eventRow.name);
  console.log(`  6. ufcstats-fight-stats.js --write-results --ufc-id ${UFCID}`);
  console.log(`  7. fix-bout-order.js --event "${eventNameFinal}"  (then report any null card_position)`);
  console.log(`  8. events.is_complete -> true once all ${card.length} fights carry results`);
  if (SKIP_RESULTS) console.log('  (--skip-results: phases 6-8 will NOT run)');

  if (!APPLY) {
    console.log('\n━━━━ DRY RUN VERIFICATION CHECKLIST ━━━━');
    console.log(`  [ ] source event/date correct: "${src.name}" ${src.date}`);
    console.log(`  [ ] every STALE row is genuinely cancelled/replaced (cross-check reasons above)`);
    console.log(`  [ ] every VARIANT match is the same person, not a namesake`);
    console.log(`  [ ] every CREATE has no plausible near-match in its printed list`);
    console.log(`  [ ] title bouts flagged (--title) match the real card`);
    console.log(`  [ ] final count ${finalCount} === source ${card.length}`);
    console.log('\nDry run complete — nothing written. Re-run with --apply to execute.');
    return;
  }

  // ═══ APPLY ═══════════════════════════════════════════════════════════════
  console.log('\n━━━━ APPLYING ━━━━');

  // 1. event row
  if (eventPlan.create) {
    const { error } = await supabase.from('events').insert(eventPlan.create);
    console.log(`  [1] insert event ${eventPlan.create.id}: ${error ? 'ERROR ' + error.message : 'ok'}`);
    if (error) process.exit(1);
  } else if (Object.keys(eventPlan.updates).length) {
    const { error } = await supabase.from('events').update(eventPlan.updates).eq('id', EVENT_DB_ID);
    console.log(`  [1] update event (${Object.keys(eventPlan.updates).join(', ')}): ${error ? 'ERROR ' + error.message : 'ok'}`);
    if (error) process.exit(1);
  } else console.log('  [1] event row: no changes needed');

  // 3. deletes (re-guarded row by row)
  for (const f of stale) {
    const { data: pre } = await supabase.from('fights').select('result, winner_id, rounds_data').eq('id', f.id).single();
    if (pre && ((pre.result && pre.result !== 'upcoming') || pre.winner_id || pre.rounds_data)) {
      console.error(`  *** ${f.id} now carries real data — ABORT ***`); process.exit(1);
    }
    const { error } = await supabase.from('fights').delete().eq('id', f.id);
    console.log(`  [3] delete ${f.id.slice(0, 8)}: ${error ? 'ERROR ' + error.message : 'ok'}`);
    if (error) process.exit(1);
  }

  // 4. fighter creates + ufc_id backfills
  for (const b of ufcIdBackfill) {
    const { error } = await supabase.from('fighters').update({ ufc_id: b.ufcId }).eq('id', b.dbId).is('ufc_id', null);
    console.log(`  [4] backfill ufc_id ${b.ufcId} onto ${b.dbId.slice(0, 8)} (${b.name}): ${error ? 'ERROR ' + error.message : 'ok'}`);
  }
  for (const sf of toCreate) {
    await sleep(DELAY);
    const pg = parseFighterPage(await get(`${BASE}/fighter-details/${sf.ufcId}`));
    const bout = card.find(r => r.fighters.some(f => f.name === sf.name));
    const wc = wcByNorm[norm(bout.wc)] || null;
    const [first, ...rest] = sf.name.split(' ');
    const id = crypto.randomUUID();
    const row = {
      id, ufc_id: sf.ufcId, first_name: first, last_name: rest.join(' '),
      nickname: pg.nickname || null, slug: slugify(sf.name),
      primary_weight_class_id: wc ? wc.id : null, status: 'active',
      is_champion: false, is_interim_champ: false,
      height_inches: pg.height_inches, reach_inches: pg.reach_inches,
      stance: pg.stance || null, weight_lbs: pg.weight_lbs,
      wins: 0, losses: 0, draws: 0, no_contests: 0,
      wins_ko: 0, wins_sub: 0, wins_dec: 0, losses_ko: 0, losses_sub: 0, losses_dec: 0,
      career_wins: 0, career_losses: 0, career_draws: 0, career_no_contests: 0,
      pro_wins: pg.pro_w, pro_losses: pg.pro_l, pro_draws: pg.pro_d, pro_nc: pg.pro_nc,
      date_of_birth: pg.date_of_birth,
    };
    const { error } = await supabase.from('fighters').insert(row);
    console.log(`  [4] create ${sf.name} -> ${id}  pro ${pg.pro_w}-${pg.pro_l}-${pg.pro_d}: ${error ? 'ERROR ' + error.message : 'ok'}`);
    if (error) process.exit(1);
    resolvedId[sf.name] = id;
    fighterById[id] = { id, first_name: row.first_name, last_name: row.last_name }; // keep fname() current for final verification
  }

  // 5. reorders, inserts, title flags
  for (const r of reorders) {
    const { error } = await supabase.from('fights').update({ bout_order: r.to }).eq('id', r.id);
    console.log(`  [5] reorder ${r.id.slice(0, 8)} bo ${r.from} -> ${r.to}: ${error ? 'ERROR ' + error.message : 'ok'}`);
  }
  for (const p of inserts) {
    const wc = wcByNorm[norm(p.row.wc)] || null;
    const f1 = resolvedId[p.row.fighters[0].name], f2 = resolvedId[p.row.fighters[1].name];
    if (!f1 || !f2) { console.error(`  *** cannot resolve ${p.row.fighters[0].name} / ${p.row.fighters[1].name} — ABORT ***`); process.exit(1); }
    const row = {
      id: crypto.randomUUID(), event_id: EVENT_DB_ID, fighter1_id: f1, fighter2_id: f2,
      winner_id: null, card_position: null, bout_order: p.pageIdx,
      weight_class_id: wc ? wc.id : null,
      is_title_fight: TITLE_BOS.includes(p.pageIdx), is_interim_title: false,
      result: 'upcoming', method: null, round: null, time: null,
    };
    const { error } = await supabase.from('fights').insert(row);
    console.log(`  [5] insert bo=${p.pageIdx} ${p.row.fighters[0].name} vs ${p.row.fighters[1].name}: ${error ? 'ERROR ' + error.message : 'ok'}`);
    if (error) process.exit(1);
  }
  for (const p of titleUpdates) {
    const { error } = await supabase.from('fights').update({ is_title_fight: true }).eq('id', p.dbf.id);
    console.log(`  [5] title flag bo=${p.pageIdx}: ${error ? 'ERROR ' + error.message : 'ok'}`);
  }

  if (SKIP_RESULTS) { console.log('\n--skip-results set — stopping after phase 5.'); return; }

  // 6-7. child scripts
  runChild('results scraper', ['src/scrapers/ufcstats-fight-stats.js', '--write-results', '--ufc-id', UFCID]);
  runChild('fix-bout-order', ['src/scrapers/fix-bout-order.js', '--event', eventNameFinal]);

  // 8. is_complete + final verification
  console.log('\n━━━━ FINAL VERIFICATION ━━━━');
  const { data: finalFights } = await supabase.from('fights')
    .select('bout_order, card_position, fighter1_id, fighter2_id, winner_id, result, method, round, time, rounds_data, is_title_fight')
    .eq('event_id', EVENT_DB_ID).order('bout_order');
  finalFights.forEach(f => console.log(
    `  ${String(f.bout_order).padStart(2)} | ${String(f.card_position).padEnd(12)} | ${(fname(f.fighter1_id) + ' vs ' + fname(f.fighter2_id)).padEnd(44)} | ${f.result}/${f.method} R${f.round} ${f.time} | ${f.rounds_data ? f.rounds_data.length + 'r' : 'no-stats'}${f.is_title_fight ? ' | TITLE' : ''}`));
  const unresolved = finalFights.filter(f => !f.result || f.result === 'upcoming');
  const nullPos = finalFights.filter(f => !f.card_position);
  const badOrient = finalFights.filter(f => f.result === 'win' && f.winner_id !== f.fighter1_id);
  console.log(`\n  rows: ${finalFights.length} (source ${card.length})${finalFights.length === card.length ? '' : '  *** MISMATCH ***'}`);
  console.log(`  without result: ${unresolved.length}${unresolved.length ? '  *** ' + unresolved.map(f => 'bo' + f.bout_order).join(',') + ' ***' : ''}`);
  console.log(`  orientation-A violations: ${badOrient.length}${badOrient.length ? '  *** ' + badOrient.map(f => 'bo' + f.bout_order).join(',') + ' ***' : ''}`);
  console.log(`  null card_position: ${nullPos.length}${nullPos.length ? '  -> MANUAL: ' + nullPos.map(f => `bo${f.bout_order} (${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)})`).join(', ') : ''}`);
  if (!unresolved.length && finalFights.length === card.length) {
    const { error } = await supabase.from('events').update({ is_complete: true }).eq('id', EVENT_DB_ID);
    console.log(`  [8] is_complete -> true: ${error ? 'ERROR ' + error.message : 'ok'}`);
  } else {
    console.log('  [8] is_complete NOT set — unresolved fights or count mismatch above.');
  }
  console.log('\nDeferred (run once after the batch): fix-fighter-records.js, computeCareerStats.js, computeRatings.js, validate.js.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
