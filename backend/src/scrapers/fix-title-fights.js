/**
 * Backfill is_title_fight / is_interim_title for all events.
 *
 * Phase 1 (pre-2022): Scrapes Wikipedia UFC event pages.
 *   - Fetches https://en.wikipedia.org/wiki/List_of_UFC_events to discover
 *     all event Wikipedia URLs with their dates.
 *   - For each event page, parses fight-card wikitables (class="wikitable").
 *   - A row is a title fight if the weight-class or Notes cell contains
 *     "championship", or a fighter cell has the "(c)" champion marker.
 *   - Interim flag set when "interim" appears in those cells.
 *   Wikipedia reliably marks title bouts and has no bot protection.
 *
 * Phase 2 (2022+): API-Sports headliner matching.
 *   For numbered UFC PPV events, matches the headliner names from the
 *   event slug to identify the main fight and marks it as a title fight.
 *
 * Flags:
 *   --dry-run        Preview changes without writing to DB
 *   --wiki-only      Run Phase 1 (Wikipedia) only
 *   --api-only       Run Phase 2 (API-Sports) only
 *   --year YYYY      Phase 1: process only this calendar year
 *   --event "NAME"   Phase 1: process only events matching this substring
 *   --season YEAR    Phase 2: restrict to this API-Sports season year
 *
 * Usage: node src/scrapers/fix-title-fights.js [flags]
 */
require('dotenv').config();
const axios    = require('axios');
const cheerio  = require('cheerio');
const supabase = require('../db/client');

const DRY       = process.argv.includes('--dry-run');
const WIKI_ONLY = process.argv.includes('--wiki-only');
const API_ONLY  = process.argv.includes('--api-only');

const YEAR_IDX   = process.argv.indexOf('--year');
const EVT_IDX    = process.argv.indexOf('--event');
const SEASON_IDX = process.argv.indexOf('--season');
const YEAR_ARG   = YEAR_IDX   >= 0 ? parseInt(process.argv[YEAR_IDX   + 1]) : null;
const EVT_ARG    = EVT_IDX    >= 0 ? process.argv[EVT_IDX    + 1] : null;
const SEASON_ARG = SEASON_IDX >= 0 ? parseInt(process.argv[SEASON_IDX + 1]) : null;

const KEY      = process.env.API_SPORTS_KEY;
const API_BASE = process.env.API_SPORTS_BASE || 'https://v1.mma.api-sports.io';

const WIKI_BASE = 'https://en.wikipedia.org';
const LIST_URL  = WIKI_BASE + '/wiki/List_of_UFC_events';
const DELAY_MS  = 1200;

