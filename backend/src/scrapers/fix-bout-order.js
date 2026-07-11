/**
 * fix-bout-order.js
 *
 * Fixes bout_order AND card_position for ALL events so fights display in the
 * correct order on event pages.
 *
 * Primary source:  Wikipedia (all events — exact fight order from tables)
 * Fallback source: API-Sports (for 2022+ events not yet on Wikipedia;
 *                  uses event name to identify the main event headliner,
 *                  then sorts remaining fights by broadcast reverse order)
 *
 * bout_order convention:  0 = main event, ascending toward first prelim fight
 * card_position:  'main_card' | 'prelim' | 'early_prelim'
 *
 * Flags:
 *   --dry-run         Preview updates without writing to DB
 *   --wiki-only       Only use Wikipedia (skip API-Sports fallback)
 *   --api-only        Skip Wikipedia, use API-Sports for all 2022+ events
 *   --event <name>    Process one event (name or slug substring)
 *   --force           Overwrite even if bout_order already matches
 *
 * Usage:
 *   node src/scrapers/fix-bout-order.js
 *   node src/scrapers/fix-bout-order.js --dry-run
 *   node src/scrapers/fix-bout-order.js --event "UFC 300" --dry-run
 */
require('dotenv').config();
const axios    = require('axios');
const cheerio  = require('cheerio');
const supabase = require('../db/client');

const DRY      = process.argv.includes('--dry-run');
const WIKIONLY = process.argv.includes('--wiki-only');
const APIONLY  = process.argv.includes('--api-only');
const FORCE    = process.argv.includes('--force');
const EVARG    = (() => { const i = process.argv.indexOf('--event'); return i > -1 ? process.argv[i + 1] : null; })();

const DELAY_WIKI = 1200;
const WIKI_BASE  = 'https://en.wikipedia.org';
const LIST_URL   = WIKI_BASE + '/wiki/List_of_UFC_events';

const KEY  = process.env.API_SPORTS_KEY;
const BASE = process.env.API_SPORTS_BASE || 'https://v1.mma.api-sports.io';

const http = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' },
});

const api = KEY ? axios.create({
  baseURL: BASE,
  timeout: 20000,
  headers: { 'x-apisports-key': KEY },
}) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Normalisation ─────────────────────────────────────────────────────────────

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function toSlug(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function fixEncoding(s) {
  if (!s) return s;
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

// Name corrections for API-Sports (mirrors events.js)
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
  'teciatorres':         'teciapennington',
  'sulangrangbo':        'sulangrangbosulangrangbo',
};

function lookupFighter(rawName, byName) {
  if (!rawName || /^(opponent\s+)?tba$/i.test(rawName.trim())) return null;
  let id = byName[norm(rawName)];
  if (id) return id;
  const fixed = fixEncoding(rawName);
  if (fixed !== rawName) { id = byName[norm(fixed)]; if (id) return id; }
  const n = norm(rawName);
  if (NAME_MAP[n]) { id = byName[NAME_MAP[n]]; if (id) return id; }
  const nf = norm(fixed);
  if (nf !== n && NAME_MAP[nf]) { id = byName[NAME_MAP[nf]]; if (id) return id; }
  return null;
}

// ── card_position heuristic (fallback when section is unknown) ────────────────

function deriveCardPosition(boutOrder, total) {
  if (total <= 5)  return 'main_card';
  if (total <= 10) return boutOrder < 5 ? 'main_card' : 'prelim';
  if (total <= 14) {
    const earlyCount = total - 9;
    if (boutOrder < 5)                  return 'main_card';
    if (boutOrder < total - earlyCount) return 'prelim';
    return 'early_prelim';
  }
  if (boutOrder < 5)  return 'main_card';
  if (boutOrder < 11) return 'prelim';
  return 'early_prelim';
}

// ── DB helpers ────────────────────────────────────────────────────────────────

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

// ── Wikipedia helpers ─────────────────────────────────────────────────────────

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
      if (dateStr) {
        seen.add(wikiPath);
        events.push({ name: eventName, date: dateStr, wikiUrl: WIKI_BASE + wikiPath });
      }
    });
  });
  return events;
}

/**
 * Detect which card section a fight table belongs to.
 * Returns 'main_card', 'prelim', 'early_prelim', or null.
 *
 * Handles both old-style Wikipedia (bare h3) and new-style
 * (<div class="mw-heading"><h3>...</h3></div> wrappers).
 */
