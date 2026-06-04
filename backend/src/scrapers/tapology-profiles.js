/**
 * tapology-profiles.js
 *
 * Scrapes fighter bio data from Tapology fighter profile pages:
 *   - hometown (fighting out of)
 *   - nationality
 *   - gym / association
 *   - date of birth
 *   - head coach (if listed)
 *   - Instagram / Twitter handles
 *
 * Only writes fields that are currently NULL in the DB (never overwrites).
 *
 * Options:
 *   --limit N      Process at most N fighters this run
 *   --offset N     Skip first N in the queue
 *   --dry-run      Preview only, no DB writes
 *   --all          Target all fighters (default: only those missing hometown or social)
 *
 * Usage:
 *   node src/scrapers/tapology-profiles.js
 *   node src/scrapers/tapology-profiles.js --limit 50 --dry-run
 *   node src/scrapers/tapology-profiles.js --all --limit 200
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const supabase = require('../db/client');

const DRY    = process.argv.includes('--dry-run');
const ALL    = process.argv.includes('--all');
const LIMIT  = (() => { const i = process.argv.indexOf('--limit');  return i > -1 ? parseInt(process.argv[i+1]) : null; })();
const OFFSET = (() => { const i = process.argv.indexOf('--offset'); return i > -1 ? parseInt(process.argv[i+1]) : 0;    })();
const DELAY  = 2400;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// ── DB helpers ────────────────────────────────────────────

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

// ── Browser helpers ───────────────────────────────────────

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
    await page.goto(`https://www.tapology.com/search?term=${query}&search=fighters`, {
      waitUntil: 'domcontentloaded', timeout: 28000,
    });
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

// ── Profile scraper ───────────────────────────────────────

async function scrapeProfile(page, profileUrl) {
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 28000 });
    await sleep(1800);

    return await page.evaluate(() => {
      const result = {};

      // Tapology fighter profile pages have a details section with key/value pairs.
      // Try multiple selector patterns for resilience across layout versions.

      // ── Pattern 1: detail list items with strong labels ──
      // <li><strong>Fighting out of:</strong> Las Vegas, Nevada USA</li>
      document.querySelectorAll('ul.details li, div.details li, section.details li').forEach(li => {
        const strong = li.querySelector('strong');
        if (!strong) return;
        const label = strong.textContent.trim().replace(/:$/, '').toLowerCase();
        const value = li.textContent.replace(strong.textContent, '').trim();
        if (!value || value === '--' || value === 'N/A') return;

        if (label.includes('fighting out') || label.includes('location') || label.includes('hometown'))
          result.hometown = result.hometown || value;
        if (label.includes('nationality') || label.includes('country'))
          result.nationality = result.nationality || value;
        if (label.includes('association') || label.includes('gym') || label.includes('team') || label.includes('camp'))
          result.gym_name = result.gym_name || (li.querySelector('a')?.textContent?.trim() || value);
        if (label.includes('head coach') || label.includes('trainer'))
          result.head_coach = result.head_coach || value;
        if (label.includes('date of birth') || label.includes('born'))
          result.date_of_birth = result.date_of_birth || value;
      });

      // ── Pattern 2: span elements with data-title ──
      document.querySelectorAll('[data-title]').forEach(el => {
        const label = (el.getAttribute('data-title') || '').toLowerCase();
        const value = el.textContent.trim();
        if (!value || value === '--') return;

        if (label.includes('fighting out') || label.includes('hometown'))
          result.hometown = result.hometown || value;
        if (label.includes('nationality'))
          result.nationality = result.nationality || value;
        if (label.includes('association') || label.includes('gym'))
          result.gym_name = result.gym_name || value;
      });

      // ── Pattern 3: table rows ──
      // <tr><th>Fighting out of</th><td>Las Vegas, NV</td></tr>
      document.querySelectorAll('table tr').forEach(row => {
        const th = row.querySelector('th, td:first-child');
        const td = row.querySelector('td:last-child');
        if (!th || !td) return;
        const label = th.textContent.trim().toLowerCase();
        const value = td.textContent.trim();
        if (!value || value === '--') return;

        if (label.includes('fighting out') || label.includes('location'))
          result.hometown = result.hometown || value;
        if (label.includes('nationality'))
          result.nationality = result.nationality || value;
        if (label.includes('association') || label.includes('gym'))
          result.gym_name = result.gym_name || (td.querySelector('a')?.textContent?.trim() || value);
        if (label.includes('head coach') || label.includes('trainer'))
          result.head_coach = result.head_coach || value;
        if (label.includes('date of birth') || label.includes('born'))
          result.date_of_birth = result.date_of_birth || value;
      });

      // ── Pattern 4: data-fighter-details (newer Tapology layout) ──
      // Modern Tapology embeds structured data in the DOM
      document.querySelectorAll('[class*="fightCenterFighterDetail"], [class*="fighter_detail"]').forEach(el => {
        const label = el.querySelector('[class*="label"], strong, th')?.textContent?.trim()?.toLowerCase() || '';
        const value = el.querySelector('[class*="value"], span, td')?.textContent?.trim() || el.textContent.trim();
        if (!value || value === '--') return;

        if (label.includes('fighting out') || label.includes('hometown'))
          result.hometown = result.hometown || value;
        if (label.includes('nationality'))
          result.nationality = result.nationality || value;
        if (label.includes('association') || label.includes('gym') || label.includes('team'))
          result.gym_name = result.gym_name || value;
      });

      // ── Social media: look for platform links in the profile ──
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        if (href.includes('instagram.com/') && !result.instagram) {
          const m = href.match(/instagram\.com\/([^/?#]+)/);
          if (m && m[1] && !['p','explore','reels','stories'].includes(m[1]))
            result.instagram = '@' + m[1].replace(/\/$/, '');
        }
        if ((href.includes('twitter.com/') || href.includes('x.com/')) && !result.twitter) {
          const m = href.match(/(?:twitter|x)\.com\/([^/?#]+)/);
          if (m && m[1] && !['intent','share','search','home'].includes(m[1]))
            result.twitter = '@' + m[1].replace(/\/$/, '');
        }
      });

      return result;
    });
  } catch { return null; }
}

// ── Parse DOB string from Tapology ───────────────────────
// Tapology shows: "1988.03.25" or "Mar / 25 / 1988" or "1988"
function parseDob(raw) {
  if (!raw) return null;
  // "1988.03.25"
  let m = raw.match(/\b(19|20)\d{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])\b/);
  if (m) return m[0].replace(/\./g, '-');
  // "Mar / 25 / 1988" or "March 25, 1988"
  try {
    const d = new Date(raw.replace(/\//g, ' '));
    if (!isNaN(d.getTime()) && d.getFullYear() > 1950) return d.toISOString().split('T')[0];
  } catch {}
  return null;
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  UFCDB — Tapology Profile Scraper           ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (DRY) console.log('  *** DRY RUN — no DB writes ***\n');

  console.log('Loading fighters from DB...');
  const fighters = await loadAll('fighters',
    'id,first_name,last_name,status,nationality,hometown,gym_name,head_coach,date_of_birth,instagram,twitter'
  );
  console.log(`  ${fighters.length} fighters loaded\n`);

  // Queue: fighters missing at least one of the target fields
  let queue;
  if (ALL) {
    queue = fighters;
  } else {
    queue = fighters.filter(f =>
      !f.hometown || !f.nationality || !f.instagram || !f.twitter ||
      !f.gym_name || !f.head_coach
    );
  }

  // Prioritise active fighters
  queue.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    return 0;
  });

  const final = LIMIT ? queue.slice(OFFSET, OFFSET + LIMIT) : queue.slice(OFFSET);
  console.log(`Queue: ${final.length} fighters to process (${queue.length} total eligible)\n`);

  if (!final.length) {
    console.log('Nothing to do.');
    return;
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
  const page = await newPage(ctx);

  let updated = 0, notFound = 0, noData = 0, errors = 0;

  for (let i = 0; i < final.length; i++) {
    const f = final[i];
    const name = `${f.first_name} ${f.last_name}`;
    if (i > 0) await sleep(DELAY);

    const profileUrl = await searchFighter(page, f.first_name, f.last_name);
    if (!profileUrl) {
      notFound++;
      continue;
    }

    await sleep(DELAY);
    const profile = await scrapeProfile(page, profileUrl);

    if (!profile || !Object.values(profile).some(v => v)) {
      noData++;
      continue;
    }

    // Build patch — only fill in fields that are currently null
    const patch = {};
    if (profile.hometown      && !f.hometown)      patch.hometown      = profile.hometown;
    if (profile.nationality   && !f.nationality)   patch.nationality   = profile.nationality;
    if (profile.gym_name      && !f.gym_name)      patch.gym_name      = profile.gym_name;
    if (profile.head_coach    && !f.head_coach)    patch.head_coach    = profile.head_coach;
    if (profile.instagram     && !f.instagram)     patch.instagram     = profile.instagram;
    if (profile.twitter       && !f.twitter)       patch.twitter       = profile.twitter;
    if (profile.date_of_birth && !f.date_of_birth) {
      const dob = parseDob(profile.date_of_birth);
      if (dob) patch.date_of_birth = dob;
    }

    if (Object.keys(patch).length === 0) {
      noData++;
      continue;
    }

    if (DRY) {
      const fields = Object.keys(patch).join(', ');
      console.log(`  [DRY] ${name}: would set ${fields}`);
      updated++;
      continue;
    }

    const { error } = await supabase.from('fighters').update(patch).eq('id', f.id);
    if (error) {
      errors++;
      console.error(`  [ERR] ${name}: ${error.message}`);
    } else {
      updated++;
      const fields = Object.keys(patch).join(', ');
      if (updated % 10 === 0 || DRY)
        console.log(`  [${updated}] ${name}: ${fields}`);
    }

    // Progress report every 50
    if ((i + 1) % 50 === 0) {
      const pct = Math.round((i + 1) / final.length * 100);
      console.log(`\n  [${pct}%] ${i + 1}/${final.length} — updated: ${updated} | not found: ${notFound} | no data: ${noData}\n`);
    }
  }

  await browser.close();

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Done                                        ║');
  console.log(`║  Updated:    ${String(updated).padEnd(32)}║`);
  console.log(`║  Not found:  ${String(notFound).padEnd(32)}║`);
  console.log(`║  No new data:${String(noData).padEnd(32)}║`);
  console.log(`║  Errors:     ${String(errors).padEnd(32)}║`);
  console.log('╚══════════════════════════════════════════════╝');
}

main().catch(e => { console.error(e); process.exit(1); });
