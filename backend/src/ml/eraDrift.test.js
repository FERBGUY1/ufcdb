// node src/ml/eraDrift.test.js — same-date adjustment is exactly zero; antisymmetric across dates.
const assert = require('assert');
const { adjust, table } = require('./eraDrift');

const z = adjust('2024-05-01', '2024-05-01');
assert.strictEqual(z.shift.glicko, 0); assert.strictEqual(z.shift.elo, 0); assert.strictEqual(z.improvement, 0);
const n = adjust(null, '2024-05-01');
assert.strictEqual(n.shift.glicko, 0);

const ab = adjust('2000-06-01', '2025-06-01'), ba = adjust('2025-06-01', '2000-06-01');
assert.ok(Math.abs(ab.shift.glicko + ba.shift.glicko) < 1e-9, 'antisymmetric glicko');
assert.ok(Math.abs(ab.shift.elo + ba.shift.elo) < 1e-9, 'antisymmetric elo');
assert.ok(ab.improvement > 0, 'field improved 2000 -> 2025 under the served table');
assert.strictEqual(ab.reliability, 'low');

const modern = adjust('2012-01-01', '2025-01-01');
assert.strictEqual(modern.reliability, 'normal');
for (const p of table().periods) assert.ok(p.chosen >= 0, 'served drift floored at 0');
console.log('eraDrift: ok', { y2000to2025: ab, modern });
