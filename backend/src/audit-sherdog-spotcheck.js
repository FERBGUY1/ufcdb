/**
 * audit-sherdog-spotcheck.js — Spot-check stored pro records against Sherdog (REPORT ONLY)
 *
 * Samples fighters with pro_wins NOT NULL and a saved sherdog_id, re-fetches each
 * profile, and verifies:
 *   - the profile name still matches the fighter (wrong-profile detection)
 *   - stored pro_wins/pro_losses/pro_draws/pro_nc match the live page
 *   - pro record >= UFC record computed from the fights table
 *
 * Usage: node -r dotenv/config src/audit-sherdog-spotcheck.js [--limit N] [--seed N]
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./db/client');

const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1]) : 20; })();
const SEED = (() => { const i = process.argv.indexOf('--seed'); return i > -1 ? parseInt(process.argv[i + 1]) : 20260612; })();
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log(`Sherdog pro-record spot-check (limit ${LIMIT}, seed ${SEED})\n`);

  const pool = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, sherdog_id, pro_wins, pro_losses, pro_draws, pro_nc, wins, losses')
      .not('pro_wins', 'is', null)
      .not('sherdog_id', 'is', null)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    pool.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  console.log(`${pool.length} fighters have pro record + sherdog_id`);

  const rand = mulberry32(SEED);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const sample = pool.slice(0, LIMIT);

  let ok = 0, mismatch = 0, nameSuspect = 0, fetchFail = 0;
  const issues = [];

  for (const f of sample) {
    await sleep(DELAY);
    const name = `${f.first_name} ${f.last_name}`;
    const url = `https://www.sherdog.com/fighter/${f.sherdog_id}`;
    let $;
    try {
      const { data } = await http.get(url);
      $ = cheerio.load(data);
    } catch (e) {
      fetchFail++;
      console.log(`  FETCH FAIL ${name}: ${url} (${e.message})`);
      continue;
    }
    const grab = cls => {
      const t = $(`div.winloses.${cls} span`).eq(1).text().trim();
      const n = parseInt(t, 10);
      return Number.isNaN(n) ? null : n;
    };
    const live = { w: grab('win'), l: grab('lose'), d: grab('draws') ?? 0, nc: grab('nc') ?? 0 };
    const pageName = $('h1 span.fn').first().text().trim() || $('h1').first().text().trim();

    // identity: slug or page name should contain the fighter's last name
    const slugN = norm(f.sherdog_id);
    const pageN = norm(pageName);
    const lastN = norm(f.last_name);
    const firstN = norm(f.first_name);
    const identityOk = (slugN.includes(lastN) || pageN.includes(lastN)) &&
                       (slugN.includes(firstN) || pageN.includes(firstN) || firstN.length <= 2);
    if (!identityOk) {
      nameSuspect++;
      issues.push(`WRONG PROFILE? ${name} → ${url} (page name: '${pageName}')`);
    }

    if (live.w === null) {
      fetchFail++;
      issues.push(`PARSE FAIL ${name}: ${url} — no winloses block`);
      continue;
    }
    const same = live.w === f.pro_wins && live.l === f.pro_losses &&
                 live.d === (f.pro_draws || 0) && live.nc === (f.pro_nc || 0);
    if (same) { ok++; }
    else {
      mismatch++;
      issues.push(`RECORD DRIFT ${name}: stored ${f.pro_wins}-${f.pro_losses}-${f.pro_draws || 0} (${f.pro_nc || 0} NC) vs live ${live.w}-${live.l}-${live.d} (${live.nc} NC) — ${url}`);
    }
    if (f.pro_wins < (f.wins || 0) || f.pro_losses < (f.losses || 0)) {
      issues.push(`PRO < UFC ${name}: pro ${f.pro_wins}-${f.pro_losses} vs UFC ${f.wins}-${f.losses}`);
    }
    console.log(`  ${same ? 'OK  ' : 'DIFF'} ${name}: stored ${f.pro_wins}-${f.pro_losses}-${f.pro_draws || 0}, live ${live.w}-${live.l}-${live.d}${identityOk ? '' : '  [IDENTITY SUSPECT]'}`);
  }

  console.log(`\nChecked ${sample.length}: ${ok} exact match, ${mismatch} drifted, ${nameSuspect} identity-suspect, ${fetchFail} fetch/parse failures`);
  if (issues.length) { console.log('\nIssues:'); issues.forEach(s => console.log('  ' + s)); }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
