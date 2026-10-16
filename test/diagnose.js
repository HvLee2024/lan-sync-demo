#!/usr/bin/env node
/**
 * 收敛分歧诊断：乱序投递与基线不一致时，逐段找出差异。
 * 用法：node test/diagnose.js [轮数] [操作数]
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const core = require(path.join(__dirname, '..', 'core.js'));

function generateOps(count, deviceCount) {
  const devices = Array.from({ length: deviceCount }, (_, i) => `dev-${i}`);
  const ops = [];
  const createdIds = [];
  const perSegLamport = new Map();
  const perDeviceOrder = new Map();

  for (let i = 0; i < count; i++) {
    const dev = devices[Math.floor(Math.random() * devices.length)];
    const order = perDeviceOrder.get(dev) || 0;
    perDeviceOrder.set(dev, order + 1);
    const roll = Math.random();
    if (createdIds.length === 0 || roll < 0.45) {
      const id = crypto.randomUUID();
      createdIds.push(id);
      ops.push({ type: 'create', id, text: `段落${i}`, _dev: dev, _order: order });
    } else {
      const segId = createdIds[Math.floor(Math.random() * createdIds.length)];
      const lam = (perSegLamport.get(segId) || 0) + 1 + Math.floor(Math.random() * 3);
      perSegLamport.set(segId, lam);
      if (roll < 0.9) ops.push({ type: 'update', segId, text: `第${i}次修改`, lamport: lam, _dev: dev, _order: order });
      else ops.push({ type: 'delete', segId, lamport: lam, _dev: dev, _order: order });
    }
  }
  return ops;
}

function shuffleRespectingCausality(ops) {
  const pending = ops.slice();
  const out = [];
  const created = new Set();
  const issuedByDevice = new Map();
  let guard = 0;

  while (pending.length && guard++ < 500000) {
    const ready = [];
    for (let i = 0; i < pending.length && ready.length < 4; i++) {
      const op = pending[i];
      if (op.type !== 'create' && !created.has(op.segId)) continue;
      if (op._order !== (issuedByDevice.get(op._dev) || 0)) continue;
      ready.push(i);
    }
    if (!ready.length) break;
    const pick = ready[Math.floor(Math.random() * ready.length)];
    const op = pending.splice(pick, 1)[0];
    if (op.type === 'create') created.add(op.id);
    issuedByDevice.set(op._dev, (issuedByDevice.get(op._dev) || 0) + 1);
    out.push(op);
  }
  return out.concat(pending);
}

function replay(ops) {
  const st = core.emptyState();
  for (const op of ops) core.applyOp(st, op, op._dev);
  return st;
}

function fingerprint(st) {
  return st.segments.slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((s) => [s.id, s.deviceId, s.lamport, s.deleted ? "D" : "A", s.text].join("|"))
    .join('\n');
}

const ROUNDS = Number(process.argv[2] || 20);
const OP_COUNT = Number(process.argv[3] || 200);

for (let round = 0; round < ROUNDS; round++) {
  const ops = generateOps(OP_COUNT, 6);
  const base = replay(ops);
  const baseFp = fingerprint(base);

  for (let attempt = 0; attempt < 4; attempt++) {
    const shuffled = shuffleRespectingCausality(ops);
    const sh = replay(shuffled);
    if (fingerprint(sh) === baseFp) continue;

    console.log(`\n\x1b[31m发现分歧\x1b[0m  round=${round} attempt=${attempt}`);

    const byId = (st) => new Map(st.segments.map((s) => [s.id, s]));
    const b = byId(base), s = byId(sh);
    const ids = new Set([...b.keys(), ...s.keys()]);
    let shown = 0;
    for (const id of ids) {
      const x = b.get(id), y = s.get(id);
      const fx = x ? `${x.deviceId}|λ${x.lamport}|${x.deleted ? 'D' : 'A'}|"${x.text}"` : '(缺失/墓碑已清)';
      const fy = y ? `${y.deviceId}|λ${y.lamport}|${y.deleted ? 'D' : 'A'}|"${y.text}"` : '(缺失/墓碑已清)';
      if (fx === fy) continue;
      console.log(`  segment ${id.slice(0, 8)}`);
      console.log(`     基线 : ${fx}`);
      console.log(`     乱序 : ${fy}`);
      // 打印该分段收到的操作序列（按到达顺序）
      const arrivals = (list) => list.filter((o) => o.segId === id || o.id === id)
        .map((o) => `${o.type}(λ${o.lamport || 0},${o._dev})`).join(' → ');
      console.log(`     基线到达顺序 : ${arrivals(ops)}`);
      console.log(`     乱序到达顺序 : ${arrivals(shuffled)}`);
      if (++shown >= 2) { console.log('  …'); break; }
    }
    process.exit(1);
  }
}
console.log(`\x1b[32m${ROUNDS} 轮 × ${OP_COUNT} 操作，未发现元素级分歧\x1b[0m`);
