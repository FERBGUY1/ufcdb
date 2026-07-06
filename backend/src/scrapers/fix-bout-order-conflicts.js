/**
 * fix-bout-order-conflicts.js
 *
 * Targeted fix for the 201 bout_order conflicts (two fights sharing the same
 * bout_order within the same event+section).
 *
 * Root cause: fix-bout-order.js correctly assigned Wikipedia positions to fights
 * it could match, but unmatched fights (name mismatches) retained their old
 * bout_order values and collided with correctly-assigned fights.
 *
 * Strategy:
 *  Phase 1 – Re-fetch Wikipedia for each conflict event and correct any fights
 *             that can now be matched.  Delegates to the same matching logic
 *             used by fix-bout-order.js.
 *  Phase 2 – For any conflicts that survive Phase 1 (still unresolved), fill
 *             the gap: the unmatched fight gets assigned the one missing
 *             position in its section's expected sequence.
 *
 * Flags:
 *   --dry-run    Preview updates without writing to DB
 *   --phase1     Run Phase 1 only (Wikipedia re-match)
 *   --phase2     Run Phase 2 only (gap-fill, no network)
 */
require('dotenv').config();
const axios    = require('axios');
const cheerio  = require('cheerio');
const supabase = require('../db/client');

const DRY     = process.argv.includes('--dry-run');
const ONLY1   = process.argv.includes('--phase1');
const ONLY2   = process.argv.includes('--phase2');
const RUN1    = !ONLY2;
const RUN2    = !ONLY1;

const DELAY   = 1300;
const WIKI    = 'https://en.wikipedia.org';
const http    = axios.create({ timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' } });
const sleep   = ms => new Promise(r => setTimeout(r, ms));

// ── helpers shared with fix-bout-order.js ─────────────────────────────────────

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
  // Korean name-order corrections (Wikipedia lists surname first)
  'choidooho': 'doohochoi',
  'parkjunyong': 'junyongpark',
  'kimsangwook': 'sangwookkim',
  'choiseunghoon': 'seunghoonchoi',
  'leejinsu': 'jinsule',
  'kangkyungho': 'kyunghokangg',
  'parkbyunghyun': 'byunghyunpark',
};

function lookupFighter(raw, byName) {
  if (!raw || /^(opponent\s+)?tba$/i.test(raw.trim())) return null;
  const n = norm(raw);
  let id = byName[n]; if (id) return id;
  if (NAME_MAP[n]) { id = byName[NAME_MAP[n]]; if (id) return id; }
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
    const tag = (el.get(0) || {}).tagName || '';
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
  if (/title fights in \d{4}/i.test(ths) || /current.*champions/i.test(ths)) return false;
  if ($(table).find('tr').filter((_, tr) => $(tr).find('td').length > 0).length > 30) return false;
  return (ths.includes('weight') || ths.includes('class')) &&
         (ths.includes('method') || (ths.includes('round') && ths.includes('time')));
}

async function fetchWikiFightOrder(wikiUrl) {
  await sleep(DELAY);
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
        let f1i = 1, f2i = 3;
        cells.each((ci, cell) => {
          const t = $(cell).text().trim().toLowerCase();
          if ((t === 'def.' || t === 'drew' || t === 'vs.') && ci > 0 && f1i === 1) {
            f1i = ci - 1; f2i = ci + 1;
          }
        });
        const f1 = $(cells[f1i]).text().replace(/\([ic]\)/gi, '').replace(/\[\w+\]/g, '').trim();
        const f2 = $(cells[f2i]).text().replace(/\([ic]\)/gi, '').replace(/\[\w+\]/g, '').trim();
        if (!f1 || !f2 || f1.length > 60 || f2.length > 60) return;
        buckets[section].push({ f1, f2 });
      });
    });

    const ordered = [...buckets.main_card, ...buckets.prelim, ...buckets.early_prelim, ...buckets.unknown];
    if (!ordered.length) return [];
    const mLen = buckets.main_card.length, pLen = buckets.prelim.length;
    const eLen = buckets.early_prelim.length;
    const hasExplicit = pLen > 0 || eLen > 0;
    return ordered.map((f, i) => {
      let cp;
      if (!hasExplicit) cp = i < 5 ? 'main_card' : i < 10 ? 'prelim' : 'early_prelim';
      else if (i < mLen) cp = 'main_card';
      else if (i < mLen + pLen) cp = 'prelim';
      else if (i < mLen + pLen + eLen) cp = 'early_prelim';
      else cp = 'unknown';
      return { f1: f.f1, f2: f.f2, boutOrder: i, cardPosition: cp };
    });
  } catch (e) {
    console.error(`  Error fetching ${wikiUrl}: ${e.message}`);
    return [];
  }
}

