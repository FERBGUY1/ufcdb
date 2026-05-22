/**
 * Events + Fights scraper â€” ufcstats.com
 * Correct cell indices (confirmed from live HTML inspection 2026-05-21):
 *   cells[0]=W/L, cells[1]=fighters, cells[2]=KD, cells[3]=Str,
 *   cells[4]=TD, cells[5]=Sub, cells[6]=W.Class, cells[7]=Method,
 *   cells[8]=Round, cells[9]=Time
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const BASE  = 'http://ufcstats.com';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').trim();
}

async function getAllEventUrls() {
  const urls = [];
  for (const type of ['completed', 'upcoming']) {
    let page = 1;
    while (true) {
      await sleep(DELAY);
      try {
        const { data } = await http.get(`${BASE}/statistics/events/${type}?page=${page}`);
        const $ = cheerio.load(data);
        const links = $('a[href*="/event-details/"]').map((_,a) => $(a).attr('href')).get();
        if (!links.length) break;
        links.forEach(l => { if (!urls.includes(l)) urls.push(l); });
        if (!$('a:contains("Next")').length) break;
        page++;
      } catch { break; }
    }
  }
  return urls;
}

async function scrapeEvent(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    const name = $('h2.b-content__title-headline').text().trim();
    if (!name) return null;

    const details = {};
    $('li.b-list__box-list-item').each((_,el) => {
      const label = $(el).find('i').text().trim().replace(':','');
      const value = $(el).text().replace($(el).find('i').text(),'').trim();
      if (label && value) details[label] = value;
    });

    const dateStr  = details['Date'];
    const location = details['Location'] || '';
    const parts    = location.split(',').map(s => s.trim());
    const isUpcoming = !dateStr || new Date(dateStr) > new Date();

    const event = {
      ufc_id:      url.split('/').pop(),
      name,
      slug:        toSlug(name),
      date:        dateStr ? new Date(dateStr).toISOString().split('T')[0] : null,
      venue:       details['Venue'] || null,
      city:        parts[0] || null,
      state:       parts[1] || null,
      country:     parts[2] || parts[1] || null,
      is_complete: !isUpcoming,
    };

    const fights = [];
    $('table.b-fight-details__table tbody tr').each((_,row) => {
      const cells = $(row).find('td');
      const f1link = $(cells[1]).find('a').eq(0).attr('href');
      const f2link = $(cells[1]).find('a').eq(1).attr('href');
      if (!f1link || !f2link) return;

      const winCell   = $(cells[0]).text().trim().toLowerCase();
      const wc        = $(cells[6]).find('p').eq(0).text().trim() || $(cells[6]).text().trim();
      const method    = $(cells[7]).find('p').eq(0).text().trim();
      const methodDet = $(cells[7]).find('p').eq(1).text().trim();
      const round     = parseInt($(cells[8]).find('p').eq(0).text().trim() || $(cells[8]).text().trim()) || null;
      const time      = $(cells[9]).find('p').eq(0).text().trim() || $(cells[9]).text().trim();
      const f1Str = $(cells[3]).find('p').eq(0).text().trim() || null;
      const f2Str = $(cells[3]).find('p').eq(1).text().trim() || null;
      const f1TD  = $(cells[4]).find('p').eq(0).text().trim() || null;
      const f2TD  = $(cells[4]).find('p').eq(1).text().trim() || null;

      let result = null;
      if (winCell.includes('win'))       result = 'win';
      else if (winCell.includes('draw')) result = 'draw';
      else if (winCell.includes('nc'))   result = 'no_contest';
      else if (isUpcoming)               result = 'upcoming';

      const isTitleFight   = /title/i.test(wc);
      const isInterimTitle = /interim/i.test(wc);
      // Normalize wc name for DB lookup (strip "UFC ", " Title Bout", " Bout" etc.)
      const wcNorm = wc
        .replace(/^ufc\s+/i, '')
        .replace(/\s+(interim\s+)?title\s+bout$/i, '')
        .replace(/\s+bout$/i, '')
        .trim();

      fights.push({
        fighter1_ufc_id: f1link.split('/').pop(),
        fighter2_ufc_id: f2link.split('/').pop(),
        result, method, method_detail: methodDet, round, time,
        weight_class_name: wcNorm || wc,
        is_title_fight:    isTitleFight,
        is_interim_title:  isInterimTitle,
        fighter1_sig_str: f1Str, fighter2_sig_str: f2Str,
        fighter1_td: f1TD, fighter2_td: f2TD,
      });
    });

    return { event, fights };
  } catch (e) {
    console.error(`  Error scraping ${url}:`, e.message);
    return null;
  }
}

async function main() {
  console.log('â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
  console.log('â•‘  UFCDB â€” Events + Fights Scraper     â•‘');
  console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');

  const fighterMap = {};
  let fPage = 0;
  while (true) {
    const { data: batch } = await supabase.from('fighters').select('id, ufc_id').not('ufc_id','is',null).range(fPage*1000,(fPage+1)*1000-1);
    if (!batch?.length) break;
    batch.forEach(f => { fighterMap[f.ufc_id] = f.id; });
    if (batch.length < 1000) break;
    fPage++;
  }
  console.log(`  ${Object.keys(fighterMap).length} fighters mapped\n`);

  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcMap = {};
  for (const wc of wcs || []) wcMap[wc.name] = wc.id;

  const eventUrls = await getAllEventUrls();
  console.log(`Found ${eventUrls.length} events\n`);

  let eventsImported = 0, fightsImported = 0, eventsFailed = 0;

  for (let i = 0; i < eventUrls.length; i++) {
    await sleep(DELAY);
    const result = await scrapeEvent(eventUrls[i]);
    if (!result) { eventsFailed++; continue; }

    const { event, fights } = result;

    const { data: eventData, error: eventErr } = await supabase
      .from('events').upsert(event, { onConflict: 'ufc_id' }).select('id').single();
    if (eventErr || !eventData) { eventsFailed++; continue; }
    eventsImported++;

    const fightRows = [];
    let boutIdx = 0;
    for (const f of fights) {
      const f1id = fighterMap[f.fighter1_ufc_id];
      const f2id = fighterMap[f.fighter2_ufc_id];
      if (!f1id || !f2id) continue;
      fightRows.push({
        event_id: eventData.id, fighter1_id: f1id, fighter2_id: f2id,
        bout_order: boutIdx++,
        result: f.result, method: f.method, method_detail: f.method_detail,
        round: f.round, time: f.time,
        is_title_fight: f.is_title_fight || false,
        weight_class_id: wcMap[f.weight_class_name] || null,
        fighter1_sig_str: f.fighter1_sig_str || null,
        fighter2_sig_str: f.fighter2_sig_str || null,
        fighter1_td: f.fighter1_td || null,
        fighter2_td: f.fighter2_td || null,
      });
    }

    if (fightRows.length > 0) {
      const { error: fightErr } = await supabase.from('fights').insert(fightRows);
      if (fightErr && !fightErr.message?.includes('duplicate')) {
        console.error(`  Fights insert error (${event.name}):`, fightErr.message);
      } else { fightsImported += fightRows.length; }
    }

    if (eventsImported % 25 === 0 || i < 5)
      console.log(`[${i+1}/${eventUrls.length}] Events: ${eventsImported} | Fights: ${fightsImported}`);
  }

  console.log('\nDone â€” Events: '+eventsImported+' | Fights: '+fightsImported+' | Failed: '+eventsFailed);
}

main().catch(console.error);

