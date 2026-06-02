/**
 * import-missing-opponents.js
 *
 * Reads tapology-no-match.json, re-scrapes Tapology for each listed fighter,
 * collects all opponent names missing from the fighters table, and inserts
 * minimal fighter records so tapology-scraper.js can match them on re-run.
 *
 * After a successful run this script also removes the affected fighters from
 * tapology-progress.json so they get re-queued automatically.
 *
 * Usage:
 *   node src/scrapers/import-missing-opponents.js
 *   node src/scrapers/import-missing-opponents.js --dry-run
 *   node src/scrapers/import-missing-opponents.js --dry-run --limit 20
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const supabase     = require('../db/client');
const slugify      = require('slugify');
const fs           = require('fs');
const path         = require('path');

const DRY   = process.argv.includes('--dry-run');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i+1]) : null; })();
const DELAY = 2200;
const CHROME       = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NOMATCH_FILE  = path.resolve(__dirname, '../../../tapology-no-match.json');
const PROGRESS_FILE = path.resolve(__dirname, '../../../tapology-progress.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function toSlug(name) {
  return slugify(name || '', { lower: true, strict: true });
}

function parseName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: 'Unknown', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] };
}

async function loadAll(table, select) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(select).range(offset, offset + 999);
    if (error) throw new Error('loadAll ' + table + ': ' + error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    offset += 1000;
    if (data.length < 1000) break;
  }
  return rows;
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  return page;
}

async function searchTapology(page, name) {
  const query = encodeURIComponent(name.trim());
  try {
    await page.goto(
      'https://www.tapology.com/search?term=' + query + '&search=fighters',
      { waitUntil: 'domcontentloaded', timeout: 28000 },
    );
    await sleep(1400);
    const results = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/fightcenter/fighters/"]'))
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
        .filter(r => r.href.includes('/fightcenter/fighters/') && !r.href.includes('/search'))
        .slice(0, 8)
    );
    if (!results.length) return null;
    const normTarget = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const exact = results.find(r => {
      const t = r.text.split('"')[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
      return t === normTarget || t.includes(normTarget) || normTarget.includes(t);
    });
    return (exact || results[0]).href;
  } catch (e) { return null; }
}

async function scrapeFights(page, profileUrl) {
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 28000 });
    await sleep(1400);
    return await page.evaluate(() => {
      const sels = [
        'section.fighterFightResults li',
        'section.fighterFightResults div.result',
        '#fightResults li',
        '.fighterFightResults .result',
      ];
      let els = [];
      for (const s of sels) { els = Array.from(document.querySelectorAll(s)); if (els.length) break; }
      return els.map(el => {
        const text    = el.textContent.replace(/\s+/g, ' ').trim();
        const oppLink = el.querySelector('a[href*="/fightcenter/fighters/"]');
        const evLink  = el.querySelector('a[href*="/fightcenter/events/"]');
        return {
          outcome:   (text.split(/\s+/)[0] || ''),
          opponent:  oppLink ? oppLink.textContent.trim() : null,
          oppUrl:    oppLink ? oppLink.href : null,
          eventName: evLink  ? evLink.textContent.trim()  : null,
          eventUrl:  evLink  ? evLink.href                : null,
        };
      }).filter(r => r.outcome && r.outcome.length < 10);
    });
  } catch (e) { return []; }
}

function isUfcFight(tf) {
  if (!tf.outcome || tf.outcome === 'C' || tf.outcome === 'NC-C') return false;
  const evN = (tf.eventName || '').toLowerCase();
  const evU = (tf.eventUrl  || '').toLowerCase();
  return evN.startsWith('ufc') || evU.includes('/ufc') ||
         evN.includes('ultimate fighter') || evN.includes('contender series');
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  UFCDB — Import Missing Opponent Fighters          ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  if (DRY) console.log('  *** DRY RUN — no writes to DB ***\n');

  const rawList = JSON.parse(fs.readFileSync(NOMATCH_FILE, 'utf8'));
  const noMatchNames = rawList
    .map(entry => { const m = entry.match(/^(.+?)\s+\(\d+/); return m ? m[1].trim() : null; })
    .filter(Boolean);

  const toProcess = LIMIT ? noMatchNames.slice(0, LIMIT) : noMatchNames;
  console.log('  ' + rawList.length + ' entries in no-match file, processing ' + toProcess.length + '\n');

  console.log('Loading DB fighters...');
  const fighters = await loadAll('fighters', 'id,first_name,last_name,slug');
  const slugSet  = new Set(fighters.map(f => f.slug).filter(Boolean));

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
  console.log('  ' + fighters.length + ' fighters loaded\n');

  const noMatchDbIds = [];
  for (const name of toProcess) {
    const normFull = norm(name);
    let id = byFull[normFull];
    if (!id) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        const last = norm(parts[parts.length - 1]);
        if (byLast[last]) id = byLast[last];
      }
    }
    if (id) noMatchDbIds.push(id);
    else    process.stderr.write('  [WARN] No DB match for: ' + name + '\n');
  }
  console.log('  Matched ' + noMatchDbIds.length + '/' + toProcess.length + ' no-match fighters to DB IDs\n');

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  });
  const ctx  = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 720 },
  });
  const page = await newPage(ctx);

  const missing = new Map();
  let scraped = 0, notFound = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const name = toProcess[i];
    if (i > 0) await sleep(DELAY);
    process.stdout.write('  [' + (i+1) + '/' + toProcess.length + '] ' + name + ' ... ');

    const profileUrl = await searchTapology(page, name);
    if (!profileUrl) { notFound++; console.log('not found on Tapology'); continue; }

    await sleep(DELAY);
    const tapFights  = await scrapeFights(page, profileUrl);
    const ufcFights  = tapFights.filter(isUfcFight);

    let newOpps = 0;
    for (const tf of ufcFights) {
      if (!tf.opponent) continue;
      const oppNorm = norm(tf.opponent);
      if (byFull[oppNorm]) continue;
      const parts = tf.opponent.trim().split(/\s+/);
      const last  = norm(parts[parts.length - 1]);
      if (byLast[last]) continue;
      if (!missing.has(oppNorm)) {
        missing.set(oppNorm, { name: tf.opponent });
        newOpps++;
      }
    }

    scraped++;
    console.log(ufcFights.length + ' UFC fights | ' + newOpps + ' new missing opponents');
  }

  await browser.close();

  console.log('\n  Scraped: ' + scraped + ' | Not found: ' + notFound + ' | Missing opponents: ' + missing.size + '\n');

  if (missing.size === 0) {
    console.log('No missing opponents to insert — all opponents already in DB.');
    return;
  }

  console.log('Inserting ' + missing.size + ' missing opponents' + (DRY ? ' (dry run)' : '') + '...\n');
  let inserted = 0, errors = 0;

  for (const [normName, { name }] of missing) {
    const { first_name, last_name } = parseName(name);
    let base = toSlug(name) || ('fighter-' + Date.now());
    let slug = base;
    let n = 2;
    while (slugSet.has(slug)) slug = base + '-' + (n++);

    if (DRY) {
      console.log('  [DRY] ' + first_name + ' ' + last_name + '  ->  slug: ' + slug);
      slugSet.add(slug);
      byFull[normName] = 'dry-' + inserted;
      const lk = norm(last_name);
      if (lk) { if (byLast[lk] === undefined) byLast[lk] = 'dry-' + inserted; else byLast[lk] = null; }
      inserted++;
      continue;
    }

    const { data, error } = await supabase
      .from('fighters')
      .insert({ first_name, last_name, slug })
      .select('id')
      .single();

    if (error) {
      errors++;
      process.stderr.write('  [ERR] ' + name + ': ' + error.message + '\n');
      continue;
    }

    inserted++;
    slugSet.add(slug);
    byFull[normName] = data.id;
    const lk = norm(last_name);
    if (lk) { if (byLast[lk] === undefined) byLast[lk] = data.id; else byLast[lk] = null; }
  }

  if (!DRY && inserted > 0 && noMatchDbIds.length > 0) {
    try {
      const prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      const doneSet = new Set(prog.done || []);
      for (const id of noMatchDbIds) doneSet.delete(id);
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...doneSet], updated: new Date().toISOString() }));
      console.log('\n  Removed ' + noMatchDbIds.length + ' fighters from tapology-progress.json — they will be re-queued.');
    } catch (e) {
      process.stderr.write('\n  Could not update tapology-progress.json: ' + e.message + '\n');
    }
  }

  console.log('\n' + '='.repeat(52));
  console.log('  No-match fighters processed:  ' + toProcess.length);
  console.log('  Not found on Tapology:        ' + notFound);
  console.log('  Missing opponents found:      ' + missing.size);
  console.log('  Opponents inserted into DB:   ' + inserted);
  console.log('  Insert errors:                ' + errors);
  console.log('='.repeat(52));

  if (inserted > 0 && !DRY) {
    console.log('\nNext step:');
    console.log('  node src/scrapers/tapology-scraper.js --mode pre2022');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
