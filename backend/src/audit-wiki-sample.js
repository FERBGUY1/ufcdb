/**
 * audit-wiki-sample.js — Verify a random sample of events against Wikipedia (REPORT ONLY)
 *
 * Samples N events per era (1993-1999, 2000-2009, 2010-2015, 2016-2021, 2022+),
 * fetches each event's Wikipedia page, and compares per fight:
 *   - winner          (wiki "def." row first name vs DB winner/fighter1)
 *   - method category (ko / sub / dec / dq / nc-draw)
 *   - round, time
 *   - title fight flag (weight class cell contains "Championship" / "Interim")
 *   - card section    (Main card / Preliminary card / Early prelims)
 *   - bout order      (wiki row order vs DB bout_order ranking)
 *   - missing fights  (on wiki but not in DB) / extra fights (in DB but not on wiki)
 *
 * Usage: node -r dotenv/config src/audit-wiki-sample.js [--per-era N] [--seed N]
 * Writes JSON findings to audit-wiki-findings.json and prints a summary.
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const supabase = require('./db/client');

const PER_ERA = (() => { const i = process.argv.indexOf('--per-era'); return i > -1 ? parseInt(process.argv[i + 1]) : 10; })();
const SEED = (() => { const i = process.argv.indexOf('--seed'); return i > -1 ? parseInt(process.argv[i + 1]) : 20260612; })();
const DELAY = 1200;
const TODAY = new Date().toISOString().split('T')[0];
const WIKI_BASE = 'https://en.wikipedia.org';

const http = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Seeded PRNG (mulberry32) so the sample is reproducible
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Lenient person-name comparison: exact normalized, same token set (reversed
// order), containment (hyphenated rename), or same last name token.
function namesMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = a.trim().split(/\s+/).map(norm).sort().join('-');
  const tb = b.trim().split(/\s+/).map(norm).sort().join('-');
  if (ta === tb) return true;
  const la = norm(a.trim().split(/\s+/).pop()), lb = norm(b.trim().split(/\s+/).pop());
  return la === lb;
}

function headlinerKey(name) {
  const colon = name.indexOf(':');
  const hl = colon >= 0 ? name.slice(colon + 1) : name;
  const parts = hl.split(/\s+vs\.?\s+/i).map(p => norm(p));
  return parts.sort().join(':');
}

// Collapse a method string (DB or wiki) to a coarse category for comparison
function methodCategory(raw) {
  if (!raw) return null;
  const up = raw.toUpperCase();
  if (up.includes('KO') || up.includes('KNOCKOUT') || up === 'TKO') return 'ko';
  if (up.includes('SUB')) return 'sub';
  if (up.includes('DEC')) return 'dec';
  if (up.includes('DISQUALIF') || up === 'DQ') return 'dq';
  if (up.includes('NO CONTEST') || up === 'NC' || up === 'CNC' || up.includes('OVERTURN') || up.includes('CANNOT')) return 'nc';
  if (up.includes('DRAW')) return 'draw';
  return 'other:' + raw;
}

// Decision granularity (U/S/M) when both sides have it
function decisionType(raw) {
  if (!raw) return null;
  const up = raw.toUpperCase();
  if (up.includes('UNANIMOUS') || up === 'U-DEC') return 'U';
  if (up.includes('SPLIT') || up === 'S-DEC') return 'S';
  if (up.includes('MAJORITY') || up === 'M-DEC') return 'M';
  return null;
}

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

async function fetchWikiEventList() {
  const { data } = await http.get(WIKI_BASE + '/wiki/List_of_UFC_events');
  const $ = cheerio.load(data);
  const events = [];
  const seen = new Set();
  $('table.toccolours, table.wikitable').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      let wikiPath = null, eventName = null;
      for (let i = 0; i < Math.min(4, cells.length); i++) {
        // Wikipedia serves protocol-relative hrefs (//en.wikipedia.org/wiki/...) since mid-2026
        const a = $(cells[i]).find('a[href^="/wiki/"], a[href*="//en.wikipedia.org/wiki/"]').first();
        if (!a.length) continue;
        const href = (a.attr('href') || '').replace(/^(?:https?:)?\/\/en\.wikipedia\.org/, '');
        if (href === '/wiki/UFC') return;
        if (/List_of|Category:|Template:|Help:|Wikipedia:/i.test(href)) continue;
        if (!/\/wiki\/(UFC|WEC_|The_Ultimate_Fighter|Strikeforce|PRIDE)/i.test(href)) continue;
        wikiPath = href;
        eventName = a.text().trim();
        break;
      }
      if (!wikiPath || seen.has(wikiPath)) return;
      let dateStr = null;
      cells.each((_, cell) => {
        const txt = $(cell).text().trim();
        const m = txt.match(/(\w+ \d{1,2},? \d{4})/);
        if (m) { const d = new Date(m[1]); if (!isNaN(d)) dateStr = d.toISOString().split('T')[0]; }
      });
      if (dateStr) { seen.add(wikiPath); events.push({ name: eventName, date: dateStr, wikiUrl: WIKI_BASE + wikiPath }); }
    });
  });
  return events;
}

function isFightCard($, table) {
  const ths = $(table).find('th').map((_, th) => $(th).text().toLowerCase().trim()).get();
  const h = ths.join('|');
  if (/title fights in \d{4}/i.test(ths[0] || '')) return false;
  if (/current (?:ufc )?champions/i.test(ths[0] || '')) return false;
  return (h.includes('weight') || h.includes('class')) &&
         (h.includes('method') || (h.includes('round') && h.includes('time')));
}

function sectionFromHeader(txt) {
  const t = txt.toLowerCase();
  if (/early\s+prelim/.test(t)) return 'early_prelim';
  if (/prelim/.test(t)) return 'prelim';
  if (/main\s+card/.test(t)) return 'main_card';
  return null;
}

// Parse all fight rows from an event page, in card order (main event first)
async function fetchWikiCard(wikiUrl) {
  await sleep(DELAY);
  const { data } = await http.get(wikiUrl);
  const $ = cheerio.load(data);
  const rows = [];
  let section = null;

  $('table.toccolours, table.wikitable').each((_, table) => {
    if (!isFightCard($, table)) return;
    $(table).find('tr').each((_, row) => {
      const $row = $(row);
      // section header rows (th colspan: "Main card", "Preliminary card (ESPN+)" ...)
      const thOnly = $row.find('th');
      if (thOnly.length && $row.find('td').length === 0) {
        const sec = sectionFromHeader(thOnly.first().text());
        if (sec) section = sec;
        return;
      }
      const cells = $row.find('td');
      if (cells.length < 6) return;

      let sepIdx = -1, sep = null;
      cells.each((ci, cell) => {
        const t = $(cell).text().trim().toLowerCase().replace(/\[\w+\]/g, '');
        if (sepIdx === -1 && (t === 'def.' || t === 'drew' || t === 'vs.' || t === 'def')) { sepIdx = ci; sep = t.replace(/\.$/, ''); }
      });
      if (sepIdx < 1) return;

      const clean = el => $(el).text().replace(/\((?:i?c)\)/gi, '').replace(/\[\w+\]/g, '').trim();
      const wcText = sepIdx >= 2 ? $(cells[0]).text().replace(/\[\w+\]/g, '').trim() : '';
      const f1raw = $(cells[sepIdx - 1]).text();
      const f2raw = $(cells[sepIdx + 1]).text();
      const f1 = clean(cells[sepIdx - 1]);
      const f2 = clean(cells[sepIdx + 1]);
      if (!f1 || !f2) return;
      const methodRaw = cells.length > sepIdx + 2 ? clean(cells[sepIdx + 2]) : '';
      const roundRaw = cells.length > sepIdx + 3 ? clean(cells[sepIdx + 3]) : '';
      const timeRaw = cells.length > sepIdx + 4 ? clean(cells[sepIdx + 4]) : '';

      // Title fights: "Championship" in the weight-class cell (older pages) or a
      // "(c)" / "(ic)" champion marker beside a fighter name (modern pages).
      const champMarker = /\(c\)/i.test(f1raw + f2raw);
      const interimMarker = /\(ic\)/i.test(f1raw + f2raw);
      rows.push({
        section,
        f1, f2, sep,
        weightClass: wcText,
        isTitle: /championship/i.test(wcText) || champMarker || interimMarker,
        isInterim: /interim/i.test(wcText) || interimMarker,
        method: methodRaw,
        round: parseInt(roundRaw) || null,
        time: (timeRaw.match(/\d+:\d{2}/) || [null])[0],
      });
    });
  });
  return rows;
}

async function main() {
  console.log('UFCDB — Wikipedia sample audit');
  console.log(`  per-era sample: ${PER_ERA}, seed: ${SEED}\n`);

  const events = await loadAll('events', 'id, name, slug, date, is_complete');
  const fighters = await loadAll('fighters', 'id, first_name, last_name');
  const fights = await loadAll('fights',
    'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, bout_order, card_position, is_title_fight, is_interim_title');

  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const fname = id => { const f = fighterById[id]; return f ? `${f.first_name} ${f.last_name}` : `<missing>`; };
  const fightsByEvent = {};
  fights.forEach(f => { (fightsByEvent[f.event_id] = fightsByEvent[f.event_id] || []).push(f); });

  // Stratified sample of past events that have fights
  const eras = {
    '1993-1999': e => e.date < '2000-01-01',
    '2000-2009': e => e.date >= '2000-01-01' && e.date < '2010-01-01',
    '2010-2015': e => e.date >= '2010-01-01' && e.date < '2016-01-01',
    '2016-2021': e => e.date >= '2016-01-01' && e.date < '2022-01-01',
    '2022+':     e => e.date >= '2022-01-01' && e.date < TODAY,
  };
  const rand = mulberry32(SEED);
  const sample = [];
  for (const [era, pred] of Object.entries(eras)) {
    const pool = events.filter(e => pred(e) && e.date < TODAY && (fightsByEvent[e.id] || []).length > 0);
    // Fisher-Yates partial shuffle with seeded rand
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    pool.slice(0, PER_ERA).forEach(e => sample.push({ era, ...e }));
  }
  console.log(`Sampled ${sample.length} events:\n` + sample.map(s => `  [${s.era}] ${s.name} (${s.date})`).join('\n') + '\n');

  console.log('Fetching Wikipedia event list...');
  const wikiEvents = await fetchWikiEventList();
  const wikiByNorm = {};
  const wikiByHeadliner = {};
  const wikiByDate = {};
  wikiEvents.forEach(we => {
    wikiByNorm[norm(we.name)] = we;
    const hk = headlinerKey(we.name);
    if (!wikiByHeadliner[hk]) wikiByHeadliner[hk] = we;
    (wikiByDate[we.date] = wikiByDate[we.date] || []).push(we);
  });
  console.log(`  ${wikiEvents.length} wiki events\n`);

  const findings = [];   // {severity, era, event, type, detail}
  const add = (severity, era, event, type, detail) => findings.push({ severity, era, event, type, detail });
  let eventsChecked = 0, eventsNoWiki = 0, fightsCompared = 0;

  const dateClose = (a, b) => Math.abs(new Date(a) - new Date(b)) <= 2 * 86400000;

  for (const ev of sample) {
    // locate wiki page: exact name → name sans "UFC" prefix → headliner key → same-date
    // single event. Every match must agree on date (±2 days) to avoid pairing
    // same-headliner rematarches (e.g. UFC 220 and UFC 260 are both Miocic vs. Ngannou).
    let we = wikiByNorm[norm(ev.name)];
    if (we && !dateClose(we.date, ev.date)) we = null;
    if (!we) {
      const short = norm(ev.name).replace(/^ufc/, '');
      for (const [wn, w] of Object.entries(wikiByNorm)) {
        if (wn.replace(/^ufc/, '') === short && dateClose(w.date, ev.date)) { we = w; break; }
      }
    }
    if (!we) {
      const hk = headlinerKey(ev.name);
      const cand = wikiEvents.find(w => headlinerKey(w.name) === hk && dateClose(w.date, ev.date));
      if (cand) we = cand;
    }
    if (!we && wikiByDate[ev.date]?.length === 1) we = wikiByDate[ev.date][0];
    if (!we) {
      eventsNoWiki++;
      add('info', ev.era, `${ev.name} (${ev.date})`, 'no-wiki-match', 'Could not locate Wikipedia page; event not verified');
      continue;
    }

    let wikiRows;
    try {
      wikiRows = await fetchWikiCard(we.wikiUrl);
    } catch (e) {
      eventsNoWiki++;
      add('info', ev.era, `${ev.name} (${ev.date})`, 'wiki-fetch-error', e.message);
      continue;
    }
    if (!wikiRows.length) {
      eventsNoWiki++;
      add('info', ev.era, `${ev.name} (${ev.date})`, 'wiki-no-card', `Page ${we.wikiUrl} has no parseable fight card`);
      continue;
    }
    eventsChecked++;
    const evLabel = `${ev.name} (${ev.date})`;
    const dbFights = fightsByEvent[ev.id] || [];

    // map DB fights by normalized pair; arrays handle tournament-era same-pair-twice
    const dbByPair = {};
    // token-set key handles reversed name order ("Kang Kyung-ho" vs "Kyung Ho Kang")
    const tokenKey = s => s.trim().split(/\s+/).map(norm).sort().join('-');
    const dbByTokenPair = {};
    for (const f of dbFights) {
      const n1 = norm(fname(f.fighter1_id));
      const n2 = norm(fname(f.fighter2_id));
      const k = [n1, n2].sort().join(':');
      (dbByPair[k] = dbByPair[k] || []).push(f);
      const tk = [tokenKey(fname(f.fighter1_id)), tokenKey(fname(f.fighter2_id))].sort().join(':');
      (dbByTokenPair[tk] = dbByTokenPair[tk] || []).push(f);
    }
    const lastNameKey = s => norm(s.trim().split(/\s+/).pop());

    const matchedDb = new Set();
    let wikiIdx = -1;
    const orderPairs = []; // {wikiIdx, dbOrder}

    // among candidates, prefer one whose result agrees with the wiki row
    const pickCandidate = (list, wr) => {
      const avail = (list || []).filter(f => !matchedDb.has(f.id));
      if (!avail.length) return null;
      const want = wr.sep === 'def' ? 'win' : wr.sep === 'drew' ? 'draw' : null;
      return avail.find(f => want && f.result === want) || avail[0];
    };

    for (const wr of wikiRows) {
      wikiIdx++;
      const key = [norm(wr.f1), norm(wr.f2)].sort().join(':');
      let dbf = pickCandidate(dbByPair[key], wr);
      if (!dbf) {
        const tk = [tokenKey(wr.f1), tokenKey(wr.f2)].sort().join(':');
        dbf = pickCandidate(dbByTokenPair[tk], wr);
      }
      if (!dbf) {
        // single-fighter exact match: one wiki name matches a DB fight exactly
        // (covers renames like Waterson → Waterson-Gomez, Kunitskaya → Santos)
        const w1 = norm(wr.f1), w2 = norm(wr.f2);
        const hits = dbFights.filter(f => {
          if (matchedDb.has(f.id)) return false;
          const a = norm(fname(f.fighter1_id)), b = norm(fname(f.fighter2_id));
          return a === w1 || b === w1 || a === w2 || b === w2;
        });
        if (hits.length === 1) dbf = hits[0];
      }
      if (!dbf) {
        // last-name fallback
        const w1 = lastNameKey(wr.f1), w2 = lastNameKey(wr.f2);
        for (const f of dbFights) {
          if (matchedDb.has(f.id)) continue;
          const a = norm(fname(f.fighter1_id)), b = norm(fname(f.fighter2_id));
          if ((a.endsWith(w1) && b.endsWith(w2)) || (a.endsWith(w2) && b.endsWith(w1))) { dbf = f; break; }
        }
      }
      if (!dbf) {
        add('high', ev.era, evLabel, 'missing-fight', `On Wikipedia but not in DB: ${wr.f1} ${wr.sep} ${wr.f2} (${wr.weightClass || 'unknown wc'})`);
        continue;
      }
      matchedDb.add(dbf.id);
      fightsCompared++;
      const pair = `${fname(dbf.fighter1_id)} vs ${fname(dbf.fighter2_id)}`;

      // ── winner ──
      if (wr.sep === 'def') {
        const dbWinner = dbf.winner_id || (dbf.result === 'win' ? dbf.fighter1_id : null);
        if (dbf.result !== 'win' || !dbWinner) {
          add('critical', ev.era, evLabel, 'result-mismatch', `${pair}: wiki says ${wr.f1} def. ${wr.f2}, DB result='${dbf.result}'`);
        } else if (!namesMatch(fname(dbWinner), wr.f1)) {
          add('critical', ev.era, evLabel, 'winner-mismatch', `${pair}: wiki winner=${wr.f1}, DB winner=${fname(dbWinner)}`);
        }
      } else if (wr.sep === 'drew') {
        if (dbf.result !== 'draw') add('critical', ev.era, evLabel, 'result-mismatch', `${pair}: wiki says draw, DB result='${dbf.result}'`);
      } else if (wr.sep === 'vs') {
        const wCat = methodCategory(wr.method);
        if (wCat === 'nc' && dbf.result !== 'no_contest')
          add('critical', ev.era, evLabel, 'result-mismatch', `${pair}: wiki shows NC, DB result='${dbf.result}'`);
      }

      // ── method ──
      const wCat = methodCategory(wr.method);
      const dCat = methodCategory(dbf.method);
      if (wCat && dCat && !String(wCat).startsWith('other') && !String(dCat).startsWith('other')) {
        // draw/nc category quirks: DB may store method 'Draw'/'NC' matching result rows
        if (wCat !== dCat && !(wCat === 'draw' && dCat === 'nc') && !(wCat === 'nc' && dCat === 'draw')) {
          add('high', ev.era, evLabel, 'method-mismatch', `${pair}: wiki='${wr.method}' (${wCat}), DB='${dbf.method}' (${dCat})`);
        } else if (wCat === 'dec' && dCat === 'dec') {
          const wd = decisionType(wr.method), dd = decisionType(dbf.method);
          if (wd && dd && wd !== dd)
            add('medium', ev.era, evLabel, 'decision-type-mismatch', `${pair}: wiki=${wd}-DEC, DB=${dd}-DEC`);
        }
      } else if (wCat && !dbf.method && dbf.result && dbf.result !== 'upcoming') {
        add('medium', ev.era, evLabel, 'method-null', `${pair}: DB method NULL, wiki='${wr.method}'`);
      }

      // ── round / time ──
      if (wr.round != null && dbf.round != null && wr.round !== dbf.round)
        add('high', ev.era, evLabel, 'round-mismatch', `${pair}: wiki R${wr.round}, DB R${dbf.round}`);
      if (wr.time && dbf.time && wr.time !== dbf.time.replace(/^0(\d:)/, '$1'))
        add('medium', ev.era, evLabel, 'time-mismatch', `${pair}: wiki ${wr.time}, DB ${dbf.time}`);

      // ── title flags ──
      if (wr.isTitle !== !!dbf.is_title_fight)
        add('high', ev.era, evLabel, 'title-flag-mismatch', `${pair}: wiki title=${wr.isTitle} ('${wr.weightClass}'), DB is_title_fight=${!!dbf.is_title_fight}`);
      else if (wr.isTitle && wr.isInterim !== !!dbf.is_interim_title)
        add('medium', ev.era, evLabel, 'interim-flag-mismatch', `${pair}: wiki interim=${wr.isInterim}, DB is_interim_title=${!!dbf.is_interim_title}`);

      // ── card section ──
      if (wr.section && dbf.card_position && wr.section !== dbf.card_position)
        add('medium', ev.era, evLabel, 'card-position-mismatch', `${pair}: wiki=${wr.section}, DB=${dbf.card_position}`);

      if (dbf.bout_order != null) orderPairs.push({ wikiIdx, dbOrder: dbf.bout_order, pair });
    }

    // DB fights not on wiki
    for (const f of dbFights) {
      if (matchedDb.has(f.id)) continue;
      if (f.result === 'upcoming') continue;
      add('high', ev.era, evLabel, 'extra-fight', `In DB but not on Wikipedia: ${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)} (result=${f.result}, method=${f.method}) — possible phantom`);
    }

    // bout order: wiki card order ascending should match DB bout_order ascending
    const sortedByDb = [...orderPairs].sort((a, b) => a.dbOrder - b.dbOrder);
    let inversions = 0;
    for (let i = 1; i < sortedByDb.length; i++) {
      if (sortedByDb[i].wikiIdx < sortedByDb[i - 1].wikiIdx) inversions++;
    }
    if (inversions > 0)
      add('medium', ev.era, evLabel, 'bout-order-mismatch', `${inversions} order inversion(s) between wiki card order and DB bout_order (DB order: ${sortedByDb.map(p => p.pair).join(' | ')})`);

    console.log(`  [${ev.era}] ${ev.name}: ${wikiRows.length} wiki rows, ${dbFights.length} DB fights — checked`);
  }

  // ── summary ──
  const bySeverity = {};
  const byType = {};
  findings.forEach(f => {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byType[f.type] = (byType[f.type] || 0) + 1;
  });

  console.log('\n================ SUMMARY ================');
  console.log(`Events sampled: ${sample.length}; verified against wiki: ${eventsChecked}; no wiki match: ${eventsNoWiki}`);
  console.log(`Fights compared: ${fightsCompared}`);
  console.log('By severity:', JSON.stringify(bySeverity));
  console.log('By type:', JSON.stringify(byType));
  console.log('\n--- Findings ---');
  for (const sev of ['critical', 'high', 'medium', 'info']) {
    findings.filter(f => f.severity === sev).forEach(f =>
      console.log(`  [${sev.toUpperCase()}] [${f.era}] ${f.event} — ${f.type}: ${f.detail}`));
  }

  fs.writeFileSync('audit-wiki-findings.json', JSON.stringify({ seed: SEED, perEra: PER_ERA, sample: sample.map(s => `${s.name} (${s.date})`), eventsChecked, fightsCompared, findings }, null, 2));
  console.log('\nWrote audit-wiki-findings.json');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
