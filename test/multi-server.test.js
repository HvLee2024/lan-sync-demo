#!/usr/bin/env node
/**
 * 多服务器顺序一致性测试
 * ------------------------------------------------------------
 * 目标：验证"每一端都能当服务器"成立。
 *
 * 以前的实现里，分段的排列顺序由**服务端到达顺序**决定（先到先排）：
 *
 *     state.seq++; seg.seq = state.seq;
 *
 * 这在单服务端下没问题（所有端从它那里拿同一个顺序），
 * 但在"每台设备都内嵌一个服务器"下必然分叉：
 *   · A 的内嵌服务器给某段分配 seq=5
 *   · B 的内嵌服务器同时给它分配 seq=3
 *   → 两个服务器给出不同顺序 → 不收敛
 *
 * 现在顺序改成从**创建键**派生： (createLamport, createDevice, id)
 * 它是一个纯函数，因此：
 *
 *   ① 同一个服务器，同一批操作，无论以什么顺序到达 → 顺序相同
 *   ② 两个互相独立的服务器，处理同一批操作 → 顺序相同
 *   ③ 顺序只由 create 决定 —— 之后谁改写内容，位置都不会跳
 *   ④ 哈希一致（因为哈希里带的就是派生顺序）
 *
 * 用法：node test/multi-server.test.js
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const core = require(path.join(__dirname, '..', 'core.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

/** 按派生顺序取出分段 id 序列（这就是"两个服务器看到的排版顺序"） */
const orderOf = (state) => core.orderedSegments(state).map((s) => s.id).join(',');

/** 生成一批"追加"操作，并记录每个操作在本设备内的序号（用于保序投递） */
function generate(count, devices) {
  const ops = [];
  const perDevice = new Map();
  for (let i = 0; i < count; i++) {
    const device = devices[Math.floor(Math.random() * devices.length)];
    const ord = perDevice.get(device) || 0;
    perDevice.set(device, ord + 1);
    ops.push({
      op: { type: 'create', id: crypto.randomUUID(), text: `第${i}段`, lamport: i + 1 },
      device, order: ord,
    });
  }
  return ops;
}

/** 模拟一台服务器：按收到的顺序应用操作 */
function server(entries) {
  const st = core.emptyState();
  for (const e of entries) core.applyOp(st, e.op, e.device);
  return st;
}

/**
 * 模拟"另一台服务器"：把操作**分批乱序**投递，
 * 但保持每条设备自己的顺序（真实系统里同一设备走同一条连接，天然保序）。
 */
function otherServer(entries) {
  const byDevice = new Map();
  for (const e of entries) {
    if (!byDevice.has(e.device)) byDevice.set(e.device, []);
    byDevice.get(e.device).push(e);
  }
  for (const list of byDevice.values()) list.sort((a, b) => a.order - b.order);

  const queues = [...byDevice.values()];
  const st = core.emptyState();
  while (queues.some((q) => q.length)) {
    const nonEmpty = queues.filter((q) => q.length);
    const q = nonEmpty[Math.floor(Math.random() * nonEmpty.length)];
    const e = q.shift();
    core.applyOp(st, e.op, e.device);
  }
  return st;
}

// ────────────────────────────────────────────────────────────────
section('① 同一服务器：同一批操作、不同到达顺序 → 排列顺序相同');

{
  let ok = true, worst = '';
  for (let round = 0; round < 40; round++) {
    const entries = generate(60, ['dev-a', 'dev-b', 'dev-c', 'dev-d']);
    const base = orderOf(server(entries));
    for (let t = 0; t < 3; t++) {
      const other = orderOf(otherServer(entries));
      if (other !== base) { ok = false; worst = `round ${round}: 顺序不同\n      基线 ${base.slice(0, 120)}\n      乱序 ${other.slice(0, 120)}`; break; }
    }
    if (!ok) break;
  }
  check('40 轮 × 60 次创建 × 3 种乱序 → 排列顺序完全一致', ok, worst);
}

// ────────────────────────────────────────────────────────────────
section('② 两个互相独立的服务器：处理同一批操作 → 顺序与哈希都相同');

