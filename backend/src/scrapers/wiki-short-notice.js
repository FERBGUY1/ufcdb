/**
 * wiki-short-notice.js — late-replacement bouts from Wikipedia event pages.
 *
 * Every UFC event page has a "Background" section whose prose records
 * withdrawals and who stepped in ("... withdrew due to injury and was replaced
 * by X", "X stepped in on short notice"). This script reads that prose for
 * every DB event it can map to a Wikipedia page and writes, per fight, which
 * fighter was the replacement and (when the text says) how many days before
 * the event they were booked.
 *
 * Output (ML training data only — never served, never written to the DB):
 *   src/ml/data/short-notice.json
 *   { generatedAt, events: { mapped, parsed, unmapped: [...] },
 *     fights: { <fightId>: { fighterId, days, cue, sentence } } }
 *
 *   days   notice in days when the text gives one (an explicit date, "two
 *          weeks before", "on the day of the weigh-ins"); null when it only
 *          says "replaced by"
 *   cue    'date' | 'relative' | 'event-day' | 'short-notice' | 'replaced'
 *
 * Wikitext comes from the MediaWiki API (one request per event, 1 s apart) and
 * is cached under backend/.cache/wiki-short-notice so re-runs are offline.
 *
 * Run: node -r dotenv/config src/scrapers/wiki-short-notice.js [--since YYYY] [--limit N] [--dry-run] [--reparse]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] != null ? argv[i + 1] : d; };
const SINCE = opt('since', '2005');
const LIMIT = parseInt(opt('limit', '0'));
const DRY = flag('dry-run');
const REPARSE = flag('reparse');           // ignore the output file and rebuild from the cache
const OUT = path.join(__dirname, '..', 'ml', 'data', 'short-notice.json');
const CACHE = path.join(__dirname, '..', '..', '.cache', 'wiki-short-notice');
const WIKI = 'https://en.wikipedia.org';
const http = axios.create({ timeout: 20000, headers: { 'User-Agent': 'UFCDBBot/1.0 (https://github.com/FERBGUY1/ufcdb; research use, 1 req/s)' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const norm = s => (s || '').toLowerCase().replace(/[łŁ]/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function loadAll(table, cols) {
  const all = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

// ── Wikipedia event list → { name, date, title } ──────────────────────────
async function fetchWikiEventList() {
  const { data } = await http.get(`${WIKI}/wiki/List_of_UFC_events`);
  const $ = cheerio.load(data);
  const events = [];
  const seen = new Set();
  $('table.toccolours, table.wikitable').each((_, table) => {
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 3) return;
      let title = null, name = null;
      for (let i = 0; i < Math.min(3, cells.length); i++) {
        const a = $(cells[i]).find('a[href^="/wiki/"], a[href*="//en.wikipedia.org/wiki/"]').first();
        if (!a.length) continue;
        const href = (a.attr('href') || '').replace(/^(?:https?:)?\/\/en\.wikipedia\.org/, '');
        if (href === '/wiki/UFC' || !/\/wiki\/(UFC|The_Ultimate_Fighter)/i.test(href)) continue;
        title = decodeURIComponent(href.replace(/^\/wiki\//, '')).replace(/#.*$/, '');
        name = a.text().trim();
        break;
      }
      if (!title || seen.has(title)) return;
      const dateTxt = cells.map((_, c) => $(c).text().trim()).get().find(t => /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(t));
      if (!dateTxt) return;
      const d = new Date(dateTxt + ' UTC');
      if (isNaN(d)) return;
      seen.add(title);
      events.push({ name, date: d.toISOString().slice(0, 10), title });
    });
  });
  return events;
}

async function fetchWikitext(title) {
  const file = path.join(CACHE, title.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).wikitext;
  let data;
  for (let attempt = 0; ; attempt++) {
    try { ({ data } = await http.get(`${WIKI}/w/api.php`, { params: { action: 'parse', page: title, prop: 'wikitext', format: 'json', formatversion: 2, redirects: 1 } })); break; }
    catch (e) { if (e.response?.status === 429 && attempt < 4) { await sleep(15000 * (attempt + 1)); continue; } throw e; }
  }
  const wikitext = data?.parse?.wikitext ?? null;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ title, wikitext }));
  await sleep(1500);
  return wikitext;
}

// ── Prose parsing ─────────────────────────────────────────────────────────
const clean = w => w
  .replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '')
  .replace(/\{\{[^{}]*\}\}/g, '').replace(/\{\{[^{}]*\}\}/g, '')
  .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
  .replace(/'{2,}/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function backgroundSentences(wikitext) {
  const m = wikitext.match(/==\s*Background\s*==([\s\S]*?)(?:\n==[^=]|$)/);
  if (!m) return [];
  return clean(m[1]).replace(/===.*?===/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"])/).map(s => s.trim()).filter(Boolean);
}

const NAME = "(\\p{Lu}[\\p{L}'’.-]+(?:\\s(?:de|da|dos|van|von|del|la|le|St\\.|\\p{Lu}[\\p{L}'’.-]+)){0,3})";
const PREFIX = '(?:(?:UFC |promotional |the promotion\'s )?newcomer |former [\\w ]{0,30}?champion |undefeated |fellow [\\w ]{0,20}? |returning |veteran |debuting |an? [\\w-]+ )?';
const REPLACED_BY = new RegExp(`replaced by ${PREFIX}${NAME}`, 'gu');
const STEPPED_IN = new RegExp(`${NAME} (?:stepped in|agreed to step in|took the (?:bout|fight)|accepted the (?:bout|fight)|filled in|was (?:booked|brought in) as (?:a|the|his|her) replacement)`, 'gu');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WORDNUM = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// Days of notice implied by the sentence (and its predecessor), or null.
function noticeDays(text, eventDate) {
  const t = text.toLowerCase();
  const ev = new Date(eventDate + 'T12:00:00Z');
  let m;
  if (/\b(?:on|during) (?:the )?(?:day of|morning of|fight day|day before|weigh-ins?|fight week)\b|day of the (?:event|fight)|at the weigh-ins/.test(t)) return { days: 1, cue: 'event-day' };
  if ((m = /\b(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]+(days?|weeks?)(?:'|’)? (?:before|prior|out|notice|of notice|ahead)/.exec(t))) {
    const n = WORDNUM[m[1]] ?? parseInt(m[1]);
    return { days: m[2].startsWith('week') ? n * 7 : n, cue: 'relative' };
  }
  if ((m = /\b(january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2})(?:,? (\d{4}))?\b/.exec(t))) {
    const y = m[3] ? parseInt(m[3]) : ev.getUTCFullYear();
    let d = new Date(Date.UTC(y, MONTHS.indexOf(m[1]), parseInt(m[2]), 12));
    if (!m[3] && d > ev) d = new Date(Date.UTC(y - 1, MONTHS.indexOf(m[1]), parseInt(m[2]), 12));
    const days = Math.round((ev - d) / 86400000);
    if (days >= 0 && days <= 180) return { days, cue: 'date' };
  }
  if ((m = /\bin (early|mid|late)[\s-]+(january|february|march|april|may|june|july|august|september|october|november|december)\b/.exec(t))) {
    const dom = { early: 5, mid: 15, late: 25 }[m[1]];
    let d = new Date(Date.UTC(ev.getUTCFullYear(), MONTHS.indexOf(m[2]), dom, 12));
    if (d > ev) d = new Date(Date.UTC(ev.getUTCFullYear() - 1, MONTHS.indexOf(m[2]), dom, 12));
    const days = Math.round((ev - d) / 86400000);
    if (days >= 0 && days <= 180) return { days, cue: 'date' };
  }
  if (/short[\s-]notice|late[\s-]notice|late replacement/.test(t)) return { days: null, cue: 'short-notice' };
  return null;
}

function extractReplacements(sentences, eventDate) {
  const out = [];
  sentences.forEach((s, i) => {
    const names = [];
    for (const re of [REPLACED_BY, STEPPED_IN]) { re.lastIndex = 0; let m; while ((m = re.exec(s))) names.push(m[1].replace(/[.,;]$/, '')); }
    if (!names.length) return;
    const ctx = (sentences[i - 1] ? sentences[i - 1] + ' ' : '') + s;
    const notice = noticeDays(s, eventDate) || noticeDays(ctx, eventDate) || { days: null, cue: 'replaced' };
    for (const name of new Set(names)) out.push({ name, ...notice, sentence: s.slice(0, 220) });
  });
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const [events, fights, fighters] = await Promise.all([
    loadAll('events', 'id, name, date'), loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, result'), loadAll('fighters', 'id, first_name, last_name'),
  ]);
  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const fightsByEvent = new Map();
  for (const f of fights) { if (!fightsByEvent.has(f.event_id)) fightsByEvent.set(f.event_id, []); fightsByEvent.get(f.event_id).push(f); }

  const wiki = await fetchWikiEventList();
  const wikiByDate = new Map();
  for (const w of wiki) { if (!wikiByDate.has(w.date)) wikiByDate.set(w.date, []); wikiByDate.get(w.date).push(w); }
  const wikiByName = new Map(wiki.map(w => [norm(w.name), w]));

  const dbEvents = events.filter(e => e.date >= `${SINCE}-01-01` && e.date <= new Date().toISOString().slice(0, 10) && fightsByEvent.has(e.id)).sort((a, b) => a.date.localeCompare(b.date));
  const targets = LIMIT ? dbEvents.slice(-LIMIT) : dbEvents;

  const prev = !REPARSE && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { fights: {} };
  const result = { generatedAt: new Date().toISOString(), events: { candidates: targets.length, mapped: 0, parsed: 0, unmapped: [], noBackground: [] }, fights: { ...prev.fights } };
  const stats = { mentions: 0, matched: 0, unmatchedNames: [], cue: {} };

  for (const ev of targets) {
    const sameDay = wikiByDate.get(ev.date) || [];
    let w = sameDay.length === 1 ? sameDay[0] : sameDay.find(x => norm(x.name) === norm(ev.name)) || wikiByName.get(norm(ev.name));
    if (!w) {
      // ±1 day for time-zone drift
      for (const off of [-1, 1]) {
        const d = new Date(ev.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + off);
        const alt = wikiByDate.get(d.toISOString().slice(0, 10)) || [];
        w = alt.length === 1 ? alt[0] : alt.find(x => norm(x.name) === norm(ev.name));
        if (w) break;
      }
    }
    if (!w) { result.events.unmapped.push(`${ev.date} ${ev.name}`); continue; }
    result.events.mapped++;
    let wikitext;
    try { wikitext = await fetchWikitext(w.title); } catch (e) { console.log(`  ! ${w.title}: ${e.message}`); continue; }
    if (!wikitext) { result.events.unmapped.push(`${ev.date} ${ev.name} (no page: ${w.title})`); continue; }
    const sentences = backgroundSentences(wikitext);
    if (!sentences.length) { result.events.noBackground.push(`${ev.date} ${ev.name}`); continue; }
    result.events.parsed++;
    const evFights = fightsByEvent.get(ev.id);
    const participants = [];
    for (const f of evFights) for (const id of [f.fighter1_id, f.fighter2_id]) if (id && fighterById[id]) participants.push({ id, fightId: f.id, full: norm(`${fighterById[id].first_name} ${fighterById[id].last_name}`), last: norm(fighterById[id].last_name) });
    for (const r of extractReplacements(sentences, ev.date)) {
      stats.mentions++;
      const n = norm(r.name);
      const toks = r.name.split(/\s+/);
      let hit = participants.filter(p => p.full === n);
      if (!hit.length) hit = participants.filter(p => p.last === norm(toks[toks.length - 1]) && toks.length >= 2);
      if (!hit.length && toks.length === 1) hit = participants.filter(p => p.last === n || p.full === n);
      const ids = new Set(hit.map(h => h.id));
      if (ids.size !== 1) { stats.unmatchedNames.push(`${ev.date} ${ev.name}: "${r.name}"`); continue; }
      const h = hit[0];
      stats.matched++;
      stats.cue[r.cue] = (stats.cue[r.cue] || 0) + 1;
      const existing = result.fights[h.fightId];
      // keep the more informative record for a fight already recorded
      if (!existing || (existing.days == null && r.days != null)) result.fights[h.fightId] = { fighterId: h.id, days: r.days, cue: r.cue, sentence: r.sentence };
    }
    if (LIMIT) console.log(`${ev.date} ${ev.name}: ${sentences.length} sentences, ${extractReplacements(sentences, ev.date).length} replacement mentions`);
  }

  const known = Object.values(result.fights);
  console.log(`\nEvents: ${result.events.candidates} candidates, ${result.events.mapped} mapped to Wikipedia, ${result.events.parsed} with a Background section, ${result.events.unmapped.length} unmapped, ${result.events.noBackground.length} without Background`);
  console.log(`Replacement mentions: ${stats.mentions}, matched to a fighter on the card: ${stats.matched}, unmatched names: ${stats.unmatchedNames.length}`);
  console.log(`Cues: ${JSON.stringify(stats.cue)}`);
  console.log(`Fights with a replacement on file: ${known.length}; with days known: ${known.filter(k => k.days != null).length}; days <= 21: ${known.filter(k => k.days != null && k.days <= 21).length}`);
  if (stats.unmatchedNames.length) console.log('Unmatched sample:\n  ' + stats.unmatchedNames.slice(0, 15).join('\n  '));
  if (result.events.unmapped.length) console.log('Unmapped sample:\n  ' + result.events.unmapped.slice(0, 10).join('\n  '));
  result.stats = { mentions: stats.mentions, matched: stats.matched, unmatched: stats.unmatchedNames.length, cue: stats.cue };
  if (!DRY) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); console.log(`Wrote ${OUT}`); }
})();
