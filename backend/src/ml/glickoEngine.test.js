/**
 * glickoEngine.test.js — guardrail: no rating "as of" date D may depend on any
 * bout dated on or after D, regional or UFC.
 *
 *   node -r dotenv/config src/ml/glickoEngine.test.js [--real N]
 *
 * 1. Synthetic: a fixed bout list vs the same list with every bout on/after D
 *    removed, mutated, or with extra same-day bouts added — the as-of-D state of
 *    every fighter must be identical.
 * 2. --real N (default 40): N random (fighter, UFC fight date) probes under the
 *    unified seed on the live data; the state as of D must equal the state from a
 *    replay that only ever sees bouts dated < D (both the UFC rows and the
 *    Sherdog rows are truncated), and the fighter's pre-fight state recorded in
 *    the history must equal both.
 */
const { computeGlicko } = require('./glickoEngine');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL ' + msg); } };
const same = (x, y) => Math.abs(x.r - y.r) < 1e-9 && Math.abs(x.rd - y.rd) < 1e-9;

function synthetic() {
  const ev = { e1: { date: '2020-01-10' }, e2: { date: '2020-06-01' }, e3: { date: '2021-03-15' }, e4: { date: '2021-03-15' } };
  const fight = (id, e, a, b, w, m = 'U-DEC') => ({ id, event_id: e, fighter1_id: a, fighter2_id: b, winner_id: w, result: 'win', method: m });
  const base = [fight('1', 'e1', 'A', 'B', 'A'), fight('2', 'e2', 'B', 'C', 'C', 'KO/TKO'), fight('3', 'e3', 'A', 'C', 'C'), fight('4', 'e4', 'B', 'D', 'B')];
  const sherdog = { byFighter: new Map([['A', [{ date: '2019-05-01', result: 'win', opp: 'x1', ufc: false, finish: true }, { date: '2021-03-15', result: 'win', opp: 'x2', ufc: false, finish: false }]],
                                        ['C', [{ date: '2019-09-09', result: 'loss', opp: 'x1', ufc: false, finish: false }]]]), bySherdog: new Map() };
  for (const seed of ['none', 'record', 'unified']) {
    const full = computeGlicko(base, ev, { seed, sherdog, finishMult: 1.5 });
    const D = '2021-03-15';
    // variant 1: everything on/after D removed (UFC and regional)
    const cut = { byFighter: new Map([...sherdog.byFighter].map(([k, v]) => [k, v.filter(e => e.date < D)])), bySherdog: new Map() };
    const trunc = computeGlicko(base.filter(f => ev[f.event_id].date < D), ev, { seed, sherdog: cut, finishMult: 1.5 });
    // variant 2: results on/after D flipped and extra same-day bouts added
    const flipped = base.map(f => (ev[f.event_id].date >= D ? { ...f, winner_id: f.winner_id === f.fighter1_id ? f.fighter2_id : f.fighter1_id } : f));
    flipped.push(fight('5', 'e4', 'A', 'D', 'D', 'SUB'));
    const mutated = computeGlicko(flipped, ev, { seed, sherdog, finishMult: 1.5 });
    for (const id of ['A', 'B', 'C', 'D']) {
      const s0 = full.stateAsOf(id, D), s1 = trunc.stateAsOf(id, D), s2 = mutated.stateAsOf(id, D);
      check(same(s0, s1), `synthetic ${seed} ${id}: as-of ${D} differs when later bouts are removed (${s0.r.toFixed(3)}/${s0.rd.toFixed(3)} vs ${s1.r.toFixed(3)}/${s1.rd.toFixed(3)})`);
      check(same(s0, s2), `synthetic ${seed} ${id}: as-of ${D} differs when later bouts are mutated`);
      // the pre state recorded on every bout dated D equals the as-of-D state
      for (const e of (full.history.get(id) || []).filter(e => e.date === D)) check(same(e.pre, s0), `synthetic ${seed} ${id}: recorded pre-fight state on ${D} differs from as-of state`);
    }
    // a bout on D must not move the as-of-D state even for the fighter in it: A fights twice on D in `mutated`
    check(same(mutated.stateAsOf('A', D), full.stateAsOf('A', D)), `synthetic ${seed}: same-day bout leaks into as-of state`);
  }
  console.log(`synthetic: ${failures ? failures + ' failure(s)' : 'ok'} (3 seeds x 4 fighters x 3 variants)`);
}

async function real(n) {
  const { loadAll, loadSherdogHistory, FIGHT_COLS } = require('./trainModel');
  const [events, fights, sherdog] = await Promise.all([loadAll('events', 'id, date'), loadAll('fights', FIGHT_COLS), loadSherdogHistory()]);
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const full = computeGlicko(fights, eventById, { seed: 'unified', sherdog, finishMult: 1.5 });
  console.log(`real: unified replay over ${full.bouts} bouts; probing ${n} random fighter/date pairs`);
  const decided = fights.filter(f => f.result === 'win' && eventById[f.event_id] && eventById[f.event_id].date >= '2015-01-01');
  let seedState = 12345; const rnd = () => (seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648;
  const before = failures;
  for (let i = 0; i < n; i++) {
    const f = decided[Math.floor(rnd() * decided.length)];
    const D = eventById[f.event_id].date;
    const id = rnd() < 0.5 ? f.fighter1_id : f.fighter2_id;
    const cutSherdog = { byFighter: new Map([...sherdog.byFighter].map(([k, v]) => [k, v.filter(e => e.date < D)])), bySherdog: sherdog.bySherdog };
    const trunc = computeGlicko(fights.filter(x => eventById[x.event_id] && eventById[x.event_id].date < D), eventById, { seed: 'unified', sherdog: cutSherdog, finishMult: 1.5 });
    const s0 = full.stateAsOf(id, D), s1 = trunc.stateAsOf(id, D);
    check(same(s0, s1), `real ${id} as of ${D}: ${s0.r.toFixed(4)}/${s0.rd.toFixed(4)} vs truncated ${s1.r.toFixed(4)}/${s1.rd.toFixed(4)}`);
    const pre = (full.history.get(id) || []).find(e => e.boutId === `ufc:${f.id}`);
    check(pre && same(pre.pre, s0), `real ${id} as of ${D}: recorded pre-fight state differs from as-of state`);
  }
  console.log(`real: ${failures - before ? failures - before + ' failure(s)' : 'ok'} (${n} probes, ${2 * n} checks)`);
}

(async () => {
  synthetic();
  if (argv.includes('--real')) await real(parseInt(opt('real', '40')));
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ordering checks passed');
  process.exit(failures ? 1 : 0);
})();
