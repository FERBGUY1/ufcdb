require('dotenv').config();
const axios    = require('axios');
const supabase = require('../db/client');

const DRY     = process.argv.includes('--dry-run');
const ALL     = process.argv.includes('--all');
const RETIRED = process.argv.includes('--retired');
const LIMIT   = (() => { const i = process.argv.indexOf('--limit');  return i > -1 ? parseInt(process.argv[i+1]) : null; })();
const OFFSET  = (() => { const i = process.argv.indexOf('--offset'); return i > -1 ? parseInt(process.argv[i+1]) : 0;    })();

const DELAY_MS = 1200;
const sleep    = ms => new Promise(r => setTimeout(r, ms));

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
});

async function loadAll(select) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.from('fighters').select(select).range(offset, offset + 999);
    if (error) throw new Error('loadAll: ' + error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    offset += 1000;
    if (data.length < 1000) break;
  }
  return rows;
}

const UFC_OWNED = new Set(['ufc', 'ufcfightpass']);

function handleFromUrl(profileUrl, domain) {
  try {
    const u = new URL(profileUrl);
    if (!u.hostname.includes(domain)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const handle = parts[0];
    if (!handle || UFC_OWNED.has(handle.toLowerCase())) return null;
    const skip = ['intent','share','search','home','explore','reels','stories','p','channel','c','user'];
    if (skip.includes(handle.toLowerCase())) return null;
    return '@' + handle;
  } catch { return null; }
}

async function fetchSocials(slug) {
  const url = 'https://www.ufc.com/athlete/' + slug;
  let html;
  try {
    const res = await http.get(url);
    html = res.data;
  } catch (err) {
    if (err.response && err.response.status >= 400) return { notFound: true };
    throw err;
  }

  // Extract JSON-LD Person block with sameAs
  const ldBlocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) { try { ldBlocks.push(JSON.parse(m[1])); } catch(e) {} }

  let sameAs = [];
  for (const block of ldBlocks) {
    const items = Array.isArray(block) ? block : [block];
    for (const item of items) {
      if (item['@type'] === 'Person' && Array.isArray(item.sameAs)) { sameAs = item.sameAs; break; }
    }
    if (sameAs.length) break;
  }

  // Fallback: raw JSON string scan
  if (!sameAs.length) {
    const tRe = /"(https?:\/\/(?:twitter|x)\.com\/[^"]+)"/g;
    const iRe = /"(https?:\/\/instagram\.com\/[^"]+)"/g;
    let tm, im;
    while ((tm = tRe.exec(html)) !== null) sameAs.push(tm[1]);
    while ((im = iRe.exec(html)) !== null) sameAs.push(im[1]);
  }

  const result = {};
  for (const pu of sameAs) {
    const u = pu.toLowerCase();
    if ((u.includes('twitter.com') || u.includes('x.com')) && !result.twitter) {
      const h = handleFromUrl(pu, 'twitter.com') || handleFromUrl(pu, 'x.com');
      if (h) result.twitter = h;
    }
    if (u.includes('instagram.com') && !result.instagram) { const h = handleFromUrl(pu, 'instagram.com'); if (h) result.instagram = h; }
    if (u.includes('youtube.com')   && !result.youtube)   { const h = handleFromUrl(pu, 'youtube.com');   if (h) result.youtube   = h; }
    if (u.includes('tiktok.com')    && !result.tiktok)    { const h = handleFromUrl(pu, 'tiktok.com');    if (h) result.tiktok    = h; }
  }
  return result;
}

async function main() {
  console.log('\n====  UFCDB — UFC.com Social Handle Scraper  ====\n');
  if (DRY) console.log('  *** DRY RUN — no DB writes ***\n');
  console.log('Loading fighters from DB...');
  const fighters = await loadAll('id,first_name,last_name,slug,status,instagram,twitter,youtube,tiktok');
  console.log('  ' + fighters.length + ' fighters loaded\n');

  let eligible = RETIRED ? fighters : fighters.filter(f => f.status !== 'released' && f.status !== 'retired');
  let queue = ALL ? eligible : eligible.filter(f => !f.instagram || !f.twitter);
  queue.sort((a, b) => {
    const sA = a.status === 'active' ? 0 : 1, sB = b.status === 'active' ? 0 : 1;
    return sA - sB || a.last_name.localeCompare(b.last_name);
  });

  const final = LIMIT ? queue.slice(OFFSET, OFFSET + LIMIT) : queue.slice(OFFSET);
  console.log('Queue: ' + final.length + ' fighters (' + queue.length + ' total eligible)\n');
  if (!final.length) { console.log('Nothing to do.'); return; }

  let updated = 0, notFound = 0, noData = 0, errors = 0;

  for (let i = 0; i < final.length; i++) {
    const f = final[i];
    const name = f.first_name + ' ' + f.last_name;
    if (i > 0) await sleep(DELAY_MS);

    let socials;
    try { socials = await fetchSocials(f.slug); }
    catch (err) { errors++; console.error('  [ERR] ' + name + ': ' + err.message); continue; }

    if (socials.notFound) { notFound++; if (notFound <= 5 || notFound % 20 === 0) console.log('  [404] ' + name); continue; }

    const patch = {};
    if (socials.instagram && !f.instagram) patch.instagram = socials.instagram;
    if (socials.twitter   && !f.twitter)   patch.twitter   = socials.twitter;
    if (socials.youtube   && !f.youtube)   patch.youtube   = socials.youtube;
    if (socials.tiktok    && !f.tiktok)    patch.tiktok    = socials.tiktok;

    if (!Object.keys(patch).length) { noData++; continue; }

    if (DRY) {
      const fields = Object.entries(patch).map(e => e[0]+'='+e[1]).join(', ');
      console.log('  [DRY] ' + name + ': ' + fields);
      updated++; continue;
    }

    const { error } = await supabase.from('fighters').update(patch).eq('id', f.id);
    if (error) { errors++; console.error('  [ERR] ' + name + ': ' + error.message); }
    else {
      updated++;
      if (updated <= 20 || updated % 25 === 0) {
        const fields = Object.entries(patch).map(e => e[0]+'='+e[1]).join(', ');
        console.log('  [' + updated + '] ' + name + ': ' + fields);
      }
    }

    if ((i+1) % 50 === 0) {
      const pct = Math.round((i+1)/final.length*100);
      console.log('\n  [' + pct + '%] ' + (i+1) + '/' + final.length + ' — updated: ' + updated + ' | 404: ' + notFound + ' | no new data: ' + noData + ' | errors: ' + errors + '\n');
    }
  }

  console.log('\n====  Done  ====');
  console.log('  Updated:       ' + updated);
  console.log('  Not on UFC.com:' + notFound);
  console.log('  No new data:   ' + noData);
  console.log('  Errors:        ' + errors);
}

main().catch(e => { console.error(e); process.exit(1); });