function detectTableSection($, table) {
  // 1) First row colspan header (common in UFC fight tables):
  //    <tr><th colspan="7">Main card</th></tr>
  const firstRowSpan = $(table).find('tr').first().find('th[colspan]').first().text().toLowerCase().trim();
  if (/early.?prelim/i.test(firstRowSpan)) return 'early_prelim';
  if (/prelim/i.test(firstRowSpan))        return 'prelim';
  if (/main.?card/i.test(firstRowSpan))    return 'main_card';

  // 2) Table caption
  const caption = $(table).find('caption').text().toLowerCase();
  if (/early.?prelim/i.test(caption)) return 'early_prelim';
  if (/prelim/i.test(caption))        return 'prelim';
  if (/main.?card/i.test(caption))    return 'main_card';

  // 3) Walk backwards through siblings to find the nearest heading.
  //    Handles two Wikipedia formats:
  //      Old: <h3>Main card</h3> as direct sibling
  //      New: <div class="mw-heading"><h3>Main card</h3></div>
  function headingText(el) {
    const tag = (el.get(0) || {}).tagName || '';
    if (/^h[2-4]$/.test(tag)) return el.text().toLowerCase();
    if (tag === 'div') {
      const inner = el.find('h2,h3,h4').first();
      if (inner.length) return inner.text().toLowerCase();
    }
    return null;
  }

  let el = $(table).prev();
  for (let i = 0; i < 12 && el.length; i++) {
    const txt = headingText(el);
    if (txt !== null) {
      if (/early.?prelim/i.test(txt)) return 'early_prelim';
      if (/prelim/i.test(txt))        return 'prelim';
      if (/main.?card/i.test(txt))    return 'main_card';
      // Hit a heading that doesn't match — stop looking further
      break;
    }
    el = el.prev();
  }

  return null;
}

function isFightCard($, table) {
  const ths = $(table).find('th').map((_, th) => $(th).text().toLowerCase().trim()).get();
  const h   = ths.join('|');
  if (/title fights in \d{4}/i.test(ths[0] || ''))      return false;
  if (/current (?:ufc )?champions/i.test(ths[0] || '')) return false;
  const dataRows = $(table).find('tr').filter((_, tr) => $(tr).find('td').length > 0).length;
  if (dataRows > 30) return false;
  return (h.includes('weight') || h.includes('class')) &&
         (h.includes('method') || (h.includes('round') && h.includes('time')));
}

/**
 * Fetches the fight order from a Wikipedia event page.
 * Returns an ordered array of { f1, f2, boutOrder, cardPosition }.
 * boutOrder 0 = main event (top of card).
 */
async function fetchWikiFightOrder(wikiUrl) {
  await sleep(DELAY_WIKI);
  try {
    const { data } = await http.get(wikiUrl);
    const $       = cheerio.load(data);

    // Bucket fights by section; Wikipedia tables list fights main-event-first
    const buckets = { main_card: [], prelim: [], early_prelim: [], unknown: [] };

    $('table.toccolours, table.wikitable').each((_, table) => {
      if (!isFightCard($, table)) return;

      const section    = detectTableSection($, table) || 'unknown';
      const tableFights = [];

      $(table).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 5) return;

        // Locate f1/f2 columns by finding the "def." / "drew" / "vs." separator
        let f1Idx = 1, f2Idx = 3;
        cells.each((ci, cell) => {
          const t = $(cell).text().trim().toLowerCase();
          if ((t === 'def.' || t === 'drew' || t === 'vs.') && ci > 0 && f1Idx === 1) {
            f1Idx = ci - 1;
            f2Idx = ci + 1;
          }
        });

        // Strip 1-2 letter parenthetical markers: (c) champion, (ic) interim champion, etc.
        // NOTE: the old /\([ic]\)/ char class matched only (i) or (c), never (ic) —
        // interim-champ headliners went unmatched and were never seated at bout_order 0.
        const f1raw = $(cells[f1Idx]).text()
          .replace(/\([a-z]{1,2}\)/gi, '').replace(/\[\w+\]/g, '').trim();
        const f2raw = $(cells[f2Idx]).text()
          .replace(/\([a-z]{1,2}\)/gi, '').replace(/\[\w+\]/g, '').trim();
        if (!f1raw || !f2raw || f1raw.length > 60 || f2raw.length > 60) return;

        tableFights.push({ f1: f1raw, f2: f2raw });
      });

      buckets[section].push(...tableFights);
    });

    // Combine: main_card → prelim → early_prelim → unknown
    const ordered = [
      ...buckets.main_card,
      ...buckets.prelim,
      ...buckets.early_prelim,
      ...buckets.unknown,
    ];

    if (!ordered.length) return [];

    const mLen = buckets.main_card.length;
    const pLen = buckets.prelim.length;
    const eLen = buckets.early_prelim.length;
    const total = ordered.length;

    // If no separate prelim/early-prelim tables were detected the page uses
    // a single combined table — fall back to the position heuristic instead of
    // labelling every fight 'main_card'.
    const hasExplicitSections = pLen > 0 || eLen > 0;

    return ordered.map((f, i) => {
      let cardPosition;
      if (!hasExplicitSections) {
        cardPosition = deriveCardPosition(i, total);
      } else if (i < mLen) {
        cardPosition = 'main_card';
      } else if (i < mLen + pLen) {
        cardPosition = 'prelim';
      } else if (i < mLen + pLen + eLen) {
        cardPosition = 'early_prelim';
      } else {
        cardPosition = deriveCardPosition(i, total);
      }
      return { f1: f.f1, f2: f.f2, boutOrder: i, cardPosition };
    });

  } catch (e) {
    console.error(`  Error fetching ${wikiUrl}: ${e.message}`);
    return [];
  }
}

