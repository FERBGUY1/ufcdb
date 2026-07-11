/**
 * audit-2026.js
 *
 * Audits all completed 2026 UFC events against Wikipedia:
 *   - Wrong winner (fighter1/fighter2 flipped, or incorrect winner_id)
 *   - Wrong method/round
 *   - Incorrect bout_order / card_position
 *
 * Flags:
 *   --fix       Apply corrections to DB (default: report only)
 *   --event "X" Limit to one event name substring
 */
require('dotenv').config();
const axios    = require('axios');
const cheerio  = require('cheerio');
const supabase = require('../db/client');

const FIX            = process.argv.includes('--fix');
const NO_FIX_WINNERS = process.argv.includes('--no-fix-winners');
const EVARG = (() => { const i = process.argv.indexOf('--event'); return i > -1 ? process.argv[i+1] : null; })();
const TODAY = '2026-06-09';
// Date window for which events to audit. Defaults reproduce the original 2026 scope;
// pass --from/--to only to WIDEN the net. Matching/scoring logic is unchanged.
const FROM = (() => { const i = process.argv.indexOf('--from'); return i > -1 ? process.argv[i+1] : '2026-01-01'; })();
const TO   = (() => { const i = process.argv.indexOf('--to');   return i > -1 ? process.argv[i+1] : TODAY; })();

// Fight IDs (prefix OK) where wrong_winner is a false positive and should NOT be auto-fixed.
// Jean Silva ambiguity (two Jean Silvas in DB), Tommy/Thomas Petersen name variant,
// Justin Tafa identity issue (needs fighter1_id change, not just winner_id).
const SKIP_WINNER_IDS = new Set(['73d1fcbf', 'c0849aa3', '2f9c8604']);

