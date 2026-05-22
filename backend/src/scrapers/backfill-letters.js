/**
 * Backfill scraper for letters that failed due to slug collisions.
 * Usage: node src/scrapers/backfill-letters.js [letters]
 * Example: node src/scrapers/backfill-letters.js d g j m s
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const slugify = require('slugify');
const supabase = require('../db/client');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const BASE  = 'http://ufcstats.com';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' },
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limit = pLimit(2);

function toSlug(name) {
  return slugify(name, { lower: true, strict: true });
}

function parseRecord(record) {
  if (!record) return { wins: 0, losses: 0, draws: 0, nc: 0 };
  const m  = record.match(/(\d+)-(\d+)-(\d+)/);
  const nc = record.match(/\((\d+)\s+NC\)/);
  return {
    wins:   m ? parseInt(m[1]) : 0,
    losses: m ? parseInt(m[2]) : 0,
    draws:  m ? parseInt(m[3]) : 0,
    nc:     nc ? parseInt(nc[1]) : 0,
  };
}

function parseHeightToInches(h) {
  if (!h) return null;
  const m = h.match(/(\d+)'\s*(\d+)"/);
  return m ? parseInt(m[1]) * 12 + parseInt(m[2]) : null;
}

function parseNum(val) {
  if (!val || val === '--') return null;
  const n = parseFloat(val.replace('%', ''));
  return isNaN(n) ? null : n;
}

async function getUrlsForChar(char) {
  try {
    const { data } = await http.get(`${BASE}/statistics/fighters?char=${char}&page=all`);
    const $ = cheerio.load(data);
    const urls = [];
    $('table.b-statistics__table tbody tr').each((_, row) => {
      const link = $(row).find('td a').first().attr('href');
      if (link?.includes('/fighter-details/')) urls.push(link);
    });
    return urls;
  } catch (e) {
    console.error(`  Failed fetching ${char}:`, e.message);
    return [];
  }
}

async function scrapeFighter(url, weightClassMap) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    const fullName = $('span.b-content__title-highlight').text().trim();
    if (!fullName) return null;

    const nameParts  = fullName.split(' ');
    const first_name = nameParts.slice(0, -1).join(' ') || fullName;
    const last_name  = nameParts.slice(-1)[0] || '';
    const nickname   = $('p.b-content__Nickname').text().replace(/"/g, '').trim() || null;

    const recordText = $('span.b-content__title-record').text().replace('Record:', '').trim();
    const { wins, losses, draws, nc } = parseRecord(recordText);

    const info = {};
    $('ul.b-list__box-list li.b-list__box-list-item').each((_, el) => {
      const label = $(el).find('i.b-list__box-item-title').text().trim().replace(':', '');
      const value = $(el).text().replace($(el).find('i').text(), '').trim();
      if (label) info[label] = value;
    });

    const stats = {};
    $('li.b-list__box-list-item_type_block').each((_, el) => {
      const label = $(el).find('i').text().trim().replace(':', '');
      const value = $(el).text().replace($(el).find('i').text(), '').trim();
      if (label) stats[label] = value;
    });

    const dob = info['DOB'];
    const wcCounts = {};
    $('table.b-fight-details__table tbody tr').each((_, row) => {
      const wc = $($(row).find('td')[6]).text().trim();
      if (wc) wcCounts[wc] = (wcCounts[wc] || 0) + 1;
    });
    const topWC   = Object.entries(wcCounts).sort((a,b) => b[1]-a[1])[0];
    const ufc_id  = url.split('/').pop();
    const baseSlug = toSlug(fullName);

    return {
      ufc_id,
      first_name, last_name, nickname,
      slug: baseSlug,
      wins, losses, draws, no_contests: nc,
      height_inches:  parseHeightToInches(info['Height']),
      reach_inches:   parseNum(info['Reach']),
      weight_lbs:     parseNum(info['Weight']),
      stance:         info['STANCE'] || info['Stance'] || null,
      date_of_birth:  dob && dob !== '--' ? (() => { try { return new Date(dob).toISOString().split('T')[0]; } catch { return null; } })() : null,
      primary_weight_class_id: topWC ? (weightClassMap[topWC[0]] || null) : null,
      slpm:    parseNum(stats['SLpM']),
      sapm:    parseNum(stats['SApM']),
      str_acc: parseNum(stats['Str. Acc.']),
      str_def: parseNum(stats['Str. Def']),
      td_avg:  parseNum(stats['TD Avg.']),
      td_acc:  parseNum(stats['TD Acc.']),
      td_def:  parseNum(stats['TD Def.']),
      sub_avg: parseNum(stats['Sub. Avg.']),
      last_synced_at: new Date().toISOString(),
    };
  } catch (e) {
    return null;
  }
}

async function main() {
  const letters = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['d','g','j','m','s'];

  console.log('╔══════════════════════════════════════╗');
  console.log('║  UFCDB — Backfill Failed Letters     ║');
  console.log(`║  Letters: ${letters.join(' ').toUpperCase().padEnd(26)}║`);
  console.log('╚══════════════════════════════════════╝\n');

  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcMap = {};
  for (const wc of wcs || []) wcMap[wc.name] = wc.id;

  let totalImported = 0;
  let totalFailed   = 0;

  for (const char of letters) {
    await sleep(DELAY);
    const urls = await getUrlsForChar(char.toLowerCase());
    if (!urls.length) { console.log(`  ${char.toUpperCase()}: no URLs found`); continue; }

    console.log(`  ${char.toUpperCase()}: ${urls.length} fighters — scraping...`);

    const fighters = await Promise.all(
      urls.map(url => limit(async () => {
        await sleep(DELAY);
        return scrapeFighter(url, wcMap);
      }))
    );

    const valid = fighters.filter(Boolean);

    // Deduplicate slugs within batch
    const seenSlugs = new Set();
    for (const f of valid) {
      if (seenSlugs.has(f.slug)) f.slug = `${f.slug}-${f.ufc_id.slice(-6)}`;
      seenSlugs.add(f.slug);
    }

    // Try bulk upsert first
    const { error } = await supabase
      .from('fighters')
      .upsert(valid, { onConflict: 'ufc_id', ignoreDuplicates: false });

    if (error?.code === '23505') {
      // Slug taken by a fighter from a different letter — upsert one-by-one with suffix fallback
      let saved = 0;
      for (const f of valid) {
        const { error: e2 } = await supabase
          .from('fighters')
          .upsert(f, { onConflict: 'ufc_id' });

        if (e2?.code === '23505') {
          // Still colliding — add ufc_id suffix
          const { error: e3 } = await supabase
            .from('fighters')
            .upsert({ ...f, slug: `${f.slug}-${f.ufc_id.slice(-6)}` }, { onConflict: 'ufc_id' });
          if (e3) totalFailed++; else { saved++; totalImported++; }
        } else if (e2) {
          totalFailed++;
        } else {
          saved++;
          totalImported++;
        }
      }
      console.log(`  ${char.toUpperCase()}: ✓ ${saved} saved with slug-fix fallback (total: ${totalImported})`);
    } else if (error) {
      console.error(`  ${char.toUpperCase()} error:`, error.message);
      totalFailed += valid.length;
    } else {
      totalImported += valid.length;
      console.log(`  ${char.toUpperCase()}: ✓ ${valid.length} saved (total: ${totalImported})`);
    }
  }

  console.log(`\n✓ Backfill complete — imported: ${totalImported}, failed: ${totalFailed}`);
}

main().catch(console.error);
