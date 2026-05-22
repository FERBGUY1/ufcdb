/**
 * Refresh fighter stats + record for all fighters in DB.
 * Uses correct selectors (li not ul, span not p).
 * Only updates numeric fields — does not touch slugs.
 *
 * Usage: node src/scrapers/refresh-stats.js
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
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
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limit = pLimit(2);

function parseRecord(record) {
  if (!record) return null;
  const m  = record.match(/(\d+)-(\d+)-(\d+)/);
  const nc = record.match(/\((\d+)\s*NC\)/i);
  if (!m) return null;
  return {
    wins: parseInt(m[1]), losses: parseInt(m[2]), draws: parseInt(m[3]),
    no_contests: nc ? parseInt(nc[1]) : 0,
  };
}

function parseNum(val) {
  if (!val || val === '--') return null;
  const n = parseFloat(String(val).replace('%', ''));
  return isNaN(n) ? null : n;
}

async function scrapeStats(ufc_id) {
  try {
    const { data } = await http.get(`${BASE}/fighter-details/${ufc_id}`);
    const $ = cheerio.load(data);

    const recordText = $('span.b-content__title-record').text().replace('Record:', '').trim();
    const rec = parseRecord(recordText);

    const items = {};
    $('li.b-list__box-list-item_type_block').each((_, el) => {
      const label = $(el).find('i').text().trim().replace(':', '');
      const value = $(el).text().replace($(el).find('i').text(), '').trim();
      if (label && value && value !== '--') items[label] = value;
    });

    return {
      ...(rec || {}),
      slpm:    parseNum(items['SLpM']),
      sapm:    parseNum(items['SApM']),
      str_acc: parseNum(items['Str. Acc.']),
      str_def: parseNum(items['Str. Def']),
      td_avg:  parseNum(items['TD Avg.']),
      td_acc:  parseNum(items['TD Acc.']),
      td_def:  parseNum(items['TD Def.']),
      sub_avg: parseNum(items['Sub. Avg.']),
      last_synced_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  UFCDB — Stats Refresh               ║');
  console.log('╚══════════════════════════════════════╝\n');

  let updated = 0, failed = 0, pageNum = 0;
  const PAGE = 200;

  while (true) {
    const { data: fighters } = await supabase
      .from('fighters')
      .select('id, ufc_id, first_name, last_name')
      .not('ufc_id', 'is', null)
      .range(pageNum * PAGE, (pageNum + 1) * PAGE - 1)
      .order('last_name');

    if (!fighters?.length) break;
    console.log(`Page ${pageNum + 1}: ${fighters.length} fighters`);

    const results = await Promise.all(
      fighters.map(f => limit(async () => {
        await sleep(DELAY);
        const stats = await scrapeStats(f.ufc_id);
        if (!stats) { failed++; return; }

        const { error } = await supabase
          .from('fighters')
          .update(stats)
          .eq('id', f.id);

        if (error) { failed++; }
        else { updated++; }
      }))
    );

    console.log(`  Updated so far: ${updated} | Failed: ${failed}`);
    if (fighters.length < PAGE) break;
    pageNum++;
  }

  console.log(`\n✓ Done — updated: ${updated}, failed: ${failed}`);
}

main().catch(console.error);