const http  = axios.create({ timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const NAME_MAP = {
  'rongzhu': 'rongzhurongzhu', 'aoriqileng': 'aoriqilengaoriqileng',
  'alatengheili': 'alatengheilialatengheili', 'yizha': 'yizhayizha',
  'sumudaerji': 'sumudaerjisumudaerji', 'maheshate': 'maheshatemaheshate',
  'mizuki': 'mizukimizuki', 'iangarry': 'ianmachadogarry',
  'markomadsen': 'markmadsen', 'josemigueldelgado': 'josedelgado',
  'bobbygreen': 'kinggreen', 'charlieradtke': 'charlesradtke',
  'zachscroggin': 'zacharyscroggin', 'billygoff': 'billyraygoff',
  'montserratrendon': 'montserendon', 'daunjung': 'dawoonjung',
  'baysangursusurkaev': 'baisangursusurkaev', 'assualmabayev': 'asualmabayev',
  'bernardosopaj': 'benardosopaj', 'raffaelcerqueira': 'rafaelcerqueira',
  'zacharyreese': 'zachreese', 'kleidisonrodrigues': 'kleydsonrodrigues',
  'teciatorres': 'teciapennington', 'sulangrangbo': 'sulangrangbosulangrangbo',
  'choidooho': 'doohochoi', 'parkjunyong': 'junyongpark',
  'kimsangwook': 'sangwookkim', 'dommarfan': 'dominickmarfan',
  'timothycuamba': 'timmycuamba',
};

function applyMap(n) { return NAME_MAP[n] || n; }

function normLookup(raw, byName) {
  if (!raw) return null;
  const n = norm(raw);
  return byName[n] || byName[applyMap(n)] || null;
}

// Headliner key: extract fighters after the colon, sort alphabetically.
// Mirrors fix-fight-methods.js so "UFC Fight Night: X vs. Y" matches the same
// bout on Wikipedia even when the series prefix differs ("UFC on ABC: X vs. Y").
function headlinerKey(name) {
  const colon = name.indexOf(':');
  const hl = colon >= 0 ? name.slice(colon + 1) : name;
  const parts = hl.split(/\s+vs\.?\s+/i).map(p => norm(p));
  return parts.sort().join(':');
}

function parseMethod(raw) {
  if (!raw) return null;
  const up = raw.toUpperCase().trim();
  if (/^KO.?TKO$/.test(up) || up === 'TKO' || up === 'KO') return 'KO/TKO';
  if (up === 'SUBMISSION' || up === 'SUB')                   return 'SUB';
  if (up.includes('UNANIMOUS'))                              return 'U-DEC';
  if (up.includes('SPLIT'))                                  return 'S-DEC';
  if (up.includes('MAJORITY'))                               return 'M-DEC';
  if (/^DECISION$/.test(up))                                 return 'DEC';
  if (up === 'NO CONTEST' || up === 'NC')                    return 'NC';
  if (up.includes('DISQUALIF') || up === 'DQ')               return 'DQ';
  if (up === 'OVERTURNED')                                   return 'Overturned';
  if (up === 'CNC' || up.includes('CANNOT CONTINUE'))        return 'CNC';
  if (up.includes('DRAW'))                                   return 'Draw';
  return null;
}

function detectSection($, table) {
  const hdr = $(table).find('tr').first().find('th[colspan]').first().text().toLowerCase();
  if (/early.?prelim/i.test(hdr)) return 'early_prelim';
  if (/prelim/i.test(hdr))        return 'prelim';
  if (/main.?card/i.test(hdr))    return 'main_card';
  const cap = $(table).find('caption').text().toLowerCase();
  if (/early.?prelim/i.test(cap)) return 'early_prelim';
  if (/prelim/i.test(cap))        return 'prelim';
  if (/main.?card/i.test(cap))    return 'main_card';
  let el = $(table).prev();
  for (let i = 0; i < 12 && el.length; i++) {
    const tag = (el.get(0)||{}).tagName||'';
    let txt = null;
    if (/^h[2-4]$/.test(tag)) txt = el.text().toLowerCase();
    else if (tag === 'div') { const h = el.find('h2,h3,h4').first(); if (h.length) txt = h.text().toLowerCase(); }
    if (txt !== null) {
      if (/early.?prelim/i.test(txt)) return 'early_prelim';
      if (/prelim/i.test(txt))        return 'prelim';
      if (/main.?card/i.test(txt))    return 'main_card';
      break;
    }
    el = el.prev();
  }
  return null;
}

function isFightCard($, table) {
  const ths = $(table).find('th').map((_, th) => $(th).text().toLowerCase().trim()).get().join('|');
  if (/title fights in \d{4}|current.*champions/i.test(ths)) return false;
  if ($(table).find('tr').filter((_, tr) => $(tr).find('td').length > 0).length > 30) return false;
  return (ths.includes('weight') || ths.includes('class')) &&
         (ths.includes('method') || (ths.includes('round') && ths.includes('time')));
}

/**
 * Fetch all fights from a Wikipedia event page.
 * Returns array of { f1, f2, result ('win'|'draw'|'nc'), winner (f1 or f2),
 *                    method, round, time, boutOrder, cardPosition }
 */
async function fetchWikiResults(wikiUrl) {
  await sleep(1300);
  try {
    const { data } = await http.get(wikiUrl);
    const $ = cheerio.load(data);
    const buckets = { main_card: [], prelim: [], early_prelim: [], unknown: [] };

    $('table.toccolours, table.wikitable').each((_, table) => {
      if (!isFightCard($, table)) return;
      const section = detectSection($, table) || 'unknown';

      $(table).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 5) return;

        // Locate winner/def./drew columns
        let winnerIdx = -1, verbIdx = -1, loserIdx = -1;
        cells.each((ci, cell) => {
          const t = $(cell).text().trim().toLowerCase();
          if ((t === 'def.' || t === 'drew' || t === 'vs.' || t === 'nc') && ci > 0) {
            if (verbIdx === -1) { verbIdx = ci; winnerIdx = ci - 1; loserIdx = ci + 1; }
          }
        });
        if (verbIdx === -1 || winnerIdx < 0 || loserIdx >= cells.length) return;

        const verb    = $(cells[verbIdx]).text().trim().toLowerCase();
        // (c)/(ic)/etc. champion markers — [a-z]{1,2} so interim (ic) strips too
        const f1raw   = $(cells[winnerIdx]).text().replace(/\([a-z]{1,2}\)/gi,'').replace(/\[\w+\]/g,'').trim();
        const f2raw   = $(cells[loserIdx]).text().replace(/\([a-z]{1,2}\)/gi,'').replace(/\[\w+\]/g,'').trim();
        if (!f1raw || !f2raw || f1raw.length > 60 || f2raw.length > 60) return;

        // Method, round, time — scan remaining cells
        let methodRaw = '', roundRaw = '', timeRaw = '';
        cells.each((ci, cell) => {
          if (ci <= loserIdx) return;
          const t = $(cell).text().trim();
          if (!methodRaw && /decision|submission|ko|tko|draw|no contest|nc|dq/i.test(t)) methodRaw = t;
          else if (!roundRaw && /^\d$/.test(t)) roundRaw = t;
          else if (!timeRaw && /^\d:\d{2}$/.test(t)) timeRaw = t;
        });

        const method = parseMethod(methodRaw);
        const round  = parseInt(roundRaw) || null;
        const time   = timeRaw || null;

        let result = 'win', winner = 'f1';
        if (verb === 'drew' || methodRaw.toLowerCase().includes('draw')) { result = 'draw'; winner = null; }
        else if (verb === 'nc' || methodRaw.toLowerCase().includes('no contest')) { result = 'no_contest'; winner = null; }

        buckets[section].push({ f1: f1raw, f2: f2raw, result, winner, method, round, time });
      });
    });

    const ordered = [...buckets.main_card, ...buckets.prelim, ...buckets.early_prelim, ...buckets.unknown];
    const mLen = buckets.main_card.length, pLen = buckets.prelim.length, eLen = buckets.early_prelim.length;
    const hasExplicit = pLen > 0 || eLen > 0;

    return ordered.map((f, i) => {
      let cp;
      if (!hasExplicit) cp = deriveSection(i, ordered.length);
      else if (i < mLen) cp = 'main_card';
      else if (i < mLen + pLen) cp = 'prelim';
      else if (i < mLen + pLen + eLen) cp = 'early_prelim';
      else cp = 'unknown';
      return { ...f, boutOrder: i, cardPosition: cp };
    });
  } catch (e) {
    if (e.response?.status === 404) return null;
    console.error(`  Wiki error ${wikiUrl}: ${e.message}`);
    return [];
  }
}