const http = axios.create({
  timeout: 25000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -- Shared utilities ---------------------------------------------------------

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[łŁ]/g, 'l')       // ł doesn't decompose under NFD
    .normalize('NFD').replace(/[ÃƒÅ’Ã¢â€šÂ¬-ÃƒÂÃ‚Â¯]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function fixEncoding(s) {
  if (!s) return s;
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

const NAME_MAP = {
  'rongzhu':            'rongzhurongzhu',
  'aoriqileng':         'aoriqilengaoriqileng',
  'alatengheili':       'alatengheilialatengheili',
  'yizha':              'yizhayizha',
  'sumudaerji':         'sumudaerjisumudaerji',
  'maheshate':          'maheshatemaheshate',
  'mizuki':             'mizukimizuki',
  'iangarry':           'ianmachadogarry',
  'markomadsen':        'markmadsen',
  'josemigueldelgado':  'josedelgado',
  'bobbygreen':         'kinggreen',
  'charlieradtke':      'charlesradtke',
  'zachscroggin':       'zacharyscroggin',
  'billygoff':          'billyraygoff',
  'montserratrendon':   'montserendon',
  'daunjung':           'dawoonjung',
  'baysangursusurkaev': 'baisangursusurkaev',
  'assualmabayev':      'asualmabayev',
  'bernardosopaj':      'benardosopaj',
  'raffaelcerqueira':   'rafaelcerqueira',
  'zacharyreese':       'zachreese',
  'kleidisonrodrigues': 'kleydsonrodrigues',
  'teciatorres':        'teciapennington',
  'sulangrangbo':       'sulangrangbosulangrangbo',
  // Cris Cyborg: Wikipedia uses ring name, DB has legal name
  'criscyborg':         'cristianejustino',
};

function lookupFighter(rawName, byName) {
  if (!rawName) return null;
  const cleaned = rawName.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || /^(opponent\s+)?tba$/i.test(cleaned)) return null;

  let id = byName[norm(cleaned)];
  if (id) return id;

  const fixed = fixEncoding(cleaned);
  if (fixed !== cleaned) { id = byName[norm(fixed)]; if (id) return id; }

  const n = norm(cleaned);
  if (NAME_MAP[n]) { id = byName[NAME_MAP[n]]; if (id) return id; }

  const nf = norm(fixed);
  if (nf !== n && NAME_MAP[nf]) { id = byName[NAME_MAP[nf]]; if (id) return id; }

  return null;
}

async function loadAll(table, select) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data } = await supabase.from(table).select(select).range(offset, offset + 999);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

// -- Phase 1: Wikipedia HTML scraper ------------------------------------------

// "July 11, 2009" -> "2009-07-11"
function parseWikiDate(text) {
  const m = text.trim().match(/^([A-Z][a-z]+ \d{1,2}, \d{4})$/);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Scrape List_of_UFC_events -> [{ name, date, wikiUrl }]
async function fetchWikiEventList() {
  console.log('Fetching Wikipedia event list...');
  const { data } = await http.get(LIST_URL);
  const $ = cheerio.load(data);
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
        const parsed = parseWikiDate($(cell).text().trim());
        if (parsed) dateStr = parsed;
      });

      if (dateStr) {
        seen.add(wikiPath);
        events.push({ name: eventName, date: dateStr, wikiUrl: WIKI_BASE + wikiPath });
      }
    });
  });

  console.log(`  Found ${events.length} events in Wikipedia list\n`);
  return events;
}

// True if a <table> element looks like a fight card.
function isFightCard($, table) {
  const ths = $(table).find('th').map((_, th) => $(th).text().toLowerCase().trim()).get();
  const h   = ths.join('|');
  // Exclude year-in-review championship tables (e.g., 'Title fights in 2013')
  if (/title fights in \d{4}/i.test(ths[0] || '')) return false;
  if (/current (?:ufc )?champions/i.test(ths[0] || '')) return false;
  // Exclude large tables -- fight card sections have ≤12 fights; champion navboxes have many more
  const dataRows = $(table).find('tr').filter((_, tr) => $(tr).find('td').length > 0).length;
  if (dataRows > 16) return false;
  return (h.includes('weight') || h.includes('class')) &&
         (h.includes('method') || h.includes('round') || h.includes('time'));
}

