/**
 * fix-fight-methods.js
 *
 * Backfills method, method_detail, round, time for fights that have null method.
 * Sources fight results from Wikipedia event pages (no Cloudflare restrictions).
 * Targets 2022+ events by default since those were inserted by API-Sports (which
 * doesn't provide method data), while pre-2022 data came from ufcstats.com.
 *
 * Flags:
 *   --dry-run       Preview updates without writing to DB
 *   --all           Also process pre-2022 fights with null method
 *   --event "Name"  Process only one event by name substring
 *
 * Usage:
 *   node src/scrapers/fix-fight-methods.js
 *   node src/scrapers/fix-fight-methods.js --dry-run
 */
require('dotenv').config();
const axios    = require('axios');
const cheerio  = require('cheerio');
const supabase = require('../db/client');

const DRY   = process.argv.includes('--dry-run');
const ALL   = process.argv.includes('--all');
const EVARG = (() => { const i = process.argv.indexOf('--event'); return i > -1 ? process.argv[i+1] : null; })();
const DELAY = 1200;
const WIKI_BASE = 'https://en.wikipedia.org';
const LIST_URL  = WIKI_BASE + '/wiki/List_of_UFC_events';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Headliner key: extract fighters after the colon, sort alphabetically.
// "UFC Fight Night: Vera vs. Cruz" and "UFC on ESPN: Vera vs. Cruz" → same key.
function headlinerKey(name) {
  const colon = name.indexOf(':');
  const hl = colon >= 0 ? name.slice(colon + 1) : name;
  const parts = hl.split(/\s+vs\.?\s+/i).map(p => norm(p));
  return parts.sort().join(':');
}

function parseMethod(raw) {
  if (!raw) return { method: null, method_detail: null };
  const parenMatch = raw.match(/^(.+?)\s*\((.+)\)$/);
  const base   = parenMatch ? parenMatch[1].trim() : raw.trim();
  const detail = parenMatch ? parenMatch[2].trim() : '';
  const baseUp = base.toUpperCase();
  let method;
  if      (baseUp === 'TKO' || baseUp.includes('TECHNICAL KNOCKOUT')) method = 'KO/TKO';
  else if (baseUp === 'KO'  || baseUp.includes('KNOCKOUT'))           method = 'KO/TKO';
  else if (baseUp.includes('SUBMISSION') || baseUp === 'SUB')         method = 'SUB';
  else if (baseUp.includes('UNANIMOUS'))                               method = 'U-DEC';
  else if (baseUp.includes('SPLIT'))                                   method = 'S-DEC';
  else if (baseUp.includes('MAJORITY'))                                method = 'M-DEC';
  else if (baseUp.includes('DECISION'))                                method = 'DEC';
  else if (baseUp.includes('DISQUALIF') || baseUp === 'DQ')           method = 'DQ';
  else if (baseUp.includes('NO CONTEST') || baseUp === 'NC')          method = 'NC';
  else if (baseUp.includes('OVERTURNED'))                              method = 'Overturned';
  else if (baseUp === 'CNC' || baseUp.includes('CANNOT CONTINUE'))    method = 'CNC';
  else method = base;
  const detailClean = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : null;
  return { method, method_detail: detailClean || null };
}

async function fetchWikiEventList() {
  const { data } = await http.get(LIST_URL);
  const $      = cheerio.load(data);
  const events = [];
  const seen   = new Set();

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
        wikiPath  = href;
        eventName = a.text().trim();
        break;
      }
      if (!wikiPath || seen.has(wikiPath)) return;
      let dateStr = null;
      cells.each((_, cell) => {
        const txt = $(cell).text().trim();
        const m   = txt.match(/(\w+ \d{1,2},? \d{4})/);
        if (m) { const d = new Date(m[1]); if (!isNaN(d)) dateStr = d.toISOString().split('T')[0]; }
      });
      if (dateStr) { seen.add(wikiPath); events.push({ name: eventName, date: dateStr, wikiUrl: WIKI_BASE + wikiPath }); }
    });
  });
  return events;
}

function isFightCard($, table) {
  const ths = $(table).find('th').map((_, th) => $(th).text().toLowerCase().trim()).get();
  const h   = ths.join('|');
  if (/title fights in \d{4}/i.test(ths[0] || '')) return false;
  if (/current (?:ufc )?champions/i.test(ths[0] || '')) return false;
  const dataRows = $(table).find('tr').filter((_, tr) => $(tr).find('td').length > 0).length;
  if (dataRows > 25) return false;
  return (h.includes('weight') || h.includes('class')) &&
         (h.includes('method') || (h.includes('round') && h.includes('time')));
}