function deriveSection(i, total) {
  if (total <= 5) return 'main_card';
  if (i < 5) return 'main_card';
  if (total <= 10) return 'prelim';
  if (i < 10) return 'prelim';
  return 'early_prelim';
}

async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data } = await supabase.from(table).select(cols).range(page*1000,(page+1)*1000-1);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  UFCDB — Audit 2026 Events               ║');
  if (FIX) console.log('║  --fix: writing corrections to DB        ║');
  else     console.log('║  Report only (use --fix to apply)        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const allFighters = await loadAll('fighters', 'id, first_name, last_name');
  const byName = {};
  allFighters.forEach(f => {
    const full = norm((f.first_name||'') + (f.last_name||''));
    if (full) byName[full] = f.id;
    const mapped = applyMap(full);
    if (mapped !== full) byName[mapped] = f.id;
  });
  const fighterById = Object.fromEntries(allFighters.map(f => [f.id, f]));
  const fname = id => {
    const f = fighterById[id];
    return f ? `${f.first_name} ${f.last_name}` : id?.slice(0,8);
  };

  // Load completed 2026 events
  const { data: allEvents } = await supabase.from('events')
    .select('id, name, date, slug')
    .gte('date', FROM)
    .lte('date', TO)
    .order('date');

  const targetEvents = EVARG
    ? allEvents.filter(e => e.name.toLowerCase().includes(EVARG.toLowerCase()))
    : allEvents;
  console.log(`Checking ${targetEvents.length} completed 2026 events\n`);

  // Fetch Wikipedia event list once
  console.log('Fetching Wikipedia event list...');
  const wikiByNorm = {};
  const wikiByHeadliner = {}; // headliner-key fallback (mirrors fix-fight-methods.js)
  try {
    const { data } = await http.get('https://en.wikipedia.org/wiki/List_of_UFC_events');
    const $ = cheerio.load(data);
    const seen = new Set();
    $('table.toccolours, table.wikitable').each((_, table) => {
      $(table).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 3) return;
        for (let i = 0; i < Math.min(4, cells.length); i++) {
          // Wikipedia serves protocol-relative hrefs (//en.wikipedia.org/wiki/...) since mid-2026
          const a = $(cells[i]).find('a[href^="/wiki/"], a[href*="//en.wikipedia.org/wiki/"]').first();
          if (!a.length) continue;
          const href = (a.attr('href') || '').replace(/^(?:https?:)?\/\/en\.wikipedia\.org/, '');
          if (href === '/wiki/UFC') return;
          if (/List_of|Category:|Template:|Help:|Wikipedia:/i.test(href)) continue;
          if (!/\/wiki\/(UFC|WEC_|The_Ultimate_Fighter|Strikeforce|PRIDE)/i.test(href)) continue;
          if (seen.has(href)) return;
          let dateStr = null;
          cells.each((_, cell) => {
            const txt = $(cell).text().trim();
            const m   = txt.match(/(\w+ \d{1,2},? \d{4})/);
            if (m) { const d = new Date(m[1]); if (!isNaN(d)) dateStr = d.toISOString().split('T')[0]; }
          });
          if (dateStr) {
            seen.add(href);
            const we = { name: a.text().trim(), date: dateStr, wikiUrl: 'https://en.wikipedia.org' + href };
            wikiByNorm[norm(a.text().trim())] = we;
            const hk = headlinerKey(a.text().trim());
            if (!wikiByHeadliner[hk]) wikiByHeadliner[hk] = we;
          }
          break;
        }
      });
    });
  } catch (e) { console.error('Wiki list error:', e.message); }
  console.log(`  ${Object.keys(wikiByNorm).length} Wikipedia events found\n`);

  // Load all fights for target events
  const eventIds = targetEvents.map(e => e.id);
  let allFights = [];
  for (let i = 0; i < eventIds.length; i += 100) {
    const { data } = await supabase.from('fights')
      .select('id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, bout_order, card_position')
      .in('event_id', eventIds.slice(i, i+100));
    if (data) allFights.push(...data);
  }
  const fightsByEvent = {};
  allFights.forEach(f => {
    if (!fightsByEvent[f.event_id]) fightsByEvent[f.event_id] = [];
    fightsByEvent[f.event_id].push(f);
  });

  const issues = [];
  let wikiMissed = 0;

  for (const ev of targetEvents) {
    const dbNorm = norm(ev.name);
    let wikiEntry = wikiByNorm[dbNorm];
    if (!wikiEntry) {
      const short = dbNorm.replace(/^ufc/, '');
      for (const [wn, we] of Object.entries(wikiByNorm)) {
        if (wn.replace(/^ufc/, '') === short) { wikiEntry = we; break; }
      }
    }
    // Headliner-key fallback (mirrors fix-fight-methods.js): match on fighter
    // names after the colon when the series prefix differs. Fallback only —
    // runs after norm + ufc-strip, so already-matching events are unaffected.
    if (!wikiEntry) {
      wikiEntry = wikiByHeadliner[headlinerKey(ev.name)] || null;
    }
    if (!wikiEntry) { wikiMissed++; process.stdout.write('?'); continue; }

    const wikiResults = await fetchWikiResults(wikiEntry.wikiUrl);
    if (!wikiResults || !wikiResults.length) { wikiMissed++; process.stdout.write('!'); continue; }

    const evFights = fightsByEvent[ev.id] || [];
    // Build pair lookup both ways: normalised name pair → DB fight
    const pairToFight = {};
    evFights.forEach(f => {
      const f1 = fighterById[f.fighter1_id], f2 = fighterById[f.fighter2_id];
      if (!f1 || !f2) return;
      const n1 = norm((f1.first_name||'')+(f1.last_name||''));
      const n2 = norm((f2.first_name||'')+(f2.last_name||''));
      // Store keyed by BOTH orderings and under both mapped names
      for (const a of [n1, applyMap(n1)]) {
        for (const b of [n2, applyMap(n2)]) {
          pairToFight[a+':'+b] = f;
          pairToFight[b+':'+a] = f;
        }
      }
    });

    for (const wf of wikiResults) {
      const wn1 = norm(wf.f1), wn2 = norm(wf.f2);
      let dbFight = pairToFight[wn1+':'+wn2] || pairToFight[applyMap(wn1)+':'+applyMap(wn2)];
      if (!dbFight) {
        // Last-name fallback
        const wl1 = norm(wf.f1.trim().split(/\s+/).pop());
        const wl2 = norm(wf.f2.trim().split(/\s+/).pop());
        for (const [k, df] of Object.entries(pairToFight)) {
          const [a, b] = k.split(':');
          if ((a.endsWith(wl1) && b.endsWith(wl2)) || (a.endsWith(wl2) && b.endsWith(wl1))) {
            dbFight = df; break;
          }
        }
      }
      if (!dbFight) continue;

      const f1 = fighterById[dbFight.fighter1_id];
      const f2 = fighterById[dbFight.fighter2_id];
      const wikiWinnerId = wf.result === 'win'
        ? normLookup(wf.f1, byName)
        : null;

      const evIssues = [];

      // ── Check winner / result ────────────────────────────────────────────────
      if (wf.result === 'win' && dbFight.result === 'win') {
        const dbWinnerId = dbFight.winner_id || dbFight.fighter1_id;
        if (wikiWinnerId && dbWinnerId !== wikiWinnerId) {
          const skipWinner = NO_FIX_WINNERS || SKIP_WINNER_IDS.has(dbFight.id.slice(0, 8));
          // Winner is wrong — check if it's just fighter1/fighter2 flipped
          const wikiLoserId = normLookup(wf.f2, byName);
          const isFlipped = (dbFight.fighter1_id === wikiLoserId && dbFight.fighter2_id === wikiWinnerId);
          evIssues.push({
            type: 'wrong_winner',
            fight_id: dbFight.id,
            skipFix: skipWinner,
            detail: `DB winner: ${fname(dbWinnerId)} | Wiki winner: ${fname(wikiWinnerId)}${isFlipped ? ' (fighters FLIPPED)' : ''}${skipWinner ? ' [SKIPPED]' : ''}`,
            fix: isFlipped
              ? { fighter1_id: wikiWinnerId, fighter2_id: wikiLoserId, winner_id: wikiWinnerId }
              : { winner_id: wikiWinnerId },
          });
        }
      } else if (wf.result !== (dbFight.result || 'win')) {
        evIssues.push({
          type: 'wrong_result',
          fight_id: dbFight.id,
          detail: `DB result: ${dbFight.result} | Wiki result: ${wf.result}`,
          fix: { result: wf.result, winner_id: wf.result === 'win' ? wikiWinnerId : null },
        });
      }

      // ── Check method ─────────────────────────────────────────────────────────
      if (wf.method && dbFight.method && wf.method !== dbFight.method) {
        evIssues.push({
          type: 'wrong_method',
          fight_id: dbFight.id,
          detail: `DB method: ${dbFight.method} | Wiki method: ${wf.method}`,
          fix: { method: wf.method },
        });
      }
      if (wf.method && !dbFight.method) {
        evIssues.push({
          type: 'missing_method',
          fight_id: dbFight.id,
          detail: `DB method: null | Wiki method: ${wf.method} R${wf.round} ${wf.time||''}`,
          fix: { method: wf.method, round: wf.round, time: wf.time },
        });
      }

      // ── Check bout_order / card_position ─────────────────────────────────────
      if (dbFight.bout_order != null && dbFight.bout_order !== wf.boutOrder) {
        evIssues.push({
          type: 'wrong_bout_order',
          fight_id: dbFight.id,
          detail: `DB bo=${dbFight.bout_order} ${dbFight.card_position} | Wiki bo=${wf.boutOrder} ${wf.cardPosition}`,
          fix: { bout_order: wf.boutOrder, card_position: wf.cardPosition },
        });
      }
      if (dbFight.card_position && wf.cardPosition !== 'unknown' && dbFight.card_position !== wf.cardPosition) {
        // Avoid duplicate if already captured in bout_order issue
        const alreadyCaptured = evIssues.some(x => x.type === 'wrong_bout_order' && x.fight_id === dbFight.id);
        if (!alreadyCaptured) {
          evIssues.push({
            type: 'wrong_section',
            fight_id: dbFight.id,
            detail: `DB section: ${dbFight.card_position} | Wiki section: ${wf.cardPosition}`,
            fix: { card_position: wf.cardPosition },
          });
        }
      }

      if (evIssues.length) {
        evIssues.forEach(iss => { iss.event = ev.name; iss.date = ev.date; iss.fight = `${fname(dbFight.fighter1_id)} vs ${fname(dbFight.fighter2_id)}`; });
        issues.push(...evIssues);
      }
    }

    process.stdout.write('.');
  }
  console.log(`\n  ${wikiMissed} events without Wikipedia data\n`);

  // ── Report ─────────────────────────────────────────────────────────────────
  const byType = {};
  issues.forEach(iss => { if (!byType[iss.type]) byType[iss.type] = []; byType[iss.type].push(iss); });

  const typeOrder = ['wrong_winner','wrong_result','wrong_method','missing_method','wrong_bout_order','wrong_section'];
  for (const type of typeOrder) {
    const list = byType[type] || [];
    if (!list.length) continue;
    console.log(`\n── ${type.replace(/_/g,' ').toUpperCase()} (${list.length}) ───────────────────────────────`);
    list.forEach(iss => {
      console.log(`  [${iss.date}] ${iss.event}`);
      console.log(`    ${iss.fight}  (${iss.fight_id.slice(0,8)})`);
      console.log(`    ${iss.detail}`);
    });
  }

  if (!issues.length) {
    console.log('\n✓ No issues found in 2026 events.');
    return;
  }

  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`Total issues: ${issues.length}`);
  Object.entries(byType).forEach(([t, list]) => console.log(`  ${t}: ${list.length}`));

  if (!FIX) {
    console.log('\nRun with --fix to apply corrections.');
    return;
  }

  // ── Apply fixes ────────────────────────────────────────────────────────────
  console.log('\n── Applying fixes ───────────────────────────────────────────────────────────\n');

  // Merge fixes per fight_id (multiple issues on same fight → merge patches)
  const patches = {};
  issues.forEach(iss => {
    if (iss.skipFix) return; // skip false-positive wrong_winner entries
    if (!patches[iss.fight_id]) patches[iss.fight_id] = {};
    Object.assign(patches[iss.fight_id], iss.fix);
  });

  let fixed = 0, errors = 0;
  for (const [fightId, patch] of Object.entries(patches)) {
    const { error } = await supabase.from('fights').update(patch).eq('id', fightId);
    if (error) { console.error(`  Error ${fightId.slice(0,8)}: ${error.message}`); errors++; }
    else { fixed++; }
  }
  console.log(`  Fixed ${fixed} fights, ${errors} errors`);

  // Re-run fix-fighter-records if any winner changes
  const hasWinnerChanges = issues.some(iss => ['wrong_winner','wrong_result'].includes(iss.type));
  if (hasWinnerChanges) {
    console.log('\n  Winner data changed — resyncing fighter records...');
    const { default: fixRecords } = await import('../scrapers/fix-fighter-records.js').catch(() => ({ default: null }));
    // Can't import easily; instruct user instead
    console.log('  → Run: node -r dotenv/config src/scrapers/fix-fighter-records.js');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