async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

// ── find conflict events ───────────────────────────────────────────────────────

function findConflicts(fights) {
  const groups = {};
  fights.forEach(f => {
    if (f.bout_order == null || !f.card_position) return;
    const key = `${f.event_id}|${f.card_position}|${f.bout_order}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });
  return Object.values(groups).filter(g => g.length > 1);
}

// ── phase 1: Wikipedia re-match ────────────────────────────────────────────────

async function phase1(conflictEventIds, allFights, fighterById, evMap, wikiEventList) {
  console.log('\n── Phase 1: Wikipedia re-match ─────────────────────────────────────────────\n');

  const wikiByNorm = {};
  wikiEventList.forEach(we => { wikiByNorm[norm(we.name)] = we; });

  const byName = {};
  Object.values(fighterById).forEach(f => {
    const full = norm((f.first_name || '') + (f.last_name || ''));
    if (full) byName[full] = f.id;
  });

  const fightsByEvent = {};
  allFights.forEach(f => {
    if (!fightsByEvent[f.event_id]) fightsByEvent[f.event_id] = [];
    fightsByEvent[f.event_id].push(f);
  });

  let eventsUpdated = 0, fightsUpdated = 0;

  for (const evId of conflictEventIds) {
    const ev = evMap[evId];
    if (!ev) continue;

    const dbNorm = norm(ev.name);
    let wikiEntry = wikiByNorm[dbNorm];
    if (!wikiEntry) {
      const short = dbNorm.replace(/^ufc/, '');
      for (const [wn, we] of Object.entries(wikiByNorm)) {
        if (wn.replace(/^ufc/, '') === short) { wikiEntry = we; break; }
      }
    }
    if (!wikiEntry) { process.stdout.write('s'); continue; } // no wiki entry

    const orderedFights = await fetchWikiFightOrder(wikiEntry.wikiUrl);
    if (!orderedFights.length) { process.stdout.write('?'); continue; }

    const evFights = fightsByEvent[evId] || [];
    const pairToFight = {};
    evFights.forEach(f => {
      const f1 = fighterById[f.fighter1_id], f2 = fighterById[f.fighter2_id];
      if (!f1 || !f2) return;
      const n1 = norm((f1.first_name||'') + (f1.last_name||''));
      const n2 = norm((f2.first_name||'') + (f2.last_name||''));
      pairToFight[n1 + ':' + n2] = f;
      pairToFight[n2 + ':' + n1] = f;
    });

    let evUpdated = 0;
    for (const wf of orderedFights) {
      const wn1 = norm(wf.f1), wn2 = norm(wf.f2);
      // Try direct match, then NAME_MAP, then last-name fallback
      let dbFight = pairToFight[wn1 + ':' + wn2] || pairToFight[wn2 + ':' + wn1];
      if (!dbFight) {
        const m1 = NAME_MAP[wn1] || wn1, m2 = NAME_MAP[wn2] || wn2;
        dbFight = pairToFight[m1 + ':' + m2] || pairToFight[m2 + ':' + m1];
      }
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
      if (dbFight.bout_order === wf.boutOrder && dbFight.card_position === wf.cardPosition) continue;

      if (!DRY) {
        const { error } = await supabase.from('fights')
          .update({ bout_order: wf.boutOrder, card_position: wf.cardPosition })
          .eq('id', dbFight.id);
        if (error) { console.error(`  Update error ${dbFight.id}: ${error.message}`); continue; }
        // Update local cache too
        dbFight.bout_order   = wf.boutOrder;
        dbFight.card_position = wf.cardPosition;
      }
      evUpdated++;
    }

    if (evUpdated > 0) {
      eventsUpdated++;
      fightsUpdated += evUpdated;
      process.stdout.write('.');
    } else {
      process.stdout.write('-');
    }
  }

  console.log(`\n  Phase 1 done: ${eventsUpdated} events updated, ${fightsUpdated} fights updated`);
}

// ── phase 2: gap-fill remaining conflicts ─────────────────────────────────────

async function phase2(allFights) {
  console.log('\n── Phase 2: Gap-fill remaining conflicts ───────────────────────────────────\n');

  const conflicts = findConflicts(allFights);
  if (!conflicts.length) { console.log('  No conflicts remaining — nothing to do.'); return 0; }

  // Group by event+section to get the full picture
  const sections = {};
  allFights.forEach(f => {
    if (f.bout_order == null || !f.card_position) return;
    const key = `${f.event_id}|${f.card_position}`;
    if (!sections[key]) sections[key] = [];
    sections[key].push(f);
  });

  let fixed = 0;
  const conflictKeys = new Set(conflicts.map(g => `${g[0].event_id}|${g[0].card_position}`));

  for (const sKey of conflictKeys) {
    const sectionFights = sections[sKey];
    if (!sectionFights) continue;

    // Sort by current bout_order; ties broken by id (deterministic)
    sectionFights.sort((a, b) => a.bout_order - b.bout_order || a.id.localeCompare(b.id));

    const N = sectionFights.length;
    const min = sectionFights[0].bout_order;
    const expected = Array.from({ length: N }, (_, i) => min + i);
    const actual   = sectionFights.map(f => f.bout_order);

    // Find gaps and duplicates
    const actualSet  = new Set(actual);
    const gaps       = expected.filter(v => !actualSet.has(v));
    const dupMap     = {};
    actual.forEach(v => { dupMap[v] = (dupMap[v] || 0) + 1; });
    const dupPositions = Object.keys(dupMap).filter(v => dupMap[v] > 1).map(Number).sort((a,b)=>a-b);

    if (!gaps.length || !dupPositions.length) continue;

    // For each duplicate position, pick the LAST fight (highest id sort) as "the one to move"
    let gapIdx = 0;
    for (const dupPos of dupPositions) {
      const dupes = sectionFights.filter(f => f.bout_order === dupPos);
      // The fight to move: higher id (arbitrary but deterministic)
      dupes.sort((a, b) => a.id.localeCompare(b.id));
      const toMove = dupes[dupes.length - 1]; // last one alphabetically
      const newBO  = gaps[gapIdx++];
      if (newBO == null) break;

      if (DRY) {
        console.log(`  [DRY] ${sKey.split('|')[0].slice(0,8)} ${sKey.split('|')[1]} bo=${dupPos} → ${newBO}  fight ${toMove.id.slice(0,8)}`);
      } else {
        const { error } = await supabase.from('fights')
          .update({ bout_order: newBO })
          .eq('id', toMove.id);
        if (error) { console.error(`  Update error ${toMove.id}: ${error.message}`); continue; }
        toMove.bout_order = newBO; // update local cache
      }
      fixed++;
    }
  }

  console.log(`  Phase 2 done: ${fixed} fights reassigned`);
  return fixed;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  UFCDB — Fix Bout-Order Conflicts        ║');
  if (DRY) console.log('║  *** DRY RUN — no writes ***             ║');
  if (ONLY1) console.log('║  Phase 1 only (Wikipedia re-match)       ║');
  if (ONLY2) console.log('║  Phase 2 only (gap-fill)                 ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log('Loading DB data...');
  const allFights  = await loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, bout_order, card_position, created_at');
  const allFighters = await loadAll('fighters', 'id, first_name, last_name');
  const allEvents   = await loadAll('events', 'id, name, date, slug');
  console.log(`  ${allFights.length} fights, ${allFighters.length} fighters, ${allEvents.length} events\n`);

  const fighterById = Object.fromEntries(allFighters.map(f => [f.id, f]));
  const evMap       = Object.fromEntries(allEvents.map(e => [e.id, e]));

  // Find conflict events (excluding May-28 phantoms)
  const isPhantom = f => f.created_at >= '2026-05-28' && f.created_at < '2026-05-29';
  const conflicts  = findConflicts(allFights.filter(f => !isPhantom(f)));
  const conflictEventIds = [...new Set(conflicts.map(g => g[0].event_id))];
  console.log(`Found ${conflicts.length} conflicts across ${conflictEventIds.length} events\n`);

  if (!conflicts.length) {
    console.log('No conflicts to fix!');
    return;
  }

  if (RUN1) {
    // Fetch Wikipedia event list
    console.log('Fetching Wikipedia event list...');
    let wikiEventList = [];
    try {
      const { data } = await http.get(WIKI + '/wiki/List_of_UFC_events');
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
            if (dateStr) { seen.add(href); wikiEventList.push({ name: a.text().trim(), date: dateStr, wikiUrl: WIKI + href }); }
            break;
          }
        });
      });
    } catch (e) { console.error('  Error fetching Wikipedia list:', e.message); }
    console.log(`  ${wikiEventList.length} Wikipedia events found\n`);

    await phase1(conflictEventIds, allFights, fighterById, evMap, wikiEventList);
  }

  if (RUN2) {
    // Reload fights after phase1 updates
    const freshFights = RUN1
      ? await loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, bout_order, card_position, created_at')
      : allFights;
    await phase2(freshFights);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