{
  let orderOk = true, hashOk = true, worst = '';
  for (let round = 0; round < 40; round++) {
    const entries = generate(50, ['srv-A', 'srv-B', 'srv-C']);

    // 服务器 A：按一个顺序处理
    const A = server(entries);
    // 服务器 B：完全独立地、按另一个顺序处理同一批操作
    const B = otherServer(entries);

    if (orderOf(A) !== orderOf(B)) {
      orderOk = false;
      worst = `round ${round}: 独立服务器得到不同排版顺序`;
      break;
    }
    if (core.stateHash(A) !== core.stateHash(B)) {
      hashOk = false;
      worst = `round ${round}: 独立服务器哈希不同 A=${core.stateHash(A)} B=${core.stateHash(B)}`;
      break;
    }
  }
  check('两台独立服务器得到相同的排列顺序', orderOk, worst);
  check('两台独立服务器得到相同的状态哈希（可直接互相校验）', hashOk, worst);
  console.log('      \x1b[90m这就是"每一端都能当服务器"的前提：顺序不需要任何人授权\x1b[0m');
}

// ────────────────────────────────────────────────────────────────
section('③ 顺序只由 create 决定：之后谁改写内容，位置都不跳');

{
  const st = core.emptyState();
  core.applyOp(st, { type: 'create', id: 's1', text: '第一段', lamport: 1 }, 'dev-a');
  core.applyOp(st, { type: 'create', id: 's2', text: '第二段', lamport: 2 }, 'dev-b');
  core.applyOp(st, { type: 'create', id: 's3', text: '第三段', lamport: 3 }, 'dev-c');
  const before = orderOf(st);

  // 另一台设备用很大的逻辑时钟改写中间那一段
  core.applyOp(st, { type: 'update', segId: 's2', text: '被别的设备改写', lamport: 999 }, 'dev-z');
  const after = orderOf(st);

  check('中间那段被改写后，排列顺序不变', before === after, `${before} → ${after}`);
  check('内容确实变了', core.orderedSegments(st)[1].text === '被别的设备改写');

  // 删除也不改变其余分段的相对顺序
  core.applyOp(st, { type: 'delete', segId: 's1', lamport: 1000 }, 'dev-z');
  const afterDel = core.orderedSegments(st).map((s) => s.id).join(',');
  check('删除后其余分段的相对顺序不变', afterDel === 's1,s2,s3', afterDel);
  check('对外可见列表已过滤墓碑',
    core.visibleSegments(st).map((s) => s.id).join(',') === 's2,s3',
    core.visibleSegments(st).map((s) => s.id).join(','));
}

// ────────────────────────────────────────────────────────────────
section('④ 不用 seq 也能定序：手动打乱内部数组顺序，结果不变');

{
  const st = server(generate(30, ['d1', 'd2', 'd3']));
  const before = orderOf(st);
  // 粗暴地把内部数组反转 —— 模拟"另一台服务器的内存里恰好是另一个插入顺序"
  st.segments.reverse();
  const after = orderOf(st);
  check('内部数组顺序被反转后，对外排列顺序不变', before === after);
}

// ────────────────────────────────────────────────────────────────
section('⑤ 极端情况：两台服务器同时收到"同 lamport 同设备"的不同批次');

{
  // 同 lamport 时靠 deviceId / id 兜底，必须仍然确定
  const mk = (id, lamport, device) => ({ op: { type: 'create', id, text: id, lamport }, device, order: 0 });
  const batch = [
    mk('zzz', 7, 'dev-a'), mk('aaa', 7, 'dev-a'),
    mk('mmm', 7, 'dev-b'), mk('bbb', 7, 'dev-b'),
  ];
  const x = orderOf(server(batch));
  const y = orderOf(otherServer(batch));
  check('同 lamport 下仍有确定的 tiebreak（deviceId → id）', x === y, `${x} vs ${y}`);
  console.log(`      \x1b[90m结果顺序: ${x}\x1b[0m`);
}

// ────────────────────────────────────────────────────────────────
console.log('');
console.log('─'.repeat(64));
console.log(failed === 0 ? `\x1b[32m全部通过\x1b[0m   ${passed} 项断言` : `\x1b[31m失败 ${failed} 项\x1b[0m / 通过 ${passed} 项`);
console.log('─'.repeat(64));
process.exit(failed === 0 ? 0 : 1);