async function fetchFightResults(wikiUrl) {
  await sleep(DELAY);
  try {
    const { data } = await http.get(wikiUrl);
    const $       = cheerio.load(data);
    const results = [];

    $('table.toccolours, table.wikitable').each((_, table) => {
      if (!isFightCard($, table)) return;

      $(table).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 6) return;

        // Find f1/f2 indices by locating "def." or "drew" cell
        let f1Idx = 1, f2Idx = 3;
        cells.each((ci, cell) => {
          const t = $(cell).text().trim().toLowerCase();
          if ((t === 'def.' || t === 'drew' || t === 'vs.') && ci > 0 && f1Idx === 1) {
            f1Idx = ci - 1; f2Idx = ci + 1;
          }
        });

        const methodIdx = f2Idx + 1;
        const roundIdx  = f2Idx + 2;
        const timeIdx   = f2Idx + 3;
        if (cells.length <= methodIdx) return;

        const f1raw     = $(cells[f1Idx]).text().replace(/\([a-z]+\)/gi, '').replace(/\[\w+\]/g, '').trim();
        const f2raw     = $(cells[f2Idx]).text().replace(/\([a-z]+\)/gi, '').replace(/\[\w+\]/g, '').trim();
        if (!f1raw || !f2raw) return;

        const methodRaw = $(cells[methodIdx]).text().replace(/\[\w+\]/g, '').trim();
        const roundRaw  = cells.length > roundIdx ? $(cells[roundIdx]).text().replace(/\[\w+\]/g, '').trim() : '';
        const timeRaw   = cells.length > timeIdx  ? $(cells[timeIdx]).text().replace(/\[\w+\]/g, '').trim()  : '';

        const { method, method_detail } = parseMethod(methodRaw);
        const round = parseInt(roundRaw) || null;
        const time  = timeRaw.match(/\d+:\d+/) ? timeRaw.match(/\d+:\d+/)[0] : null;
        if (!method) return;

        results.push({ f1: f1raw, f2: f2raw, method, method_detail, round, time });
      });
    });
    return results;
  } catch { return []; }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  UFCDB — Fix Fight Methods (Wikipedia)   ║');
  if (DRY) console.log('║  *** DRY RUN ***                          ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Load fighters for name matching
  const allFighters = [];
  let fPage = 0;
  while (true) {
    const { data } = await supabase.from('fighters').select('id, first_name, last_name').range(fPage * 1000, (fPage + 1) * 1000 - 1);
    if (!data?.length) break;
    allFighters.push(...data);
    if (data.length < 1000) break;
    fPage++;
  }
  console.log('  ' + allFighters.length + ' fighters loaded');

  // Find events with null-method fights
  const dateFilter = ALL ? '1993-01-01' : '2022-01-01';
  const { data: nullFights } = await supabase
    .from('fights')
    .select('id, fighter1_id, fighter2_id, event_id, events!inner(id, name, date, slug)')
    .is('method', null)
    .gte('events.date', dateFilter);

  if (!nullFights?.length) { console.log('No null-method fights found.'); return; }

  // Group by event
  const eventFightMap = {};
  nullFights.forEach(f => {
    const ev = f.events;
    if (!ev) return;
    if (EVARG && !ev.name.toLowerCase().includes(EVARG.toLowerCase())) return;
    if (!eventFightMap[ev.id]) eventFightMap[ev.id] = { event: ev, fights: [] };
    eventFightMap[ev.id].fights.push(f);
  });

  console.log('  ' + nullFights.length + ' null-method fights across ' + Object.keys(eventFightMap).length + ' events (' + dateFilter + '+)\n');

  // Fetch Wikipedia event list
  console.log('Fetching Wikipedia event list...');
  const wikiEvents = await fetchWikiEventList();
  console.log('  ' + wikiEvents.length + ' events in Wikipedia list\n');

  const wikiByNorm = {};
  const wikiByHeadliner = {};
  wikiEvents.forEach(we => {
    wikiByNorm[norm(we.name)] = we;
    const hk = headlinerKey(we.name);
    if (!wikiByHeadliner[hk]) wikiByHeadliner[hk] = we;
  });

  let eventsProcessed = 0, eventsNoWiki = 0, updated = 0, unmatched = 0;
  const eventList = Object.values(eventFightMap).sort((a, b) => a.event.date.localeCompare(b.event.date));

  for (const { event, fights } of eventList) {
    const dbNorm  = norm(event.name);
    let wikiEntry = wikiByNorm[dbNorm];

    if (!wikiEntry) {
      const short = dbNorm.replace(/^ufc/, '');
      for (const [wn, we] of Object.entries(wikiByNorm)) {
        if (wn.replace(/^ufc/, '') === short) { wikiEntry = we; break; }
      }
    }

    // Headliner-key fallback: strip event series prefix, compare just fighter names.
    // Handles "UFC Fight Night: X vs. Y" matching "UFC on ESPN: X vs. Y" etc.
    if (!wikiEntry) {
      wikiEntry = wikiByHeadliner[headlinerKey(event.name)] || null;
    }

    if (!wikiEntry) {
      eventsNoWiki++;
      if (EVARG) console.log('  No wiki match: "' + event.name + '" (' + event.date + ')');
      continue;
    }

    eventsProcessed++;
    const results = await fetchFightResults(wikiEntry.wikiUrl);
    if (!results.length) {
      console.log('  ? No fight data: "' + event.name + '" (' + event.date + ')');
      continue;
    }

    // Build DB fight pair lookup: "normF1:normF2" -> fightId (both orderings)
    const dbFightByPair = {};
    fights.forEach(f => {
      const f1Obj = allFighters.find(x => x.id === f.fighter1_id);
      const f2Obj = allFighters.find(x => x.id === f.fighter2_id);
      if (!f1Obj || !f2Obj) return;
      const nf1 = norm((f1Obj.first_name||'') + (f1Obj.last_name||''));
      const nf2 = norm((f2Obj.first_name||'') + (f2Obj.last_name||''));
      dbFightByPair[nf1 + ':' + nf2] = f.id;
      dbFightByPair[nf2 + ':' + nf1] = f.id;
    });

    let evUpdated = 0, evUnmatched = 0;

    for (const wf of results) {
      const wf1 = norm(wf.f1), wf2 = norm(wf.f2);
      let fightId = dbFightByPair[wf1 + ':' + wf2];

      // Last-name fallback
      if (!fightId) {
        const wf1Last = norm(wf.f1.trim().split(/\s+/).pop());
        const wf2Last = norm(wf.f2.trim().split(/\s+/).pop());
        for (const [k, id] of Object.entries(dbFightByPair)) {
          const [a, b] = k.split(':');
          if ((a.endsWith(wf1Last) && b.endsWith(wf2Last)) || (a.endsWith(wf2Last) && b.endsWith(wf1Last))) {
            fightId = id; break;
          }
        }
      }

      if (!fightId) { evUnmatched++; continue; }

      if (DRY) {
        console.log('  [DRY] ' + event.name + ': ' + wf.f1 + ' vs ' + wf.f2 + ' => ' + wf.method + ' R' + (wf.round||'?') + ' ' + (wf.time||'?'));
      } else {
        const patch = { method: wf.method };
        if (wf.method_detail) patch.method_detail = wf.method_detail;
        if (wf.round)         patch.round         = wf.round;
        if (wf.time)          patch.time          = wf.time;
        const { error } = await supabase.from('fights').update(patch).eq('id', fightId);
        if (error) console.error('  UPDATE ERROR:', error.message);
      }
      evUpdated++;
    }

    updated   += evUpdated;
    unmatched += evUnmatched;

    const pct = Math.round(eventsProcessed / eventList.length * 100);
    console.log('  [' + pct + '%] ' + event.name + ' (' + event.date + '): +' + evUpdated + ' updated, ' + evUnmatched + ' unmatched');
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Complete!                               ║');
  console.log('║  Events processed:  ' + String(eventsProcessed).padEnd(20) + '║');
  console.log('║  No wiki match:     ' + String(eventsNoWiki).padEnd(20) + '║');
  console.log('║  Fights updated:    ' + String(updated).padEnd(20) + '║');
  console.log('║  Fights unmatched:  ' + String(unmatched).padEnd(20) + '║');
  console.log('╚══════════════════════════════════════════╝');
}

main().catch(console.error);