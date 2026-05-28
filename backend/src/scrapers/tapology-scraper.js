/**
 * tapology-scraper.js
 *
 * Imports missing UFC fight history for fighters who have a W/L record
 * but zero fights linked in the database.
 *
 * Strategy:
 *   1. Find all DB fighters with wins+losses > 0 but no linked fights
 *   2. Search Tapology for each fighter by name
 *   3. Scrape their fight history page
 *   4. For each UFC fight found, match event by date and opponent by name,
 *      then insert the fight if it doesn't already exist
 *
 * Usage:
 *   node src/scrapers/tapology-scraper.js            # full run
 *   node src/scrapers/tapology-scraper.js --dry-run  # preview only
 *   node src/scrapers/tapology-scraper.js --limit 50 # first N fighters
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const supabase = require('../db/client');

const DRY   = process.argv.includes('--dry-run');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i+1]) : null; })();
const DELAY = 2200; // ms between Tapology page loads
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const MONTH_MAP = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
const METHOD_MAP = {
  'KO':'KO/TKO','TKO':'KO/TKO','SUB':'Submission','DEC':'Decision',
  'DRAW':'Draw','NC':'No Contest','DQ':'Disqualification',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
}

function parseDate(text) {
  const m = text.match(/\b(\d{4})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/);
  if (!m) return null;
  const mm = String(MONTH_MAP[m[2]]).padStart(2,'0');
  const dd = m[3].padStart(2,'0');
  return `${m[1]}-${mm}-${dd}`;
}

function parseRound(text) {
  const m = text.match(/\bR(\d)\b/);
  return m ? parseInt(m[1]) : null;
}

function parseTime(text) {
  const m = text.match(/\b(\d{1,2}:\d{2})\b/);
  return m ? m[1] : null;
}

async function loadAll(table, select) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data } = await supabase.from(table).select(select).range(offset, offset+999);
    if (!data?.length) break;
    rows.push(...data);
    offset += 1000;
    if (data.length < 1000) break;
  }
  return rows;
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator,'webdriver',{get:()=>false});
    window.chrome = { runtime: {} };
  });
  return page;
}

// Search Tapology for a fighter name, return best-match profile URL
async function searchFighter(page, firstName, lastName) {
  const query = encodeURIComponent((firstName+' '+lastName).trim());
  const url = 'https://www.tapology.com/search?term='+query+'&search=fighters';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(1500);
    const results = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/fightcenter/fighters/"]'))
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
        .filter(r => r.href.includes('/fightcenter/fighters/') && !r.href.includes('/search'))
        .slice(0, 5)
    );
    if (!results.length) return null;
    const normTarget = norm(firstName+lastName);
    // Prefer exact name match, fall back to first result
    const exact = results.find(r => norm(r.text).includes(normTarget) || normTarget.includes(norm(r.text.split('"')[0])));
    return exact?.href || results[0].href;
  } catch(e) {
    return null;
  }
}

// Scrape fight history from a fighter's Tapology profile
async function scrapeFights(page, profileUrl) {
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(1500);
    return await page.evaluate(() => {
      const results = Array.from(document.querySelectorAll('section.fighterFightResults div.result'));
      return results.map(div => {
        const text      = div.textContent.replace(/\s+/g,' ').trim();
        const oppLink   = div.querySelector('a[href*="/fightcenter/fighters/"]');
        const eventLink = div.querySelector('a[href*="/fightcenter/events/"]');
        const boutLink  = div.querySelector('a[href*="/fightcenter/bouts/"]');
        const words     = text.split(' ');
        return {
          text,
          outcome:    words[0] || null,
          methodShort: words[1] || null,
          opponent:   oppLink?.textContent?.trim() || null,
          oppUrl:     oppLink?.href || null,
          eventName:  eventLink?.textContent?.trim() || null,
          eventUrl:   eventLink?.href || null,
          boutUrl:    boutLink?.href || null,
        };
      });
    });
  } catch(e) {
    return [];
  }
}

async function main() {
  console.log('tapology-scraper' + (DRY?' [DRY RUN]':'') + (LIMIT?' [LIMIT='+LIMIT+']':''));

  // Load DB state
  console.log('\nLoading DB...');
  const fighters = await loadAll('fighters','id,first_name,last_name,wins,losses');
  const fightRefs = await loadAll('fights','event_id,fighter1_id,fighter2_id');
  const events    = await loadAll('events','id,name,date');
  const { data: wcs } = await supabase.from('weight_classes').select('id,name');

  const linkedIds = new Set();
  fightRefs.forEach(f=>{ linkedIds.add(f.fighter1_id); linkedIds.add(f.fighter2_id); });

  const fightSet = new Set(fightRefs.map(f=>f.event_id+':'+f.fighter1_id+':'+f.fighter2_id));

  // Name → DB fighter id
  const fighterByName = {};
  fighters.forEach(f=>{
    const k = norm((f.first_name||'')+(f.last_name||''));
    if(k) fighterByName[k]=f.id;
    const kl = norm(f.last_name||'');
    if(kl && !fighterByName[kl]) fighterByName[kl]=f.id;
  });

  // Date → DB events
  const evByDate = {};
  events.forEach(ev=>{ if(ev.date){ if(!evByDate[ev.date]) evByDate[ev.date]=[]; evByDate[ev.date].push(ev); }});

  const wcByNorm = {};
  (wcs||[]).forEach(w=>{ wcByNorm[norm(w.name)]=w.id; });

  // Fighters needing work
  const unlinked = fighters.filter(f=>(f.wins||0)+(f.losses||0)>0 && !linkedIds.has(f.id));
  const queue = LIMIT ? unlinked.slice(0,LIMIT) : unlinked;
  console.log('Fighters to process: '+queue.length+' ('+unlinked.length+' total unlinked)');
  if(DRY) console.log('DRY RUN: will show inserts but not write to DB\n');

  // Launch browser
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args:['--no-sandbox','--disable-blink-features=AutomationControlled','--disable-dev-shm-usage','--disable-extensions'],
  });
  const ctx = await browser.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport:{width:1280,height:720},
  });
  const page = await newPage(ctx);

  let inserted=0, skipped=0, notFound=0, noUFCFight=0, errors=0;
  const noMatchFighters = [];

  for (let i=0; i<queue.length; i++) {
    const f = queue[i];
    const name = (f.first_name||'')+' '+(f.last_name||'');
    if(i>0) await sleep(DELAY);

    // Search Tapology
    const profileUrl = await searchFighter(page, f.first_name||'', f.last_name||'');
    if(!profileUrl){ notFound++; continue; }

    // Scrape fight history
    await sleep(DELAY);
    const tapFights = await scrapeFights(page, profileUrl);
    if(!tapFights.length){ notFound++; continue; }

    // Filter to UFC fights (event URL contains "ufc" or event name starts with "UFC")
    const ufcFights = tapFights.filter(tf=>{
      if(!tf.outcome || ['C','NC-C'].includes(tf.outcome)) return false; // skip cancelled
      const evN = (tf.eventName||'').toLowerCase();
      const evU = (tf.eventUrl||'').toLowerCase();
      return evN.startsWith('ufc') || evU.includes('/ufc') || evN.includes('the ultimate fighter');
    });

    if(!ufcFights.length){ noUFCFight++; continue; }

    let fInserted=0;
    for(const tf of ufcFights) {
      const date = parseDate(tf.text);
      if(!date) continue;

      // Match DB event by date
      const candidates = evByDate[date] || [];
      const dbEvent = candidates.find(ev=>{
        const evN = norm(ev.name);
        return evN.includes('ufc') || evN.includes('ultimatefighter');
      }) || candidates[0];
      if(!dbEvent) continue;

      // Match opponent by name
      const oppNorm = norm(tf.opponent||'');
      const oppId = fighterByName[oppNorm];
      if(!oppId) continue;

      // Skip existing
      const k1=dbEvent.id+':'+f.id+':'+oppId;
      const k2=dbEvent.id+':'+oppId+':'+f.id;
      if(fightSet.has(k1)||fightSet.has(k2)){ skipped++; continue; }

      const outcome = tf.outcome;
      const method  = METHOD_MAP[tf.methodShort?.toUpperCase()] || tf.methodShort || null;
      const round   = parseRound(tf.text);
      const time    = parseTime(tf.text);
      const winner  = outcome==='W' ? f.id : (outcome==='L' ? oppId : null);
      const result  = outcome==='W'||outcome==='L' ? 'win' : (outcome==='D'?'draw':outcome==='NC'?'no_contest':null);

      if(DRY){
        console.log('[DRY] '+name+' vs '+tf.opponent+' @ '+tf.eventName+' ('+date+')'
          +' '+outcome+' '+method+(round?' R'+round:'')+(time?' '+time:''));
        fInserted++; inserted++;
        fightSet.add(k1);
        continue;
      }

      const { error } = await supabase.from('fights').insert({
        event_id: dbEvent.id, fighter1_id: f.id, fighter2_id: oppId,
        winner_id: winner, method, round, time, result,
      });
      if(error){ errors++; }
      else { fInserted++; inserted++; fightSet.add(k1); }
    }

    if(fInserted===0) noMatchFighters.push(name);
    const pct = Math.round((i+1)/queue.length*100);
    if((i+1)%25===0||i===queue.length-1)
      console.log('['+pct+'%] '+( i+1)+'/'+queue.length+' — inserted:'+inserted+' skipped:'+skipped+' notFound:'+notFound);
  }

  await browser.close();

  console.log('\n'+'='.repeat(50));
  console.log('Fighters processed:  '+queue.length);
  console.log('Fights inserted:     '+inserted);
  console.log('Fights skipped:      '+skipped);
  console.log('Fighter not on Tap:  '+notFound);
  console.log('No UFC fights found: '+noUFCFight);
  console.log('DB errors:           '+errors);
  console.log('='.repeat(50));

  if(inserted>0&&!DRY){
    console.log('\nRunning fix-card-position...');
    const { execSync } = require('child_process');
    execSync('node src/scrapers/fix-card-position.js', {stdio:'inherit'});
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
