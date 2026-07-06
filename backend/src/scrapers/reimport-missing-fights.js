/**
 * reimport-missing-fights.js — Restore fights (and fighters) lost from the May 2026 seed
 *
 * Sweeps every past event, fetches its Wikipedia card, and finds fights that are
 * on Wikipedia but missing from the DB (primarily the lost V-surname fighters).
 * For each missing fight:
 *   - resolves both fighters against the existing roster (exact / token-set /
 *     containment normalized matching — same logic validated by audit-wiki-sample.js)
 *   - creates fighter rows that don't exist (name + slug only; records get
 *     rebuilt by fix-fighter-records.js, status by fix-fighter-status.js)
 *   - inserts the fight with winner-first convention, normalized method,
 *     round/time, weight class, title flags, and card_position
 * Events that gain fights and whose other fights all matched a wiki row get
 * their bout_order renumbered from the wiki card order (repairs the gaps the
 * deletions left). Ambiguous name matches are skipped and logged for review.
 *
 * Flags: --dry-run · --apply · --event "<name substring>" · --limit N (events)
 * Usage: node -r dotenv/config src/scrapers/reimport-missing-fights.js --dry-run
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const supabase = require('../db/client');

const DRY = !process.argv.includes('--apply');
const EVARG = (() => { const i = process.argv.indexOf('--event'); return i > -1 ? process.argv[i + 1] : null; })();
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1]) : Infinity; })();
const OFFSET = (() => { const i = process.argv.indexOf('--offset'); return i > -1 ? parseInt(process.argv[i + 1]) : 0; })();
const LOGFILE = (() => { const i = process.argv.indexOf('--log'); return i > -1 ? process.argv[i + 1] : 'reimport-log.json'; })();
const DELAY = 1200;
const TODAY = new Date().toISOString().split('T')[0];
const WIKI_BASE = 'https://en.wikipedia.org';

const http = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
const tokenKey = s => (s || '').trim().split(/\s+/).map(norm).filter(Boolean).sort().join('-');

function headlinerKey(name) {
  const colon = name.indexOf(':');
  const hl = colon >= 0 ? name.slice(colon + 1) : name;
  return hl.split(/\s+vs\.?\s+/i).map(p => norm(p)).sort().join(':');
}

// Same normalization as fix-fight-methods.js
function parseMethod(raw) {
  if (!raw) return { method: null, method_detail: null };
  const parenMatch = raw.match(/^(.+?)\s*\((.+)\)$/);
  const base = parenMatch ? parenMatch[1].trim() : raw.trim();
  const detail = parenMatch ? parenMatch[2].trim() : '';
  const baseUp = base.toUpperCase();
  let method;
  if      (baseUp === 'TKO' || baseUp.includes('TECHNICAL KNOCKOUT')) method = 'KO/TKO';
  else if (baseUp === 'KO' || baseUp.includes('KNOCKOUT'))            method = 'KO/TKO';
  else if (baseUp.includes('SUBMISSION') || baseUp === 'SUB')         method = 'SUB';
  else if (baseUp.includes('UNANIMOUS'))                               method = 'U-DEC';
  else if (baseUp.includes('SPLIT'))                                   method = 'S-DEC';
  else if (baseUp.includes('MAJORITY'))                                method = 'M-DEC';
  else if (baseUp.includes('DRAW'))                                    method = 'Draw';
  else if (baseUp.includes('DECISION'))                                method = 'DEC';
  else if (baseUp.includes('DISQUALIF') || baseUp === 'DQ')           method = 'DQ';
  else if (baseUp.includes('NO CONTEST') || baseUp === 'NC')          method = 'NC';
  else if (baseUp.includes('OVERTURNED'))                              method = 'Overturned';
  else if (baseUp === 'CNC' || baseUp.includes('CANNOT CONTINUE'))    method = 'CNC';
  else method = base;
  // Wikipedia writes "Decision (unanimous)" — lift the decision type out of the detail
  if (method === 'DEC' && detail) {
    const d = detail.toLowerCase();
    if (d.startsWith('unanimous')) method = 'U-DEC';
    else if (d.startsWith('split')) method = 'S-DEC';
    else if (d.startsWith('majority')) method = 'M-DEC';
  }
  const detailClean = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : null;
  return { method, method_detail: detailClean || null };
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
        const m = $(cell).text().trim().match(/(\w+ \d{1,2},? \d{4})/);
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

async function fetchWikiCard(wikiUrl) {
  await sleep(DELAY);
  const { data } = await http.get(wikiUrl);
  const $ = cheerio.load(data);
  const rows = [];
  let section = null;
  let tableIdx = -1;
  $('table.toccolours, table.wikitable').each((_, table) => {
    if (!isFightCard($, table)) return;
    tableIdx++;
    $(table).find('tr').each((_, row) => {
      const $row = $(row);
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
      const f1raw = $(cells[sepIdx - 1]).text();
      const f2raw = $(cells[sepIdx + 1]).text();
      const f1 = clean(cells[sepIdx - 1]);
      const f2 = clean(cells[sepIdx + 1]);
      if (!f1 || !f2) return;
      const wcText = sepIdx >= 2 ? $(cells[0]).text().replace(/\[\w+\]/g, '').trim() : '';
      const methodRaw = cells.length > sepIdx + 2 ? clean(cells[sepIdx + 2]) : '';
      const roundRaw = cells.length > sepIdx + 3 ? clean(cells[sepIdx + 3]) : '';
      const timeRaw = cells.length > sepIdx + 4 ? clean(cells[sepIdx + 4]) : '';
      const champMarker = /\(c\)/i.test(f1raw + f2raw);
      const interimMarker = /\(ic\)/i.test(f1raw + f2raw);
      rows.push({
        tableIdx,
        section, f1, f2, sep,
        weightClass: wcText,
        isTitle: /championship/i.test(wcText) || champMarker || interimMarker,
        isInterim: /interim/i.test(wcText) || interimMarker,
        methodRaw,
        round: parseInt(roundRaw) || null,
        time: (timeRaw.match(/\d+:\d{2}/) || [null])[0],
      });
    });
  });
  return rows;
}

async function main() {
  console.log(`Re-import missing fights from Wikipedia ${DRY ? '*** DRY RUN ***' : '*** APPLY ***'}\n`);

  const events = await loadAll('events', 'id, name, date');
  const fighters = await loadAll('fighters', 'id, first_name, last_name, slug');
  const fights = await loadAll('fights',
    'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, bout_order, card_position');
  const weightClasses = await loadAll('weight_classes', 'id, name');
  console.log(`Loaded ${events.length} events, ${fighters.length} fighters, ${fights.length} fights\n`);

  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const fullName = f => `${f.first_name} ${f.last_name}`;
  const fname = id => fighterById[id] ? fullName(fighterById[id]) : '<missing>';

  // global name indexes for fighter resolution
  const byNorm = {}, byToken = {};
  const indexFighter = f => {
    const n = norm(fullName(f));
    (byNorm[n] = byNorm[n] || []).push(f);
    const t = tokenKey(fullName(f));
    (byToken[t] = byToken[t] || []).push(f);
  };
  fighters.forEach(indexFighter);
  const slugs = new Set(fighters.map(f => f.slug));

  // Known Wikipedia-name → DB-name variants (nicknames / spelling differences)
  const ALIASES = {
    tankabbott: 'davidabbott',
    bobbygreen: 'kinggreen',
    mattriddle: 'matthewriddle',
    phildefries: 'philipdefries',
    johnolaveinemo: 'jonolaveinemo',
    criscyborg: 'cristianejustino',
    yanakunitskaya: 'yanasantos',
    kangkyungho: 'kyunghokang',
    teciatorres: 'teciapennington',
    veronicamacedo: 'veronicahardy',
    marcosrosamariano: 'marcosmariano',
    briannavanburen: 'briannafortino',
    nicomusoke: 'nicholasmusoke',
    josephduffy: 'joeduffy',
    saparbeksafarov: 'saparbegsafarov',
    juanpuig: 'juanmanuelpuig',
    liviarenatasouza: 'livinhasouza',
    juniorhernandez: 'ramirohernandez',
    // June 2026: variants that slipped past the fight-matcher and created duplicates
    philiprowe: 'philrowe',
    brunogustavodasilva: 'brunosilva',
    kirusinghsahota: 'kirusahota',
    timothycuamba: 'timmycuamba',
    yizha: 'yizhayizha',
    charlieradtke: 'charlesradtke',
    mikemathetha: 'blooddiamond',
    alexanderromanov: 'alexandrromanov',
    montserratruiz: 'montserratconejoruiz',
    rongzhu: 'rongzhurongzhu',
  };

  // resolve a wiki name to an existing fighter, 'create', or 'ambiguous'
  function resolveFighter(name) {
    let n = norm(name);
    n = ALIASES[n] || n;
    let c = byNorm[n] || [];
    if (c.length === 1) return { fighter: c[0] };
    if (c.length > 1) return { ambiguous: c };
    c = byToken[tokenKey(name)] || [];
    if (c.length === 1) return { fighter: c[0] };
    if (c.length > 1) return { ambiguous: c };
    // containment (renames like Waterson → Waterson-Gomez); require length to avoid noise
    if (n.length >= 9) {
      const cont = fighters.filter(f => {
        const fn = norm(fullName(f));
        return fn.length >= 9 && (fn.includes(n) || n.includes(fn));
      });
      if (cont.length === 1) return { fighter: cont[0] };
      if (cont.length > 1) return { ambiguous: cont };
    }
    return { create: true };
  }

  const wcByNorm = {};
  weightClasses.forEach(w => { wcByNorm[norm(w.name)] = w.id; });
  function resolveWeightClass(text) {
    if (!text) return null;
    const t = norm(text.replace(/championship|interim|title|bout|ufc/gi, ''));
    if (wcByNorm[t]) return wcByNorm[t];
    for (const [wn, id] of Object.entries(wcByNorm)) {
      if (t.includes(wn) || wn.includes(t)) return id;
    }
    return null;
  }

  const fightsByEvent = {};
  fights.forEach(f => { (fightsByEvent[f.event_id] = fightsByEvent[f.event_id] || []).push(f); });

  console.log('Fetching Wikipedia event list...');
  const wikiEvents = await fetchWikiEventList();
  const wikiByNorm = {};
  wikiEvents.forEach(we => { wikiByNorm[norm(we.name)] = we; });
  const dateClose = (a, b) => Math.abs(new Date(a) - new Date(b)) <= 2 * 86400000;
  console.log(`  ${wikiEvents.length} wiki events\n`);

  let targets = events
    .filter(e => e.date < TODAY && (fightsByEvent[e.id] || []).length > 0)
    .filter(e => !EVARG || e.name.toLowerCase().includes(EVARG.toLowerCase()))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(OFFSET, OFFSET + LIMIT);
  console.log(`Sweeping ${targets.length} past events...\n`);

  const log = { newFighters: [], newFights: [], ambiguous: [], noWiki: [], renumbered: [], errors: [] };
  let processed = 0;

  // queue of fighter rows to create (dedup by norm name across events)
  const pendingCreate = {}; // normName -> {first_name,last_name,slug}
  const createdIds = {};    // normName -> id (after insert)

  function planCreate(name) {
    const n = norm(name);
    if (pendingCreate[n]) return pendingCreate[n];
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    const last = parts.slice(1).join(' ') || first;
    let slug = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[łŁ]/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let s = slug, i = 2;
    while (slugs.has(s)) s = `${slug}-${i++}`;
    slugs.add(s);
    pendingCreate[n] = { first_name: first, last_name: last, slug: s, _wikiName: name };
    return pendingCreate[n];
  }

  async function fighterIdFor(name) {
    const n = norm(name);
    if (createdIds[n]) return createdIds[n];
    const plan = pendingCreate[n];
    if (!plan) return null;
    if (DRY) { createdIds[n] = `dry-${n}`; return createdIds[n]; }
    const { data, error } = await supabase.from('fighters')
      .insert({ first_name: plan.first_name, last_name: plan.last_name, slug: plan.slug, status: 'retired' })
      .select('id').single();
    if (error) throw new Error(`insert fighter ${name}: ${error.message}`);
    createdIds[n] = data.id;
    const row = { id: data.id, first_name: plan.first_name, last_name: plan.last_name, slug: plan.slug };
    fighterById[data.id] = row;
    indexFighter(row);
    return data.id;
  }

  for (const ev of targets) {
    processed++;
    const evLabel = `${ev.name} (${ev.date})`;

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
      we = wikiEvents.find(w => headlinerKey(w.name) === hk && dateClose(w.date, ev.date)) || null;
    }
    if (!we) {
      const sameDate = wikiEvents.filter(w => w.date === ev.date);
      if (sameDate.length === 1) we = sameDate[0];
    }
    if (!we) { log.noWiki.push(evLabel); continue; }

    let wikiRows;
    try { wikiRows = await fetchWikiCard(we.wikiUrl); }
    catch (e) { log.errors.push(`${evLabel}: fetch failed (${e.message})`); continue; }
    if (!wikiRows.length) { log.noWiki.push(evLabel + ' [no parseable card]'); continue; }

    const dbFights = fightsByEvent[ev.id] || [];

    // Per-table overlap guard: some minor events were merged into combined
    // series articles, so a fetched page can contain other events' result
    // tables. Keep only tables where at least one row matches a DB fight of
    // THIS event; drop foreign tables (zero overlap).
    {
      // Pair-level overlap only — name-level overlap is unsafe because two
      // fighters can each appear at this event AND face each other at a
      // sibling event in the same combined article (Means/Salas, 2012).
      const pairSet = new Set(), tokenSet = new Set();
      for (const f of dbFights) {
        const a = norm(fname(f.fighter1_id)), b = norm(fname(f.fighter2_id));
        pairSet.add([a, b].sort().join(':'));
        tokenSet.add([tokenKey(fname(f.fighter1_id)), tokenKey(fname(f.fighter2_id))].sort().join(':'));
      }
      const tables = {};
      wikiRows.forEach(r => { (tables[r.tableIdx] = tables[r.tableIdx] || []).push(r); });
      const kept = [];
      let dropped = 0;
      for (const [tIdx, group] of Object.entries(tables)) {
        const overlap = group.filter(r =>
          pairSet.has([norm(r.f1), norm(r.f2)].sort().join(':')) ||
          tokenSet.has([tokenKey(r.f1), tokenKey(r.f2)].sort().join(':'))
        ).length;
        if (process.env.GUARD_DEBUG) console.log(`    [guard] table ${tIdx}: ${group.length} rows, overlap ${overlap} — first: ${group[0].f1} ${group[0].sep} ${group[0].f2}`);
        if (overlap > 0) kept.push(...group);
        else dropped += group.length;
      }
      if (dropped) log.errors.push(`${evLabel}: dropped ${dropped} foreign wiki rows (combined series article)`);
      if (!kept.length) { log.noWiki.push(evLabel + ' [no table overlaps DB fights]'); continue; }
      wikiRows = kept;
    }
    const dbByPair = {}, dbByTokenPair = {};
    for (const f of dbFights) {
      const k = [norm(fname(f.fighter1_id)), norm(fname(f.fighter2_id))].sort().join(':');
      (dbByPair[k] = dbByPair[k] || []).push(f);
      const tk = [tokenKey(fname(f.fighter1_id)), tokenKey(fname(f.fighter2_id))].sort().join(':');
      (dbByTokenPair[tk] = dbByTokenPair[tk] || []).push(f);
    }
    const lastNameKey = s => norm(s.trim().split(/\s+/).pop());
    const matchedDb = new Set();
    const seenPairs = new Set(); // resolved fighter-pair keys already accounted (catches duplicate wiki listings)
    const pick = (list, wr) => {
      const avail = (list || []).filter(f => !matchedDb.has(f.id));
      if (!avail.length) return null;
      const want = wr.sep === 'def' ? 'win' : wr.sep === 'drew' ? 'draw' : null;
      return avail.find(f => want && f.result === want) || avail[0];
    };

    const rowMatch = []; // per wiki row: matched fight | planned insert | null
    const missing = [];

    for (const wr of wikiRows) {
      let dbf = pick(dbByPair[[norm(wr.f1), norm(wr.f2)].sort().join(':')], wr);
      if (!dbf) dbf = pick(dbByTokenPair[[tokenKey(wr.f1), tokenKey(wr.f2)].sort().join(':')], wr);
      if (!dbf) {
        // Alias/variant/mononym-aware match: resolve both wiki names to existing
        // fighter rows (same logic used for fighter creation — applies ALIASES,
        // token, containment) and look for an existing fight between those two ids.
        // Without this, a fight already in the DB under a different name (alias
        // target, mononym, spelling variant) is treated as missing and duplicated.
        // candidate-aware: an alias target may resolve to multiple rows (e.g. two
        // "Bruno Silva"s); try every candidate pair against existing fights.
        const r1 = resolveFighter(wr.f1), r2 = resolveFighter(wr.f2);
        const c1 = r1.fighter ? [r1.fighter] : (r1.ambiguous || []);
        const c2 = r2.fighter ? [r2.fighter] : (r2.ambiguous || []);
        for (const x of c1) { for (const y of c2) {
          const hit = dbFights.find(f => !matchedDb.has(f.id) &&
            ((f.fighter1_id === x.id && f.fighter2_id === y.id) || (f.fighter1_id === y.id && f.fighter2_id === x.id)));
          if (hit) { dbf = hit; break; }
        } if (dbf) break; }
      }
      if (!dbf) {
        const w1 = norm(wr.f1), w2 = norm(wr.f2);
        const hits = dbFights.filter(f => {
          if (matchedDb.has(f.id)) return false;
          const a = norm(fname(f.fighter1_id)), b = norm(fname(f.fighter2_id));
          return a === w1 || b === w1 || a === w2 || b === w2;
        });
        if (hits.length === 1) dbf = hits[0];
      }
      if (!dbf) {
        const w1 = lastNameKey(wr.f1), w2 = lastNameKey(wr.f2);
        for (const f of dbFights) {
          if (matchedDb.has(f.id)) continue;
          const a = norm(fname(f.fighter1_id)), b = norm(fname(f.fighter2_id));
          if ((a.endsWith(w1) && b.endsWith(w2)) || (a.endsWith(w2) && b.endsWith(w1))) { dbf = f; break; }
        }
      }
      if (dbf) {
        matchedDb.add(dbf.id);
        seenPairs.add([dbf.fighter1_id, dbf.fighter2_id].sort().join(':'));
        rowMatch.push({ wr, dbf });
        continue;
      }
      // Duplicate Wikipedia listing of an already-matched bout (same fight shown in
      // two tables — e.g. an NC that was later overturned) — skip, don't re-insert.
      const sr1 = resolveFighter(wr.f1), sr2 = resolveFighter(wr.f2);
      const sc1 = sr1.fighter ? [sr1.fighter] : (sr1.ambiguous || []);
      const sc2 = sr2.fighter ? [sr2.fighter] : (sr2.ambiguous || []);
      if (sc1.some(x => sc2.some(y => seenPairs.has([x.id, y.id].sort().join(':'))))) {
        rowMatch.push({ wr, dupListing: true });
        continue;
      }
      missing.push(wr);
      rowMatch.push({ wr, insert: true });
    }

    // plan inserts for missing fights
    const plannedInserts = [];
    for (const wr of missing) {
      const r1 = resolveFighter(wr.f1);
      const r2 = resolveFighter(wr.f2);
      if (r1.ambiguous || r2.ambiguous) {
        const amb = r1.ambiguous ? wr.f1 : wr.f2;
        const cands = (r1.ambiguous || r2.ambiguous).map(f => `${fullName(f)} ${f.id.slice(0, 8)}`).join(' | ');
        log.ambiguous.push(`${evLabel}: ${wr.f1} ${wr.sep} ${wr.f2} — '${amb}' matches multiple: ${cands}`);
        continue;
      }
      if (r1.create) { planCreate(wr.f1); log.newFighters.push(`${wr.f1}  (first seen: ${evLabel})`); }
      if (r2.create) { planCreate(wr.f2); log.newFighters.push(`${wr.f2}  (first seen: ${evLabel})`); }

      const { method, method_detail } = parseMethod(wr.methodRaw);
      let result, winnerName = null;
      if (wr.sep === 'def') { result = 'win'; winnerName = wr.f1; }
      else if (wr.sep === 'drew' || method === 'Draw') result = 'draw';
      else if (['NC', 'CNC', 'Overturned'].includes(method)) result = 'no_contest';
      else result = 'win', winnerName = wr.f1;

      plannedInserts.push({ wr, r1, r2, result, winnerName, method, method_detail });
      log.newFights.push(`${evLabel}: ${wr.f1} ${wr.sep} ${wr.f2} → ${method || '?'}${wr.round ? ' R' + wr.round : ''}${wr.time ? ' ' + wr.time : ''}${wr.isTitle ? ' [title]' : ''} (${wr.section || 'no section'})`);
    }

    // execute inserts
    const newFightIds = {};
    for (const p of plannedInserts) {
      const id1 = p.r1.create ? await fighterIdFor(p.wr.f1) : p.r1.fighter.id;
      const id2 = p.r2.create ? await fighterIdFor(p.wr.f2) : p.r2.fighter.id;
      // convention: fighter1 = winner on wins (wiki lists winner first)
      const row = {
        event_id: ev.id,
        fighter1_id: id1,
        fighter2_id: id2,
        winner_id: p.result === 'win' ? id1 : null,
        result: p.result,
        method: p.method,
        method_detail: p.method_detail,
        round: p.wr.round,
        time: p.wr.time,
        weight_class_id: resolveWeightClass(p.wr.weightClass),
        is_title_fight: !!p.wr.isTitle,
        is_interim_title: !!p.wr.isInterim,
        card_position: p.wr.section,
      };
      if (DRY) { newFightIds[p.wr.f1 + ':' + p.wr.f2] = 'dry'; continue; }
      const { data, error } = await supabase.from('fights').insert(row).select('id').single();
      if (error) { log.errors.push(`${evLabel}: insert ${p.wr.f1} vs ${p.wr.f2} failed: ${error.message}`); continue; }
      newFightIds[p.wr.f1 + ':' + p.wr.f2] = data.id;
    }

    // renumber bout_order from wiki card order when the whole card is accounted for
    const inserted = plannedInserts.filter(p => newFightIds[p.wr.f1 + ':' + p.wr.f2]);
    const unmatchedDb = dbFights.filter(f => !matchedDb.has(f.id) && f.result !== 'upcoming');
    if (inserted.length && unmatchedDb.length === 0 && rowMatch.length === wikiRows.length) {
      const skippedRows = new Set(missing.filter(m => !plannedInserts.some(p => p.wr === m)));
      if (!skippedRows.size) {
        let bo = 0;
        const updates = [];
        for (const rm of rowMatch) {
          const fid = rm.dbf ? rm.dbf.id : newFightIds[rm.wr.f1 + ':' + rm.wr.f2];
          if (!fid) { updates.length = 0; break; }
          updates.push({ id: fid, bout_order: bo, card_position: rm.wr.section || (rm.dbf ? rm.dbf.card_position : null) });
          bo++;
        }
        if (updates.length) {
          if (!DRY) {
            for (const u of updates) {
              const patch = { bout_order: u.bout_order };
              if (u.card_position) patch.card_position = u.card_position;
              const { error } = await supabase.from('fights').update(patch).eq('id', u.id);
              if (error) log.errors.push(`${evLabel}: renumber ${u.id.slice(0, 8)} failed: ${error.message}`);
            }
          }
          log.renumbered.push(`${evLabel}: bout_order renumbered 0..${updates.length - 1}`);
        }
      }
    }

    if (inserted.length || missing.length) {
      console.log(`  [${processed}/${targets.length}] ${evLabel}: +${inserted.length} fights${missing.length - inserted.length ? `, ${missing.length - inserted.length} skipped (ambiguous)` : ''}`);
    } else if (processed % 25 === 0) {
      console.log(`  [${processed}/${targets.length}] ...`);
    }
  }

  console.log('\n================ SUMMARY ================');
  console.log(`Events swept: ${processed}; no wiki match: ${log.noWiki.length}; errors: ${log.errors.length}`);
  console.log(`New fighters ${DRY ? 'planned' : 'created'}: ${Object.keys(pendingCreate).length}`);
  console.log(`New fights ${DRY ? 'planned' : 'inserted'}: ${log.newFights.length}`);
  console.log(`Ambiguous (skipped): ${log.ambiguous.length}`);
  console.log(`Events renumbered: ${log.renumbered.length}`);

  fs.writeFileSync(LOGFILE, JSON.stringify(log, null, 2));
  console.log('\nDetails written to ' + LOGFILE);
  if (!DRY) console.log('\nNOW RUN: fix-fighter-records.js, fix-fighter-status.js, then validate.js');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