// ── API-Sports helpers ────────────────────────────────────────────────────────

/**
 * Fetches all seasons from API-Sports.
 * Returns: Map<dbSlug, Array<{f1, f2}>> in BROADCAST ORDER (first fight first).
 * The caller is responsible for reordering to main-event-first.
 */
async function fetchApiAllSeasons() {
  const now     = new Date().getFullYear();
  const seasons = Array.from({ length: now - 2022 + 2 }, (_, i) => 2022 + i);
  const allGroups = {}; // dbSlug → [{f1, f2}]

  for (const season of seasons) {
    await sleep(400);
    process.stdout.write(`  Season ${season}... `);
    let apiFights;
    try {
      const { data } = await api.get('/fights', { params: { season } });
      apiFights = data.response || [];
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      continue;
    }

    const groups = {};
    for (const f of apiFights) {
      if (f.status.short === 'CANC') continue;
      if (!groups[f.slug]) groups[f.slug] = [];
      groups[f.slug].push(f);
    }

    let evCount = 0;
    for (const [apiSlug, evFights] of Object.entries(groups)) {
      const dbSlug = toSlug(apiSlug);
      if (!allGroups[dbSlug]) {
        allGroups[dbSlug] = evFights.map(f => ({
          f1: f.fighters?.first?.name  || '',
          f2: f.fighters?.second?.name || '',
        }));
        evCount++;
      }
    }
    console.log(`${evCount} events`);
  }
  return allGroups;
}

/**
 * Reorders API-Sports fights (broadcast order = first fight of night first) into
 * main-event-first order using the DB event name to identify headliners.
 *
 * Returns Array<{f1, f2, boutOrder, cardPosition}>.
 */
function orderApiSportsFights(rawFights, dbEventName) {
  if (!rawFights.length) return [];

  // Parse headliners from event name: "UFC 300: Pereira vs. Hill" → ["pereira","hill"]
  const m = dbEventName.match(/:\s*(.+?)\s+vs\.?\s+(.+?)(?:\s+\d+)?$/i);
  let mainIdx = -1;
  if (m) {
    const h1 = norm(m[1].trim().split(/\s+/).pop());
    const h2 = norm(m[2].trim().split(/\s+/).pop());
    mainIdx = rawFights.findIndex(f => {
      const f1l = norm((f.f1 || '').trim().split(/\s+/).pop());
      const f2l = norm((f.f2 || '').trim().split(/\s+/).pop());
      return (f1l === h1 && f2l === h2) || (f1l === h2 && f2l === h1);
    });
  }

  // API returns fights in broadcast order (first fight of night first).
  // Reverse for main-event-first, then put identified headliner at position 0.
  const reversed = [...rawFights].reverse();

  if (mainIdx >= 0) {
    // Find the headliner in reversed array and move to front
    const revIdx = reversed.findIndex(f => f === rawFights[mainIdx]);
    if (revIdx > 0) reversed.unshift(...reversed.splice(revIdx, 1));
  }

  const total = reversed.length;
  return reversed.map((f, i) => ({
    f1:           f.f1,
    f2:           f.f2,
    boutOrder:    i,
    cardPosition: deriveCardPosition(i, total),
  }));
}

