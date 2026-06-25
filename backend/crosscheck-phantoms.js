/**
 * READ-ONLY Wikipedia cross-check of the 61 phantom candidates (audit item 3).
 * For each: is the bout on the event's actual Wikipedia card?
 *   ON-CARD  -> real fight, do NOT delete (score instead; report winner/method/flip)
 *   OFF-CARD -> not on card -> safe to delete
 *   UNRESOLVABLE -> wiki page missing or unparseable -> PENDING (neither)
 * Also re-confirms all 61 are empty shells + have no FK refs.
 * Wiki parsing/matching copied verbatim from audit-2026.js. NO WRITES.
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('./src/db/client');

const http  = axios.create({ timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0)' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── verbatim from audit-2026.js ──────────────────────────────────────────────
function norm(s){return (s||'').toLowerCase().replace(/[łŁ]/g,'l').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');}
const NAME_MAP={'rongzhu':'rongzhurongzhu','aoriqileng':'aoriqilengaoriqileng','alatengheili':'alatengheilialatengheili','yizha':'yizhayizha','sumudaerji':'sumudaerjisumudaerji','maheshate':'maheshatemaheshate','mizuki':'mizukimizuki','iangarry':'ianmachadogarry','markomadsen':'markmadsen','josemigueldelgado':'josedelgado','bobbygreen':'kinggreen','charlieradtke':'charlesradtke','zachscroggin':'zacharyscroggin','billygoff':'billyraygoff','montserratrendon':'montserendon','daunjung':'dawoonjung','baysangursusurkaev':'baisangursusurkaev','assualmabayev':'asualmabayev','bernardosopaj':'benardosopaj','raffaelcerqueira':'rafaelcerqueira','zacharyreese':'zachreese','kleidisonrodrigues':'kleydsonrodrigues','teciatorres':'teciapennington','sulangrangbo':'sulangrangbosulangrangbo','choidooho':'doohochoi','parkjunyong':'junyongpark','kimsangwook':'sangwookkim','dommarfan':'dominickmarfan','timothycuamba':'timmycuamba'};
function applyMap(n){return NAME_MAP[n]||n;}
function normLookup(raw,byName){if(!raw)return null;const n=norm(raw);return byName[n]||byName[applyMap(n)]||null;}
function parseMethod(raw){if(!raw)return null;const up=raw.toUpperCase().trim();if(/^KO.?TKO$/.test(up)||up==='TKO'||up==='KO')return'KO/TKO';if(up==='SUBMISSION'||up==='SUB')return'SUB';if(up.includes('UNANIMOUS'))return'U-DEC';if(up.includes('SPLIT'))return'S-DEC';if(up.includes('MAJORITY'))return'M-DEC';if(/^DECISION$/.test(up))return'DEC';if(up==='NO CONTEST'||up==='NC')return'NC';if(up.includes('DISQUALIF')||up==='DQ')return'DQ';if(up==='OVERTURNED')return'Overturned';if(up==='CNC'||up.includes('CANNOT CONTINUE'))return'CNC';if(up.includes('DRAW'))return'Draw';return null;}
function detectSection($,table){const hdr=$(table).find('tr').first().find('th[colspan]').first().text().toLowerCase();if(/early.?prelim/i.test(hdr))return'early_prelim';if(/prelim/i.test(hdr))return'prelim';if(/main.?card/i.test(hdr))return'main_card';return null;}
function isFightCard($,table){const ths=$(table).find('th').map((_,th)=>$(th).text().toLowerCase().trim()).get().join('|');if(/title fights in \d{4}|current.*champions/i.test(ths))return false;if($(table).find('tr').filter((_,tr)=>$(tr).find('td').length>0).length>30)return false;return(ths.includes('weight')||ths.includes('class'))&&(ths.includes('method')||(ths.includes('round')&&ths.includes('time')));}
async function fetchWikiResults(wikiUrl){
  await sleep(1300);
  try{
    const {data}=await http.get(wikiUrl);
    const $=cheerio.load(data);
    const out=[];
    $('table.toccolours, table.wikitable').each((_,table)=>{
      if(!isFightCard($,table))return;
      $(table).find('tr').each((_,row)=>{
        const cells=$(row).find('td');
        if(cells.length<5)return;
        let winnerIdx=-1,verbIdx=-1,loserIdx=-1;
        cells.each((ci,cell)=>{const t=$(cell).text().trim().toLowerCase();if((t==='def.'||t==='drew'||t==='vs.'||t==='nc')&&ci>0){if(verbIdx===-1){verbIdx=ci;winnerIdx=ci-1;loserIdx=ci+1;}}});
        if(verbIdx===-1||winnerIdx<0||loserIdx>=cells.length)return;
        const verb=$(cells[verbIdx]).text().trim().toLowerCase();
        const f1raw=$(cells[winnerIdx]).text().replace(/\([ic]\)/gi,'').replace(/\[\w+\]/g,'').trim();
        const f2raw=$(cells[loserIdx]).text().replace(/\([ic]\)/gi,'').replace(/\[\w+\]/g,'').trim();
        if(!f1raw||!f2raw||f1raw.length>60||f2raw.length>60)return;
        let methodRaw='',roundRaw='',timeRaw='';
        cells.each((ci,cell)=>{if(ci<=loserIdx)return;const t=$(cell).text().trim();if(!methodRaw&&/decision|submission|ko|tko|draw|no contest|nc|dq/i.test(t))methodRaw=t;else if(!roundRaw&&/^\d$/.test(t))roundRaw=t;else if(!timeRaw&&/^\d:\d{2}$/.test(t))timeRaw=t;});
        const method=parseMethod(methodRaw);
        const round=parseInt(roundRaw)||null;
        const time=timeRaw||null;
        let result='win',winner='f1';
        if(verb==='drew'||methodRaw.toLowerCase().includes('draw')){result='draw';winner=null;}
        else if(verb==='nc'||methodRaw.toLowerCase().includes('no contest')){result='no_contest';winner=null;}
        out.push({f1:f1raw,f2:f2raw,result,winner,method,round,time});
      });
    });
    return out;
  }catch(e){return null;} // null = fetch error
}
function headlinerKey(name){const colon=name.indexOf(':');const hl=colon>=0?name.slice(colon+1):name;const parts=hl.split(/\s+vs\.?\s+/i).map(p=>norm(p));return parts.sort().join(':');}
async function loadAll(table,cols,filt){const all=[];let p=0;while(true){let q=supabase.from(table).select(cols).range(p*1000,p*1000+999);if(filt)q=filt(q);const{data}=await q;if(!data?.length)break;all.push(...data);if(data.length<1000)break;p++;}return all;}

// match a DB fighter pair to a wiki bout (audit-style: norm + applyMap, both orders, last-name fallback)
function matchWiki(n1,n2,wikiBouts){
  for(const wb of wikiBouts){
    const a=norm(wb.f1),b=norm(wb.f2);
    const A=[a,applyMap(a)],B=[b,applyMap(b)];
    if((A.includes(n1)&&B.includes(n2))||(A.includes(n2)&&B.includes(n1)))return wb;
  }
  // last-name fallback
  const l1=n1, l2=n2; // n already compact; compare suffix on last token handled below
  return null;
}
function matchWikiLastName(dbF1Last,dbF2Last,wikiBouts){
  for(const wb of wikiBouts){
    const a=norm(wb.f1.trim().split(/\s+/).pop()),b=norm(wb.f2.trim().split(/\s+/).pop());
    if((a.endsWith(dbF1Last)&&b.endsWith(dbF2Last))||(a.endsWith(dbF2Last)&&b.endsWith(dbF1Last))||(dbF1Last.endsWith(a)&&dbF2Last.endsWith(b))||(dbF1Last.endsWith(b)&&dbF2Last.endsWith(a)))return wb;
  }
  return null;
}

async function main(){
  const TODAY=new Date().toISOString().slice(0,10);
  const cands=(await loadAll('fights','id,event_id,fighter1_id,fighter2_id,winner_id,result,method,method_detail,round,time,created_at',q=>q.is('result',null)))
    .filter(f=>f.created_at>='2026-05-28T00:00:00'&&f.created_at<'2026-05-29T00:00:00');
  const events=await loadAll('events','id,name,date,slug');
  const E=Object.fromEntries(events.map(e=>[e.id,e]));
  const phantom=cands.filter(f=>E[f.event_id]&&E[f.event_id].date<TODAY).sort((a,b)=>E[a.event_id].date.localeCompare(E[b.event_id].date));

  const fids=[...new Set(phantom.flatMap(f=>[f.fighter1_id,f.fighter2_id]).filter(Boolean))];
  const allF=await loadAll('fighters','id,first_name,last_name');
  const byName={};allF.forEach(f=>{const full=norm((f.first_name||'')+(f.last_name||''));if(full)byName[full]=f.id;const m=applyMap(full);if(m!==full)byName[m]=f.id;});
  const F=Object.fromEntries(allF.map(f=>[f.id,f]));
  const nm=id=>F[id]?`${F[id].first_name} ${F[id].last_name}`:(id?id.slice(0,8):'null');
  const dbNorm=id=>F[id]?norm((F[id].first_name||'')+(F[id].last_name||'')):'';
  const dbLast=id=>F[id]?norm((F[id].last_name||F[id].first_name||'')):'';

  // wiki list
  const wikiByNorm={},wikiByHead={};
  {const{data}=await http.get('https://en.wikipedia.org/wiki/List_of_UFC_events');const $=cheerio.load(data);const seen=new Set();
   $('table.toccolours, table.wikitable').each((_,t)=>{$(t).find('tr').each((_,r)=>{const c=$(r).find('td');if(c.length<3)return;for(let i=0;i<Math.min(4,c.length);i++){const a=$(c[i]).find('a[href^="/wiki/"]').first();if(!a.length)continue;const h=a.attr('href')||'';if(h==='/wiki/UFC')return;if(/List_of|Category:|Template:|Help:|Wikipedia:/i.test(h))continue;if(!/\/wiki\/(UFC|WEC_|The_Ultimate_Fighter|Strikeforce|PRIDE)/i.test(h))continue;if(seen.has(h))return;let d=null;c.each((_,x)=>{const m=$(x).text().trim().match(/(\w+ \d{1,2},? \d{4})/);if(m){const dt=new Date(m[1]);if(!isNaN(dt))d=dt.toISOString().slice(0,10);}});if(d){seen.add(h);const we={name:a.text().trim(),wikiUrl:'https://en.wikipedia.org'+h};wikiByNorm[norm(a.text().trim())]=we;const hk=headlinerKey(a.text().trim());if(!wikiByHead[hk])wikiByHead[hk]=we;}break;}});});}

  function resolveWiki(ev){
    let w=wikiByNorm[norm(ev.name)];if(w)return w;
    const short=norm(ev.name).replace(/^ufc/,'');for(const[wn,we]of Object.entries(wikiByNorm)){if(wn.replace(/^ufc/,'')===short)return we;}
    return wikiByHead[headlinerKey(ev.name)]||null;
  }

  // cache wiki results per event
  const wikiCache={};
  const byEvent={};phantom.forEach(f=>{(byEvent[f.event_id]=byEvent[f.event_id]||[]).push(f);});

  const ON=[],OFF=[],PENDING=[];
  for(const eid of Object.keys(byEvent)){
    const ev=E[eid];
    const we=resolveWiki(ev);
    if(!we){ byEvent[eid].forEach(f=>PENDING.push({f,why:'wiki page not found'})); continue; }
    if(!(eid in wikiCache)) wikiCache[eid]=await fetchWikiResults(we.wikiUrl);
    const wikiBouts=wikiCache[eid];
    if(wikiBouts===null){ byEvent[eid].forEach(f=>PENDING.push({f,why:'wiki fetch error'})); continue; }
    if(!wikiBouts.length){ byEvent[eid].forEach(f=>PENDING.push({f,why:'wiki page had no parseable card'})); continue; }
    for(const f of byEvent[eid]){
      const n1=dbNorm(f.fighter1_id),n2=dbNorm(f.fighter2_id);
      let wb=matchWiki(n1,n2,wikiBouts);
      if(!wb)wb=matchWikiLastName(dbLast(f.fighter1_id),dbLast(f.fighter2_id),wikiBouts);
      if(wb){
        const winnerId=wb.result==='win'?normLookup(wb.f1,byName):null;
        ON.push({f,wb,winnerId});
      }else{
        OFF.push({f,wikiName:we.name,nBouts:wikiBouts.length});
      }
    }
  }

  // ── re-confirm empty shells + FK for all 61 ──────────────────────────────
  const notEmpty=phantom.filter(f=>f.winner_id||f.method||f.round||f.time);
  const ids=phantom.map(f=>f.id);
  let odds=[],flags=[];
  for(let i=0;i<ids.length;i+=100){const{data}=await supabase.from('odds').select('id,fight_id').in('fight_id',ids.slice(i,i+100));if(data)odds.push(...data);}
  for(let i=0;i<ids.length;i+=100){const{data}=await supabase.from('data_flags').select('id,entity_id').in('entity_id',ids.slice(i,i+100));if(data)flags.push(...data);}

  // ── REPORT ───────────────────────────────────────────────────────────────
  console.log(`\n############ CROSS-CHECK OF ${phantom.length} CANDIDATES ############`);
  console.log(`\nSPLIT:  OFF-CARD(delete)=${OFF.length}   ON-CARD(score)=${ON.length}   PENDING(unresolved)=${PENDING.length}\n`);

  console.log(`======== ON-CARD — REAL FIGHTS, DO NOT DELETE (${ON.length}) ========`);
  for(const {f,wb,winnerId} of ON){
    const flip=winnerId&&winnerId===f.fighter2_id;
    const winTxt=wb.result==='win'?(winnerId?nm(winnerId):`UNRESOLVED("${wb.f1}")`):wb.result.toUpperCase();
    const side=winnerId?(winnerId===f.fighter1_id?'fighter1':(winnerId===f.fighter2_id?'fighter2 -> FLIP':'NEITHER?!')):'n/a';
    console.log(`  [${E[f.event_id].date}] ${nm(f.fighter1_id)} vs ${nm(f.fighter2_id)} (${f.id.slice(0,8)}) @ ${E[f.event_id].name}`);
    console.log(`       wiki: winner=${winTxt} method=${wb.method||'?'} R${wb.round||'?'} ${wb.time||'?'}  | winner side=${side}${flip?'  <<< NEEDS FLIP':''}`);
    if(f.method) console.log(`       (DB already has method=${f.method} R${f.round||'?'} ${f.time||'?'})`);
  }

  console.log(`\n======== PENDING — COULD NOT RESOLVE, LEAVE ALONE (${PENDING.length}) ========`);
  for(const {f,why} of PENDING) console.log(`  [${E[f.event_id].date}] ${nm(f.fighter1_id)} vs ${nm(f.fighter2_id)} (${f.id.slice(0,8)}) @ ${E[f.event_id].name}  -- ${why}`);

  console.log(`\n======== OFF-CARD — SAFE TO DELETE (${OFF.length}) ========`);
  for(const {f,nBouts} of OFF) console.log(`  [${E[f.event_id].date}] ${nm(f.fighter1_id)} vs ${nm(f.fighter2_id)} (${f.id.slice(0,8)}) @ ${E[f.event_id].name}  (wiki card had ${nBouts} bouts, pair absent)`);

  console.log(`\n======== RE-CONFIRM: EMPTY SHELLS + FK (all ${phantom.length}) ========`);
  console.log(`  candidates with ANY result data (winner/method/round/time): ${notEmpty.length}`);
  notEmpty.forEach(f=>console.log(`     ${f.id.slice(0,8)} ${nm(f.fighter1_id)} vs ${nm(f.fighter2_id)} method=${f.method} R${f.round} ${f.time}`));
  console.log(`  odds rows referencing any candidate: ${odds.length}`);
  console.log(`  data_flags referencing any candidate: ${flags.length}`);

  // cross-check: are the only non-empty ones all ON-CARD? (sanity)
  const offIds=new Set(OFF.map(x=>x.f.id));
  const offNonEmpty=notEmpty.filter(f=>offIds.has(f.id));
  console.log(`  OFF-CARD rows that are NOT empty shells (should be 0): ${offNonEmpty.length}`);
  offNonEmpty.forEach(f=>console.log(`     !! ${f.id.slice(0,8)} ${nm(f.fighter1_id)} vs ${nm(f.fighter2_id)} method=${f.method}`));
}
main().catch(e=>{console.error('FATAL',e.message,e.stack);process.exit(1);});