// Extract clean fighter name from a table cell.
// Prefers the first Wikipedia-linked name; strips role annotations like "(c)".
function cellFighterName($, cell) {
  const a = $(cell).find('a[href^="/wiki/"], a[href*="//en.wikipedia.org/wiki/"]').first();
  const raw = a.length ? a.text() : $(cell).text();
  return raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// True if text explicitly signals a title fight.
// NOTE: "\bfor the\b" was previously used but caused false positives on phrases
// like "for the #1 contender" or "for a shot at the title". Now requires
// "championship" to be present in the text.
function isTitleText(text) {
  const t = text.toLowerCase();
  return t.includes('championship');
}

// Fetch and parse title fights from a Wikipedia event page.
// Returns [{ fighter1, fighter2, isInterim }]
async function fetchTitleFights(wikiUrl) {
  let html;
  try {
    const res = await http.get(wikiUrl);
    html = res.data;
  } catch (e) {
    const status = e.response?.status || 'ERR';
    console.log(`    ${status}: ${wikiUrl}`);
    return [];
  }

  const $ = cheerio.load(html);
  const results = [];

  $('table.toccolours, table.wikitable').each((_, table) => {
    if (!isFightCard($, table)) return;

    // Parse footnotes from the div immediately after this table.
    // Wikipedia uses "^ For the interim UFC ... Championship." etc.
    const footnotes = {};
    $(table).nextAll('div').first().text().split('^').slice(1).forEach((part, i) => {
      footnotes[String.fromCharCode(97 + i)] = part.trim().toLowerCase();
    });

    $(table).find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;

      const weightText = $(cells[0]).text();
      const notesText  = $(cells[cells.length - 1]).text();
      const rowHtml    = $(row).html() || '';

      // Resolve footnote text for this row (e.g. "[a]" -> footnotes['a'])
      const footRef  = notesText.match(/\[([a-z])\]/i);
      const footText = footRef ? (footnotes[footRef[1].toLowerCase()] || '') : '';

      // Title signals: "championship" in weight/notes, "(c)"/"(ic)" in row, or footnote says "championship"/"title"
      const titleByText     = isTitleText(weightText) || isTitleText(notesText);
      const titleByChampion = /\(i?c\)/i.test(rowHtml);
      // Require 'for the ... championship' phrasing — avoids 'earns a title shot' or 'after the X Championship bout'
      const titleByFoot     = /for the\b[^.]*\bchampionship/i.test(footText);
      if (!titleByText && !titleByChampion && !titleByFoot) return;

      // isInterim: weight/notes text says "interim", or footnote says "interim"
      const isInterim = /interim/i.test(weightText) || /interim/i.test(notesText) || (titleByFoot && /interim/i.test(footText));

      // Determine column layout:
      // 8-col: weight | f1 | "def."/"vs." | f2 | method | round | time | notes
      // 7-col: weight | f1 | f2 | method | round | time | notes
      let f1 = '', f2 = '';
      if (cells.length >= 8) {
        const mid = $(cells[2]).text().replace(/\W/g, '').toLowerCase();
        if (mid === 'def' || mid === 'vs' || mid === '') {
          f1 = cellFighterName($, cells[1]);
          f2 = cellFighterName($, cells[3]);
        } else {
          f1 = cellFighterName($, cells[1]);
          f2 = cellFighterName($, cells[2]);
        }
      } else {
        f1 = cellFighterName($, cells[1]);
        f2 = cells.length > 2 ? cellFighterName($, cells[2]) : '';
      }

      // Fallback: collect Wikipedia-linked person names from the row
      if (!f1 || !f2 || f1 === f2 || f1.length < 3 || f2.length < 3) {
        const names = [];
        $(row).find('a[href^="/wiki/"], a[href*="//en.wikipedia.org/wiki/"]').each((_, a) => {
          const href = $(a).attr('href') || '';
          const text = $(a).text().replace(/\s*\([^)]*\)\s*/g, '').trim();
          if (!text || text.length < 3) return;
          if (/UFC_\d|Fight_Night_\d|Championship|weight.*class|Mixed_martial|List_of|Template:|Category:/i.test(href)) return;
          if (/^(def\.|vs\.|UFC|Interim|Championship|Weight|Title|For\s)/i.test(text)) return;
          if (!names.includes(text)) names.push(text);
        });
        if (names.length >= 2) { [f1, f2] = names; }
      }

      f1 = (f1 || '').trim();
      f2 = (f2 || '').trim();
      if (!f1 || !f2 || f1 === f2) return;
      if (/^(def\.|vs\.)$/i.test(f1) || /^(def\.|vs\.)$/i.test(f2)) return;
      if (f1.length < 3 || f2.length < 3) return;

      results.push({ fighter1: f1, fighter2: f2, isInterim });
    });
  });

  // Deduplicate by normed fighter pair (same fight can appear in multiple card sections)
  const seen = new Set();
  return results.filter(tf => {
    const key = [norm(tf.fighter1), norm(tf.fighter2)].sort().join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runWikipediaPhase(byName, fightMap, dbEvents) {
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬â€');
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Phase 1: Wikipedia (pre-2022)           ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ');
  if (DRY) console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Mode: DRY RUN                           ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ');
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã…Â¡ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â\n');

  const wikiEvents = await fetchWikiEventList();

  let batch = [...wikiEvents];
  if (YEAR_ARG) batch = batch.filter(e => e.date.startsWith(String(YEAR_ARG)));
  if (EVT_ARG)  batch = batch.filter(e => e.name.toLowerCase().includes(EVT_ARG.toLowerCase()));

  const scope = [
    YEAR_ARG ? `year ${YEAR_ARG}` : null,
    EVT_ARG  ? `matching "${EVT_ARG}"` : null,
  ].filter(Boolean).join(', ') || 'all events';
  console.log(`Processing ${batch.length} events (${scope})...\n`);

  let found = 0, updated = 0, alreadySet = 0, noMatch = 0;
  const missed = [];

  for (const wikiEv of batch) {
    // Match DB event by date (+-1 day tolerance for UTC offset)
    let dbEvent = dbEvents.byDate[wikiEv.date];
    if (!dbEvent) {
      const d    = new Date(wikiEv.date + 'T12:00:00Z');
      const prev = new Date(d); prev.setUTCDate(prev.getUTCDate() - 1);
      const next = new Date(d); next.setUTCDate(next.getUTCDate() + 1);
      dbEvent = dbEvents.byDate[prev.toISOString().slice(0, 10)]
             || dbEvents.byDate[next.toISOString().slice(0, 10)];
    }
    if (!dbEvent) continue; // Not in DB (TUF finale, WEC event, etc.) -- skip silently

    await sleep(DELAY_MS);
    console.log(`-- ${wikiEv.name} (${wikiEv.date})`);

    const titleFights = await fetchTitleFights(wikiEv.wikiUrl);

    if (!titleFights.length) {
      console.log('   (no title fights detected on page)');
      continue;
    }

    for (const tf of titleFights) {
      const f1Id = lookupFighter(tf.fighter1, byName);
      const f2Id = lookupFighter(tf.fighter2, byName);

      if (!f1Id || !f2Id) {
        const msg = `${wikiEv.name}: "${tf.fighter1}" vs "${tf.fighter2}" -- no DB match`;
        console.log(`   ! ${msg}`);
        missed.push(msg);
        noMatch++;
        continue;
      }

      const key      = `${dbEvent.id}:${[f1Id, f2Id].sort().join(':')}`;
      const existing = fightMap[key];

      if (!existing) {
        const msg = `${wikiEv.name}: fight not in DB -- "${tf.fighter1}" vs "${tf.fighter2}"`;
        console.log(`   ! ${msg}`);
        missed.push(msg);
        noMatch++;
        continue;
      }

      found++;
      const label = tf.isInterim ? 'Interim Title' : 'Title Fight';

      if (existing.is_title_fight && existing.is_interim_title === tf.isInterim) {
        alreadySet++;
        console.log(`   = Already: ${label} -- ${tf.fighter1} vs ${tf.fighter2}`);
        continue;
      }

      console.log(`   + ${label}: ${tf.fighter1} vs ${tf.fighter2}`);

      if (!DRY) {
        const { error } = await supabase
          .from('fights')
          .update({ is_title_fight: true, is_interim_title: tf.isInterim })
          .eq('id', existing.id);
        if (error) console.error(`     DB error: ${error.message}`);
        else updated++;
      } else {
        updated++;
      }
    }
  }

  console.log(`\n  Phase 1 complete -- found: ${found}  updated: ${updated}  already correct: ${alreadySet}  unmatched: ${noMatch}`);

  if (missed.length) {
    console.log(`\n  Unmatched (${missed.length}):`);
    for (const m of missed.slice(0, 25)) console.log(`    ` + m);
    if (missed.length > 25) console.log(`    ... and ${missed.length - 25} more`);
  }

  return { found, updated, alreadySet, noMatch };
}

// -- Phase 2: API-Sports headliner matching (2022+) ---------------------------

// PPV numbered events whose main event is NOT a title fight
const NON_TITLE_PPV = new Set([
  'UFC 272: Covington vs. Masvidal',
  'UFC 279: Diaz vs. Ferguson',
  'UFC 291: Poirier vs. Gaethje 2',
]);

function parseHeadliners(slug) {
  if (!/^UFC \d+/i.test(slug)) return null;
  if (NON_TITLE_PPV.has(slug) || NON_TITLE_PPV.has(fixEncoding(slug))) return null;
  const s = fixEncoding(slug);
  const m = s.match(/:\s*(.+?)\s+vs\.\s+(.+)$/i);
  if (!m) return null;
  const clean = str => norm(str.replace(/\s+\d+$/, '').trim());
  return [clean(m[1]), clean(m[2])];
}

const HEADLINER_ALIAS = {
  'thekoreanzombie': 'chansung',
};

function matchesHeadliners(f1name, f2name, [h1raw, h2raw]) {
  const h1 = HEADLINER_ALIAS[h1raw] || h1raw;
  const h2 = HEADLINER_ALIAS[h2raw] || h2raw;
  const n1 = norm(fixEncoding(f1name));
  const n2 = norm(fixEncoding(f2name));
  return ((n1.includes(h1) || h1.includes(n1)) && (n2.includes(h2) || h2.includes(n2)))
      || ((n1.includes(h2) || h2.includes(n1)) && (n2.includes(h1) || h1.includes(n2)));
}

async function runApiSportsPhase(byName, fightMap, dbEvents) {
  if (!KEY || KEY === 'your-api-sports-key') {
    console.log('\nSkipping Phase 2: API_SPORTS_KEY not set in .env');
    return { found: 0, updated: 0, alreadySet: 0, noMatch: 0 };
  }

  const api = axios.create({
    baseURL: API_BASE,
    timeout: 20000,
    headers: { 'x-apisports-key': KEY },
  });

  console.log('\nÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬â€');
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Phase 2: API-Sports (2022+)             ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ');
  if (DRY) console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Mode: DRY RUN                           ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ');
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã…Â¡ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â\n');

  const { data: st } = await api.get('/status');
  const { current, limit_day } = st.response.requests;
  console.log(`API quota: ${current}/${limit_day} used  (${limit_day - current} remaining)\n`);

  const now     = new Date().getFullYear();
  const seasons = SEASON_ARG
    ? [SEASON_ARG]
    : Array.from({ length: now - 2022 + 2 }, (_, i) => 2022 + i);
  console.log(`Seasons: ${seasons.join(', ')}\n`);

  let found = 0, updated = 0, alreadySet = 0, noMatch = 0;
  const missed = [];

  for (const season of seasons) {
    await sleep(300);
    console.log(`-- Season ${season} --------------------------------------------------`);

    let apiFights;
    try {
      const { data } = await api.get('/fights', { params: { season } });
      apiFights = data.response || [];
    } catch (e) {
      console.error(`  Failed: ${e.message}`);
      continue;
    }

    const groups = {};
    for (const f of apiFights) {
      if (f.status?.short === 'CANC') continue;
      const hl = parseHeadliners(f.slug);
      if (!hl) continue;
      if (!groups[f.slug]) groups[f.slug] = { fights: [], hl };
      groups[f.slug].fights.push(f);
    }
    console.log(`  ${apiFights.length} fights -- ${Object.keys(groups).length} numbered UFC PPV slugs`);

    for (const [slug, { fights: evFights, hl }] of Object.entries(groups)) {
      const af = evFights.find(f =>
        matchesHeadliners(f.fighters?.first?.name || '', f.fighters?.second?.name || '', hl)
      );
      if (!af) { missed.push(`${slug}: headliner not found`); noMatch++; continue; }

      const f1raw   = af.fighters?.first?.name  || '';
      const f2raw   = af.fighters?.second?.name || '';
      const f1Id    = lookupFighter(f1raw, byName);
      const f2Id    = lookupFighter(f2raw, byName);
      const interim = /interim/i.test(af.category || '');

      if (!f1Id || !f2Id) {
        missed.push(`${slug}: fighters not in DB -- "${f1raw}" vs "${f2raw}"`);
        noMatch++;
        continue;
      }

      const eventDate = af.date?.slice(0, 10) ?? null;
      let dbEvent = eventDate ? dbEvents.byDate[eventDate] : null;
      if (!dbEvent && eventDate) {
        const d    = new Date(eventDate + 'T12:00:00Z');
        const prev = new Date(d); prev.setUTCDate(prev.getUTCDate() - 1);
        const next = new Date(d); next.setUTCDate(next.getUTCDate() + 1);
        dbEvent = dbEvents.byDate[prev.toISOString().slice(0, 10)]
               || dbEvents.byDate[next.toISOString().slice(0, 10)]
               || dbEvents.bySlug[norm(slug)];
      }
      if (!dbEvent) { missed.push(`${slug}: event not in DB`); noMatch++; continue; }

      const key      = `${dbEvent.id}:${[f1Id, f2Id].sort().join(':')}`;
      const existing = fightMap[key];
      if (!existing) {
        missed.push(`${slug}: fight not in DB -- ${f1raw} vs ${f2raw}`);
        noMatch++;
        continue;
      }

      found++;
      if (existing.is_title_fight && existing.is_interim_title === interim) { alreadySet++; continue; }

      const label = interim ? 'Interim Title' : 'Title Fight';
      console.log(`  + ${label}: ${f1raw} vs ${f2raw} (${slug})`);

      if (!DRY) {
        const { error } = await supabase
          .from('fights')
          .update({ is_title_fight: true, is_interim_title: interim })
          .eq('id', existing.id);
        if (error) console.error(`    Error: ${error.message}`);
        else updated++;
      } else {
        updated++;
      }
    }
  }

  if (missed.length) {
    console.log(`\n  Unmatched (${missed.length}):`);
    for (const m of missed) console.log(`    ` + m);
  }

  return { found, updated, alreadySet, noMatch };
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬â€');
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  UFCDB -- Backfill Title Fights          ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ');
  if (DRY) console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Mode: DRY RUN                           ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ');
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã…Â¡ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â\n');

  console.log('Loading fighters...');
  const fighters = await loadAll('fighters', 'id, first_name, last_name');
  const byName   = {};
  for (const f of fighters) {
    const full    = norm(`${f.first_name || ''} ${f.last_name || ''}`);
    const compact = norm(`${f.first_name || ''}${f.last_name || ''}`);
    if (full)    byName[full]    = f.id;
    if (compact) byName[compact] = f.id;
  }
  console.log(`  ${fighters.length} fighters loaded`);

  console.log('Loading events...');
  const evRows = await loadAll('events', 'id, name, slug, date');
  const dbEvents = { byDate: {}, bySlug: {} };
  for (const ev of evRows) {
    if (ev.date) dbEvents.byDate[ev.date] = ev;
    if (ev.slug) dbEvents.bySlug[ev.slug] = ev;
    dbEvents.bySlug[norm(ev.name)] = ev;
  }
  console.log(`  ${evRows.length} events loaded`);

  console.log('Loading fights...');
  const fightRows = await loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, is_title_fight, is_interim_title');
  const fightMap  = {};
  for (const f of fightRows) {
    const key = `${f.event_id}:${[f.fighter1_id, f.fighter2_id].sort().join(':')}`;
    fightMap[key] = f;
  }
  console.log(`  ${fightRows.length} fights loaded\n`);

  let wiki = { found: 0, updated: 0, alreadySet: 0, noMatch: 0 };
  let api  = { found: 0, updated: 0, alreadySet: 0, noMatch: 0 };

  if (!API_ONLY) {
    wiki = await runWikipediaPhase(byName, fightMap, dbEvents);
  }
  if (!WIKI_ONLY) {
    api = await runApiSportsPhase(byName, fightMap, dbEvents);
  }

  const totFound   = wiki.found   + api.found;
  const totUpdated = wiki.updated + api.updated;
  const totAlready = wiki.alreadySet + api.alreadySet;
  const totNoMatch = wiki.noMatch + api.noMatch;

  console.log('\nÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬â€');
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Summary                                 ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ');
  console.log(`ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Title fights identified: ${String(totFound).padEnd(15)}ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ`);
  console.log(`ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Already correct:         ${String(totAlready).padEnd(15)}ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ`);
  console.log(`ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Updated:                 ${String(totUpdated).padEnd(15)}ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ`);
  console.log(`ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ  Could not match:         ${String(totNoMatch).padEnd(15)}ÃƒÂ¢Ã¢â‚¬Â¢Ã¢â‚¬Ëœ`);
  console.log('ÃƒÂ¢Ã¢â‚¬Â¢Ã…Â¡ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â');
}

main().catch(e => { console.error(e); process.exit(1); });