// ── Shared: apply a fight order to DB fights ──────────────────────────────────

async function applyFightOrder(orderedFights, eventFights, fighterById) {
  const pairToFight = {};
  for (const fight of eventFights) {
    const f1Obj = fighterById[fight.fighter1_id];
    const f2Obj = fighterById[fight.fighter2_id];
    if (!f1Obj || !f2Obj) continue;
    const n1 = norm((f1Obj.first_name || '') + (f1Obj.last_name || ''));
    const n2 = norm((f2Obj.first_name || '') + (f2Obj.last_name || ''));
    pairToFight[n1 + ':' + n2] = fight;
    pairToFight[n2 + ':' + n1] = fight;
  }

  let updated = 0, unmatched = 0;

  for (const wf of orderedFights) {
    const wn1 = norm(wf.f1), wn2 = norm(wf.f2);
    let dbFight = pairToFight[wn1 + ':' + wn2];

    // Last-name fallback
    if (!dbFight) {
      const p1  = wf.f1.trim().split(/\s+/);
      const p2  = wf.f2.trim().split(/\s+/);
      const wl1 = norm(p1[p1.length - 1]);
      const wl2 = norm(p2[p2.length - 1]);
      for (const [k, df] of Object.entries(pairToFight)) {
        const [a, b] = k.split(':');
        if ((a.endsWith(wl1) && b.endsWith(wl2)) || (a.endsWith(wl2) && b.endsWith(wl1))) {
          dbFight = df; break;
        }
      }
    }

    if (!dbFight) { unmatched++; continue; }

    if (!FORCE &&
        dbFight.bout_order === wf.boutOrder &&
        dbFight.card_position === wf.cardPosition) continue;

    if (DRY) {
      console.log(`    [DRY] bo=${wf.boutOrder} ${wf.cardPosition}: ${wf.f1} vs ${wf.f2}`);
    } else {
      const { error } = await supabase
        .from('fights')
        .update({ bout_order: wf.boutOrder, card_position: wf.cardPosition })
        .eq('id', dbFight.id);
      if (error) console.error(`    Update error (${dbFight.id}): ${error.message}`);
    }
    updated++;
  }

  return { updated, unmatched };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  UFCDB — Fix Bout Order                  ║');
  if (DRY)      console.log('║  *** DRY RUN — no writes ***             ║');
  if (FORCE)    console.log('║  --force: overwriting existing values    ║');
  if (WIKIONLY) console.log('║  --wiki-only                             ║');
  if (APIONLY)  console.log('║  --api-only                              ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const useApi = !WIKIONLY && !!KEY;

  // ── Load fighters ──────────────────────────────────────────────────────────
  console.log('Loading fighters...');
  const allFighters = await loadAll('fighters', 'id, first_name, last_name');
  const fighterByName = {};
  for (const f of allFighters) {
    const compact = norm((f.first_name || '') + (f.last_name || ''));
    if (compact) fighterByName[compact] = f.id;
    const full = norm((f.first_name || '') + ' ' + (f.last_name || ''));
    if (full) fighterByName[full] = f.id;
  }
  const fighterById = {};
  for (const f of allFighters) fighterById[f.id] = f;
  console.log(`  ${allFighters.length} fighters\n`);

  // ── Load DB events ─────────────────────────────────────────────────────────
  console.log('Loading events...');
  const allDbEvents = await loadAll('events', 'id, name, slug, date');
  const targetEvents = EVARG
    ? allDbEvents.filter(e =>
        e.name.toLowerCase().includes(EVARG.toLowerCase()) ||
        (e.slug || '').includes(EVARG.toLowerCase()))
    : allDbEvents;
  console.log(`  ${allDbEvents.length} total, ${targetEvents.length} matching filter\n`);

  // ── Load DB fights ─────────────────────────────────────────────────────────
  console.log('Loading fights...');
  const allDbFights = await loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, bout_order, card_position');
  const fightsByEvent = {};
  for (const f of allDbFights) {
    if (!fightsByEvent[f.event_id]) fightsByEvent[f.event_id] = [];
    fightsByEvent[f.event_id].push(f);
  }
  console.log(`  ${allDbFights.length} fights\n`);

  // ── Wikipedia event list ───────────────────────────────────────────────────
  let wikiByNorm = {};
  if (!APIONLY) {
    console.log('Fetching Wikipedia event list...');
    const wikiEvents = await fetchWikiEventList();
    console.log(`  ${wikiEvents.length} Wikipedia events found\n`);
    for (const we of wikiEvents) wikiByNorm[norm(we.name)] = we;
  }

  // ── API-Sports data (pre-fetched for all seasons) ──────────────────────────
  let apiByDbSlug = {};
  if (useApi) {
    console.log('Pre-fetching API-Sports data...');
    const raw = await fetchApiAllSeasons();
    // key is already dbSlug from fetchApiAllSeasons
    apiByDbSlug = raw;
    console.log(`  ${Object.keys(apiByDbSlug).length} API-Sports event groups loaded\n`);
  }

  let totalEventsUpdated = 0, totalEventsSkipped = 0, totalEventsNoSource = 0;
  let totalFightsUpdated = 0, totalFightsUnmatched = 0;

  // Sort events by date for ordered progress logging
  const sorted = [...targetEvents].sort((a, b) => a.date.localeCompare(b.date));

  console.log(`── Processing ${sorted.length} events ───────────────────────────────────────\n`);

  for (let ei = 0; ei < sorted.length; ei++) {
    const event       = sorted[ei];
    const eventFights = fightsByEvent[event.id] || [];
    if (!eventFights.length) continue;

    const pct = Math.round((ei + 1) / sorted.length * 100);

    // ── 1. Try Wikipedia ─────────────────────────────────────────────────────
    let source    = null;
    let wikiEntry = null;

    if (!APIONLY) {
      const dbNorm = norm(event.name);
      wikiEntry    = wikiByNorm[dbNorm];
      if (!wikiEntry) {
        const short = dbNorm.replace(/^ufc/, '');
        for (const [wn, we] of Object.entries(wikiByNorm)) {
          if (wn.replace(/^ufc/, '') === short) { wikiEntry = we; break; }
        }
      }
      if (wikiEntry) source = 'wiki';
    }

    // ── 2. Fallback: API-Sports (2022+ only) ─────────────────────────────────
    if (!source && useApi && event.date >= '2022-01-01') {
      const dbSlug = event.slug || toSlug(event.name);
      if (apiByDbSlug[dbSlug] || apiByDbSlug[toSlug(event.name)]) source = 'api';
    }

    if (!source) { totalEventsNoSource++; continue; }

    // ── Get ordered fights from source ────────────────────────────────────────
    let orderedFights = [];

    if (source === 'wiki') {
      orderedFights = await fetchWikiFightOrder(wikiEntry.wikiUrl);
      if (!orderedFights.length) {
        console.log(`  ? No fight data from Wikipedia: "${event.name}"`);
        totalEventsSkipped++;
        continue;
      }
    } else {
      // API-Sports fallback
      const dbSlug   = event.slug || toSlug(event.name);
      const rawFights = apiByDbSlug[dbSlug] || apiByDbSlug[toSlug(event.name)] || [];
      orderedFights = orderApiSportsFights(rawFights, event.name);
      if (!orderedFights.length) { totalEventsSkipped++; continue; }
    }

    // ── Apply order to DB fights ──────────────────────────────────────────────
    const { updated, unmatched } = await applyFightOrder(orderedFights, eventFights, fighterById);

    totalFightsUpdated   += updated;
    totalFightsUnmatched += unmatched;

    if (updated > 0) {
      totalEventsUpdated++;
      const tag = source === 'wiki' ? 'wiki' : ' api';
      console.log(`  [${String(pct).padStart(3)}%][${tag}] ${event.name} (${event.date}): +${updated} updated${unmatched ? ', ' + unmatched + ' unmatched' : ''}`);
    } else {
      totalEventsSkipped++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Complete!                               ║');
  console.log(`║  Events updated:    ${String(totalEventsUpdated).padEnd(20)}║`);
  console.log(`║  Events skipped:    ${String(totalEventsSkipped).padEnd(20)}║`);
  console.log(`║  Events no source:  ${String(totalEventsNoSource).padEnd(20)}║`);
  console.log(`║  Fights updated:    ${String(totalFightsUpdated).padEnd(20)}║`);
  console.log(`║  Fights unmatched:  ${String(totalFightsUnmatched).padEnd(20)}║`);
  console.log('╚══════════════════════════════════════════╝');
  if (DRY) console.log('\n(Dry run — no writes made)');
}

main().catch(e => { console.error(e); process.exit(1); });
