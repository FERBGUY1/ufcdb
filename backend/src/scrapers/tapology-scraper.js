/**

main().catch(e => { console.error(e); process.exit(1); });

  } else if (MODE === 'backfill') {
    queue = fighters.filter(f => nullMethodFighters.has(f.id));
  } else {
    console.error('Unknown mode:', MODE); process.exit(1);

/**
 * tapology-scraper.js
 *
 * Imports missing UFC fight history for fighters with pre-2022 records.
 * Uses Playwright (headless Chrome) to scrape Tapology fighter profiles.
 *
 * Modes:
 *   --mode pre2022   Target fighters with W/L but no pre-2022 fights in DB (default)
 *   --mode all       Target fighters with W/L but ZERO fights linked in DB
 *   --mode gaps      Target fighters where DB fight count < wins+losses record
 *
 * Options:
 *   --dry-run           Preview inserts without writing to DB
 *   --limit N           Process at most N fighters this run
 *   --offset N          Skip first N fighters in the queue
 *   --reset-progress    Ignore the progress file and start fresh
 *
 * Usage:
 *   node src/scrapers/tapology-scraper.js                       # pre2022, resume
 *   node src/scrapers/tapology-scraper.js --mode all            # all unlinked
 *   node src/scrapers/tapology-scraper.js --dry-run --limit 10  # preview 10
 *   node src/scrapers/tapology-scraper.js --reset-progress      # fresh start
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const supabase = require('../db/client');
const fs = require('fs');
const path = require('path');

// â”€â”€ CLI flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const MODE   = (() => { const i = process.argv.indexOf('--mode');   return i > -1 ? process.argv[i+1] : 'pre2022'; })();
const DRY    = process.argv.includes('--dry-run');
const RESUME = !process.argv.includes('--reset-progress');
const LIMIT  = (() => { const i = process.argv.indexOf('--limit');  return i > -1 ? parseInt(process.argv[i+1]) : null; })();
const OFFSET = (() => { const i = process.argv.indexOf('--offset'); return i > -1 ? parseInt(process.argv[i+1]) : 0;    })();
const DELAY  = 2200;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROGRESS_FILE = path.resolve(__dirname, '../../../tapology-progress.json');
const NOMATCH_FILE  = path.resolve(__dirname, '../../../tapology-no-match.json');

// â”€â”€ Maps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const MONTH_MAP = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
const METHOD_MAP = {
  'KO':'KO/TKO','TKO':'KO/TKO','SUB':'SUB',
  'DEC':'DEC','UDEC':'U-DEC','U-DEC':'U-DEC','SDEC':'S-DEC','S-DEC':'S-DEC','MDEC':'M-DEC','M-DEC':'M-DEC',
  'CNC':'CNC','OVERTURNED':'Overturned','DRAW':'Draw','NC':'NC','NO CONTEST':'NC','DQ':'DQ','DISQUALIFICATION':'DQ',
};
// Only values that are actually method names -- prevents storing opponent names as method
const VALID_METHODS = new Set(Object.values(METHOD_MAP));
// Ordered longest-first so "light heavyweight" matches before "heavyweight"
const WC_MAP = [
  ["women's strawweight",  'womens-strawweight'],
  ["women's flyweight",    'womens-flyweight'],
  ["women's bantamweight", 'womens-bantamweight'],
  ["women's featherweight",'womens-featherweight'],
  ['light heavyweight',    'light-heavyweight'],
  ['lightheavyweight',     'light-heavyweight'],
  ['strawweight',          'strawweight'],
  ['flyweight',            'flyweight'],
  ['bantamweight',         'bantamweight'],
  ['featherweight',        'featherweight'],
  ['welterweight',         'welterweight'],
  ['middleweight',         'middleweight'],
  ['heavyweight',          'heavyweight'],
  ['lightweight',          'lightweight'],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function parseDate(text) {
  // Format: "2022 Mar 5" (month abbreviation -- legacy Tapology / other sources)
  let m = text.match(/\b(\d{4})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/);
  if (m) return `${m[1]}-${String(MONTH_MAP[m[2]]).padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // Format: "2022.03.05" (Tapology dot-separated -- current site format)
  m = text.match(/\b(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function parseRound(text) {
  const m = text.match(/\bR(\d)\b/i);
  return m ? parseInt(m[1]) : null;
}

function parseTime(text) {
  const m = text.match(/\b(\d{1,2}:\d{2})\b/);
  return m ? m[1] : null;
}

function detectWeightClass(text, wcBySlug) {
  const lower = text.toLowerCase();
  for (const [kw, slug] of WC_MAP) {
    if (lower.includes(kw)) { const id = wcBySlug[slug]; if (id) return id; }
  }
  return null;
}

// â”€â”€ Progress file â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadProgress() {
  if (!RESUME) return new Set();
  try {
    const d = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    return new Set(d.done || []);
  } catch { return new Set(); }
}

function saveProgress(done) {
  if (DRY) return;
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...done], updated: new Date().toISOString() }));
}

// â”€â”€ DB helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadAll(table, select) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(select).range(offset, offset + 999);
    if (error) throw new Error(`loadAll ${table}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    offset += 1000;
    if (data.length < 1000) break;
  }
  return rows;
}

// â”€â”€ Browser helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function newPage(ctx) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  return page;
}

async function searchFighter(page, firstName, lastName) {
  const query = encodeURIComponent(`${firstName} ${lastName}`.trim());
  try {
    await page.goto(`https://www.tapology.com/search?term=${query}&search=fighters`, { waitUntil: 'domcontentloaded', timeout: 28000 });
    await sleep(1400);
    const results = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/fightcenter/fighters/"]'))
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
        .filter(r => r.href.includes('/fightcenter/fighters/') && !r.href.includes('/search'))
        .slice(0, 8)
    );
    if (!results.length) return null;
    const normTarget = norm(firstName + lastName);
    const exact = results.find(r => {
      const t = norm(r.text.split('"')[0]);
      return t === normTarget || t.includes(normTarget) || normTarget.includes(t);
    });
    return exact?.href || results[0].href;
  } catch { return null; }
}

async function scrapeFights(page, profileUrl) {
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 28000 });
    await sleep(1800);
    return await page.evaluate(() => {
      // Primary: current Tapology layout -- each fight is a div[id] inside #proResults
      const proResults = document.querySelector('#proResults');
      let fightDivs = proResults
        ? Array.from(proResults.querySelectorAll(':scope > div[id]'))
        : [];

      // Fallback: legacy selectors
      if (!fightDivs.length) {
        const sels = ['section.fighterFightResults div.result', '.fighterFightResults .result'];
        for (const s of sels) {
          const els = Array.from(document.querySelectorAll(s));
          if (els.length) { fightDivs = els; break; }
        }
      }

      return fightDivs.map(div => {
        const resultDiv  = div.querySelector('.result') || div;
        const weightDiv  = div.querySelector('.displayWeight');
        const text       = resultDiv.textContent.replace(/\s+/g, ' ').trim();
        const weightText = weightDiv ? weightDiv.textContent.replace(/\s+/g, ' ').trim() : '';
        const fullText   = text + ' ' + weightText;
        const oppLink    = resultDiv.querySelector('a[href*="/fightcenter/fighters/"]');
        const evLink     = div.querySelector('a[href*="/fightcenter/events/"]');
        const words      = text.split(/\s+/);
        return {
          text: fullText,
          outcome:     words[0] || null,
          methodShort: words[1] || null,
          opponent:    oppLink?.textContent?.trim() || null,
          oppUrl:      oppLink?.href || null,
          eventName:   evLink?.textContent?.trim() || null,
          eventUrl:    evLink?.href || null,
        };
      }).filter(r => r.outcome && r.outcome.length < 10);
    });
  } catch { return []; }
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  console.log('\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
  console.log(`â•‘  UFCDB -- Tapology Fight History Import [${MODE.toUpperCase().padEnd(7)}]  â•‘`);
  console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');
  if (DRY) console.log('  *** DRY RUN -- no writes to DB ***\n');

  const done = loadProgress();
  console.log(`  Progress file: ${done.size} fighters already processed`);

  console.log('Loading DB...');
  const fighters = await loadAll('fighters', 'id,first_name,last_name,wins,losses,draws');
  const events   = await loadAll('events', 'id,name,date');
  const fights   = await loadAll('fights', 'id,event_id,fighter1_id,fighter2_id,method,round,time');
  const { data: wcs } = await supabase.from('weight_classes').select('id,name,slug');
  console.log(`  ${fighters.length} fighters | ${events.length} events | ${fights.length} fights\n`);

  // Build event date lookups
  const evDateById = {};
  const evByDate   = {};
  const evFuzzy    = {};
  events.forEach(ev => {
    if (!ev.date) return;
    evDateById[ev.id] = ev.date;
    (evByDate[ev.date] = evByDate[ev.date] || []).push(ev);
    for (let d = -1; d <= 1; d++) {
      const dt = new Date(ev.date);
      dt.setDate(dt.getDate() + d);
      const ds = dt.toISOString().split('T')[0];
      if (!evFuzzy[ds]) evFuzzy[ds] = [];
      if (!evFuzzy[ds].find(e => e.id === ev.id)) evFuzzy[ds].push(ev);
    }
  });

  // Weight class lookup
  const wcBySlug = {};
  (wcs || []).forEach(w => { wcBySlug[w.slug] = w.id; });

  // Fight dedup + per-fighter stats
  const fightSet   = new Set(fights.map(f => `${f.event_id}:${f.fighter1_id}:${f.fighter2_id}`));
  // backfill mode: fights that exist but have no method, for 2022+ events
  const nullMethodMap      = {};  // 'evId:f1Id:f2Id' -> fight.id
  const nullMethodFighters = new Set();
  fights.forEach(f => {
    if (!f.method) {
      const d = evDateById[f.event_id];
      if (d && d >= '2022-01-01') {
        nullMethodMap[f.event_id + ':' + f.fighter1_id + ':' + f.fighter2_id] = f.id;
        nullMethodMap[f.event_id + ':' + f.fighter2_id + ':' + f.fighter1_id] = f.id;
        nullMethodFighters.add(f.fighter1_id);
        nullMethodFighters.add(f.fighter2_id);
      }
    }
  });
  const linkedIds  = new Set();
  const pre2022Ids = new Set();
  const fightCount = {};
  fights.forEach(f => {
    linkedIds.add(f.fighter1_id);
    linkedIds.add(f.fighter2_id);
    fightCount[f.fighter1_id] = (fightCount[f.fighter1_id] || 0) + 1;
    fightCount[f.fighter2_id] = (fightCount[f.fighter2_id] || 0) + 1;
    const d = evDateById[f.event_id];
    if (d && d < '2022-01-01') {
      pre2022Ids.add(f.fighter1_id);
      pre2022Ids.add(f.fighter2_id);
    }
  });

  // Fighter name -> ID maps
  const byFull = {};
  const byLast = {};
  fighters.forEach(f => {
    const full = norm((f.first_name || '') + (f.last_name || ''));
    if (full) byFull[full] = f.id;
    const last = norm(f.last_name || '');
    if (last) {
      if (byLast[last] === undefined) byLast[last] = f.id;
      else byLast[last] = null;
    }
  });

  // Select queue based on mode
  let queue;
  if (MODE === 'all') {
    queue = fighters.filter(f => (f.wins || 0) + (f.losses || 0) > 0 && !linkedIds.has(f.id));
  } else if (MODE === 'pre2022') {
    queue = fighters.filter(f => (f.wins || 0) + (f.losses || 0) > 0 && !pre2022Ids.has(f.id));
  } else if (MODE === 'gaps') {
    queue = fighters.filter(f => {
      const rec = (f.wins || 0) + (f.losses || 0) + (f.draws || 0);
      return rec > 0 && (fightCount[f.id] || 0) < rec;
    });
  } else if (MODE === 'backfill') {
    queue = fighters.filter(f => nullMethodFighters.has(f.id));
  } else {
    console.error('Unknown mode:', MODE); process.exit(1);
  }

  const pending = queue.filter(f => !done.has(f.id)).slice(OFFSET);
  const final   = LIMIT ? pending.slice(0, LIMIT) : pending;

  console.log(`Queue: ${final.length} fighters to process`);
  console.log(`  Total eligible: ${queue.length} | Already done: ${done.size} | Remaining: ${queue.filter(f => !done.has(f.id)).length}\n`);

  if (!final.length) {
    console.log('Nothing to do -- all fighters in this mode are processed.');
    return;
  }

  // Launch headless Chrome
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-extensions'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
  const page = await newPage(ctx);

  let inserted = 0, updated = 0, skipped = 0, notFound = 0, noUFC = 0, errors = 0;
  const noMatchLog = [];

  for (let i = 0; i < final.length; i++) {
    const f = final[i];
    const name = `${f.first_name || ''} ${f.last_name || ''}`.trim();
    if (i > 0) await sleep(DELAY);

    const profileUrl = await searchFighter(page, f.first_name || '', f.last_name || '');
    if (!profileUrl) {
      notFound++;
      done.add(f.id);
      if (!DRY && (i + 1) % 25 === 0) saveProgress(done);
      continue;
    }

    await sleep(DELAY);
    const tapFights = await scrapeFights(page, profileUrl);
    if (!tapFights.length) {
      notFound++;
      done.add(f.id);
      if (!DRY && (i + 1) % 25 === 0) saveProgress(done);
      continue;
    }

    const ufcFights = tapFights.filter(tf => {
      if (!tf.outcome || ['C', 'NC-C'].includes(tf.outcome)) return false;
      const evN = (tf.eventName || '').toLowerCase();
      const evU = (tf.eventUrl || '').toLowerCase();
      return evN.startsWith('ufc') || evU.includes('/ufc') ||
             evN.includes('ultimate fighter') || evN.includes('contender series');
    });

    if (!ufcFights.length) { noUFC++; done.add(f.id); continue; }

    let fInserted = 0, fSkipped = 0;
    for (const tf of ufcFights) {
      const date = parseDate(tf.text);
      if (!date) continue;

      const cands = (evByDate[date]?.length ? evByDate[date] : evFuzzy[date]) || [];
      const dbEvent = cands.find(ev => {
        const n = norm(ev.name);
        return n.startsWith('ufc') || n.includes('ultimatefighter') || n.includes('contenderseries');
      }) || cands[0];
      if (!dbEvent) continue;

      const oppFull = norm(tf.opponent || '');
      let oppId = byFull[oppFull];
      if (!oppId && oppFull) {
        const parts = (tf.opponent || '').trim().split(/\s+/);
        const last  = norm(parts[parts.length - 1]);
        if (byLast[last]) oppId = byLast[last];
      }
      if (!oppId) continue;

      const k1 = `${dbEvent.id}:${f.id}:${oppId}`;
      const k2 = `${dbEvent.id}:${oppId}:${f.id}`;
      const existId = nullMethodMap[k1] || nullMethodMap[k2];
      if (fightSet.has(k1) || fightSet.has(k2)) {
        if (MODE === 'backfill' && existId && method) {
          if (!DRY) {
            const patch = { method };
            if (round) patch.round = round;
            if (time)  patch.time  = time;
            await supabase.from('fights').update(patch).eq('id', existId);
            delete nullMethodMap[k1]; delete nullMethodMap[k2];
          } else {
            console.log('  [DRY] UPDATE ' + name + ' vs ' + tf.opponent + ' method=' + method + ' R' + (round || '?'));
          }
          updated++; fSkipped++;
        } else {
          skipped++; fSkipped++;
        }
        continue;
      }

      const outcome = tf.outcome;
      const mapped  = METHOD_MAP[(tf.methodShort || '').toUpperCase()];
      const method  = mapped !== undefined ? mapped : (VALID_METHODS.has(tf.methodShort) ? tf.methodShort : null);
      const round   = parseRound(tf.text);
      const time    = parseTime(tf.text);
      const winner  = outcome === 'W' ? f.id : outcome === 'L' ? oppId : null;
      const result  = outcome === 'W' || outcome === 'L' ? 'win'
                    : outcome === 'D' ? 'draw'
                    : outcome === 'NC' ? 'no_contest' : null;
      const wcId = detectWeightClass(tf.text, wcBySlug);

      if (DRY) {
        console.log(`  [DRY] ${name} vs ${tf.opponent} @ ${tf.eventName} (${date}) ${outcome} ${method || '?'} R${round || '?'}`);
        fInserted++; inserted++; fightSet.add(k1);
        continue;
      }

      const row = { event_id: dbEvent.id, fighter1_id: f.id, fighter2_id: oppId, winner_id: winner, method, round, time, result };
      if (wcId) row.weight_class_id = wcId;

      const { error } = await supabase.from('fights').insert(row);
      if (error) {
        errors++;
        console.error(`  [ERR] ${name} vs ${tf.opponent}: ${error.message}`);
      } else {
        fInserted++; inserted++; fightSet.add(k1);
      }
    }

    // Only log if no fights were inserted AND none were already in DB (true mismatch, not all-dupes)
    if (fInserted === 0 && fSkipped === 0 && ufcFights.length > 0)
      noMatchLog.push(`${name} (${ufcFights.length} UFC fights on Tapology, 0 matched to DB)`);

    done.add(f.id);
    if (!DRY && (i + 1) % 25 === 0) saveProgress(done);

    const pct = Math.round((i + 1) / final.length * 100);
    if ((i + 1) % 10 === 0 || i === final.length - 1)
      console.log(`  [${pct}%] ${i + 1}/${final.length} | +${inserted} inserted | ~${updated} backfilled | ${skipped} dup | ${notFound} not-found`);
  }

  await browser.close();
  if (!DRY) saveProgress(done);

  console.log('\n' + '='.repeat(52));
  console.log(`  Mode:                 ${MODE}`);
  console.log(`  Fighters processed:   ${final.length}`);
  console.log(`  Fights inserted:      ${inserted}`);
  console.log(`  Methods backfilled:   ${updated}`);
  console.log(`  Fights skipped (dup): ${skipped}`);
  console.log(`  Not found on Tap:     ${notFound}`);
  console.log(`  No UFC fights found:  ${noUFC}`);
  console.log(`  DB errors:            ${errors}`);
  console.log('='.repeat(52));

  if (noMatchLog.length && !DRY) {
    fs.writeFileSync(NOMATCH_FILE, JSON.stringify(noMatchLog, null, 2));
    console.log(`\n  ${noMatchLog.length} fighters had UFC fights on Tapology but couldn't be matched.`);
    console.log('  See tapology-no-match.json for details.');
  }

  if (inserted > 0 && !DRY) {
    console.log('\nRunning fix-card-position to assign bout order...');
    require('child_process').execSync('node src/scrapers/fix-card-position.js', { stdio: 'inherit', cwd: process.cwd() });
  }
}

main().catch(e => { console.error(e); process.exit(1); });

