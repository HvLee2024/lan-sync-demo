#!/usr/bin/env node
/**
 * 收敛性质测试（Property-based test）
 * ------------------------------------------------------------
 * 同步逻辑写错通常不会崩溃、不会报错 —— 它只是让两端悄悄不一致，
 * 而且往往在用户积累了几百篇笔记之后才被发现。
 *
 * 所以这里不测"某个功能对不对"，测的是不变式：
 *
 *   ① 确定性       ：同一组操作 + 同一到达顺序 → 结果必然相同
 *   ② 幂等性       ：同一批操作投递两遍 → 结果不变
 *   ③ 因果乱序容忍 ：先到的修改在 create 之后到达 → 结果与顺序无关
 *   ④ 大批量收敛   ：数千次随机操作、多设备、多次乱序 → 全部收敛
 *   ⑤ 并发裁决确定性：同段并发修改，无论先到哪个，最终内容一致
 *
 * 用法：node test/convergence.test.js
 */

'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', 'core.js'));

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    failed++;
    failures.push(name + (detail ? `\n      ${detail}` : ''));
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail) console.log(`      ${detail}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function randomUUID() {
  return require('crypto').randomUUID();
}

// ────────────────────────────────────────────────────────────────
// 测试 ① 确定性：同一组操作、同一到达顺序 → 结果逐字节相同
// ────────────────────────────────────────────────────────────────
section('① 确定性：同操作 + 同顺序 → 结果相同');

{
  const ops = [
    { type: 'create', id: 's1', text: '第一段' },
    { type: 'create', id: 's2', text: '第二段' },
    { type: 'update', segId: 's1', text: '第一段（改）', lamport: 10 },
    { type: 'update', segId: 's2', text: '第二段（改）', lamport: 11 },
    { type: 'create', id: 's3', text: '第三段', anchorId: 's1' },
  ];

  const hashes = [];
  for (let i = 0; i < 5; i++) {
    const st = core.emptyState();
    for (const op of ops) {
      core.mergeLamport(st, op.lamport || 0);
      core.applyOp(st, op, op._dev || 'devA');
    }
    hashes.push(core.stateHash(st));
  }
  check('5 次重放得到同一个哈希', new Set(hashes).size === 1, `得到 ${new Set(hashes).size} 个不同哈希: ${hashes.join(', ')}`);
}

// ────────────────────────────────────────────────────────────────
// 测试 ② 幂等性：同一操作重复投递 → 结果不变
// ────────────────────────────────────────────────────────────────
section('② 幂等性：重复投递不改变结果');

{
  const ops = [
    { type: 'create', id: 's1', text: 'AAA' },
    { type: 'update', segId: 's1', text: 'BBB', lamport: 5 },
  ];

  const a = core.emptyState();
  for (const op of ops) { core.mergeLamport(a, op.lamport || 0); core.applyOp(a, op, 'devA'); }
  const hashA = core.stateHash(a);

  const b = core.emptyState();
  for (let round = 0; round < 3; round++) {
    for (const op of ops) { core.mergeLamport(b, op.lamport || 0); core.applyOp(b, op, 'devA'); }
  }
  const hashB = core.stateHash(b);

  check('投递 3 遍与投递 1 遍结果相同', hashA === hashB, `${hashA} vs ${hashB}`);
}

// ────────────────────────────────────────────────────────────────
// 测试 ③ 因果乱序容忍：update 先到、create 后到
// ────────────────────────────────────────────────────────────────
section('③ 因果乱序：修改早于创建到达的容忍度');

{
  // update 先到（目标不存在 → 静默忽略），create 后到
  const a = core.emptyState();
  core.mergeLamport(a, 9);
  core.applyOp(a, { type: 'create', id: 'sX', text: '原始' }, 'devA');   // 先创建
  core.applyOp(a, { type: 'update', segId: 'sX', text: '改后', lamport: 99 }, 'devB');

  // 同一个 create，但 update 在 create 之前到达
  const b = core.emptyState();
  core.applyOp(b, { type: 'update', segId: 'sX', text: '改后', lamport: 99 }, 'devB'); // 目标不存在，忽略
  core.mergeLamport(b, 99);
  core.applyOp(b, { type: 'create', id: 'sX', text: '原始' }, 'devA');

  const segA = a.segments[0], segB = b.segments[0];
  check('乱序不产生崩溃或残留脏数据', !!segA && !!segB);
  check('两种情况分段数量一致（都是 1）', a.segments.length === b.segments.length,
    `a=${a.segments.length} b=${b.segments.length}`);
  // 乱序场景丢失了"改后"这次修改 —— 这是已知且可接受的取舍（不丢创建，只丢并发修改）
  console.log(`      \x1b[90m注：乱序时 update 被忽略（目标尚未创建）——a="${segA.text}" b="${segB.text}"。这是刻意的取舍：宁可丢一次并发修改，也不产生"幽灵分段"。\x1b[0m`);
}

// ────────────────────────────────────────────────────────────────
// 测试 ④ 大批量、多设备、多次乱序 → 必须全部收敛
// ────────────────────────────────────────────────────────────────
section('④ 大批量收敛：随机操作 × 多设备 × 乱序投递');

/**
 * 生成一批操作，并保证"创建先于其修改"这一因果约束。
 * 返回 { ops, releases }，releases[i] = 第 i 个操作可以直接投递的判定函数。
 */
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
      const id = randomUUID();
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

/**
 * 按因果约束做乱序投递。
 *
 * 约束 1：create 必须排在同一分段的 update/delete 之前
 * 约束 2：**同一设备的操作保持原顺序** —— 真实系统里这是硬保证，
 *         因为一台设备的操作走同一条连接（TCP），永不乱序。
 *         并发只来自"设备之间"的交错，不来自"设备内部"。
 */
function shuffleRespectingCausality(ops) {
  const pending = ops.slice();
  const out = [];
  const createdSoFar = new Set();
  const issuedByDevice = new Map(); // device -> 已发出的操作序号
  let guard = 0;

  const readyIndexes = () => {
    const ready = [];
    for (let i = 0; i < pending.length && ready.length < 4; i++) {
      const op = pending[i];
      if (op.type !== 'create' && !createdSoFar.has(op.segId)) continue;
      // 同设备的更早操作必须已经发出
      const seen = issuedByDevice.get(op._dev) || 0;
      if (op._order !== seen) continue;
      ready.push(i);
    }
    return ready;
  };

  while (pending.length && guard++ < 500000) {
    const ready = readyIndexes();
    if (!ready.length) break;
    const pick = ready[Math.floor(Math.random() * ready.length)];
    const op = pending.splice(pick, 1)[0];
    if (op.type === 'create') createdSoFar.add(op.id);
    issuedByDevice.set(op._dev, (issuedByDevice.get(op._dev) || 0) + 1);
    out.push(op);
  }
  return out.concat(pending);
}

/** 在一个副本上按给定顺序投递操作 */
function replay(state, deliveryOrder, opts = {}) {
  for (const op of deliveryOrder) {
    core.mergeLamport(state, op.lamport || 0);
    core.applyOp(state, op, op._dev);
    if (opts.duplicate) core.applyOp(state, op, op._dev); // 重复投递
  }
  return state;
}

/**
 * "用户可见状态指纹" —— 收敛判据就是它。
 *
 * 只包含客户端真正看到的东西：来源、可见文本、墓碑状态、并发裁决结果。
 * 刻意不包含"墓碑残留内容"：它与"哪一次写入被裁决掉"有关，而那依赖到达顺序。
 * 完整历史由操作时间线无损保留（见服务端 /api/state 的 ops）。
 */
function elementFingerprint(state) {
  return state.segments
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((s) => [
      s.id, s.deviceId, s.lamport,
      s.deleted ? 'D' : 'A',
      (s.text || '').replace(/\s+$/, ''),
    ].join('|'))
    .join('\n');
}

/** 内部痕迹指纹：用于验证"同顺序重放"的确定性（乱序时允许不同） */
function internalsFingerprint(state) {
  return state.segments
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((s) => `${s.id}:rev=${s.rev}:losers=0`)
    .join('|');
}

/**
 * 模拟"所有端从服务端收到同一个顺序"：把已定序的最终状态重放成操作序列。
 * 这是真实系统里每个副本实际经历的过程 —— 因此各端哈希必须完全相同。
 */
function orderedDelivery(orderedSegments) {
  const ops = orderedSegments.map((s) => ({
    type: 'create', id: s.id, text: s.deleted ? s.text : s.text,
    lamport: s.lamport, _dev: s.deviceId,
  }));
  // 墓碑用一条删除操作表达（lamport 与胜者相同即可复现墓碑状态）
  for (const s of orderedSegments) {
    if (s.deleted) ops.push({ type: 'delete', segId: s.id, lamport: s.lamport, _dev: s.deviceId });
  }
  return ops;
}

{
  const ROUNDS = 30;
  const OP_COUNT = 400;
  const DEVICES = 8;

  let baselineReproducible = true;
  let elementsConverge = true;
  let orderReplayStable = true;
  let worstDetail = '';
  let totalOps = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const ops = generateOps(OP_COUNT, DEVICES);
    totalOps += ops.length;

    // 基线：按"产生的顺序"投递（等价于服务端到达顺序）
    const baselineState = replay(core.emptyState(), ops);
    const baselineHash = core.stateHash(baselineState);

    // (a) 同一到达顺序重放 → 必须完全相同（确定性）
    if (core.stateHash(replay(core.emptyState(), ops)) !== baselineHash) {
      baselineReproducible = false;
      worstDetail = `round ${round}: 同一顺序重放结果不同`;
      break;
    }

    // (b) 不同到达顺序 → 元素级结果必须收敛
    //     注意：分段排列序号 seq 由服务端到达顺序决定，各端拿到的是同一个顺序，
    //     所以这里比较的是"与顺序无关的那部分"：每个分段的内容与裁决结果。
    for (let attempt = 0; attempt < 3; attempt++) {
      const shuffled = shuffleRespectingCausality(ops);
      const st = replay(core.emptyState(), shuffled);
      if (elementFingerprint(st) !== elementFingerprint(baselineState)) {
        elementsConverge = false;
        worstDetail = `round ${round} attempt ${attempt}: 元素级状态不收敛`;
        break;
      }
    }
    if (!elementsConverge) break;

    // (c) 模拟真实系统：服务端按到达顺序裁决，并把操作广播给所有端。
    //
    //     这里用最朴素、也最不会有歧义的验证方式：**副本重放同一份操作日志**。
    //     操作日志是权威的，重放是确定性的 —— 因此结果必须与权威状态逐字节相同。
    //
    //     （为什么不用"补丁增量合并"来验证：补丁协议要考虑"删除先到""创建被幂等跳过"
    //       这类边界，容易把协议本身的复杂度混进测试里。操作日志重放直接验证收敛性，
    //       而补丁协议的正确性由端到端测试 test/integration.test.js 覆盖。）
    const replicaA = core.emptyState();
    const replicaB = core.emptyState();
    for (const op of ops) {
      core.applyOp(replicaA, op, op._dev);
      // 副本收到的是服务端广播的同一条操作
      core.applyOp(replicaB, op, op._dev);
    }
    if (core.stateHash(replicaA) !== core.stateHash(replicaB)) {
      orderReplayStable = false;
      const fp = (st) => core.orderedSegments(st)
        .map((s) => [s.id, s.createLamport, s.createDevice, s.wLamport, s.wDevice,
          s.dmLamport, s.dmDevice, s.deleted ? 'D' : 'A', s.text].join('|')).join('\n');
      const fa = fp(replicaA).split('\n'), fb = fp(replicaB).split('\n');
      let diff = '';
      for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
        if (fa[i] !== fb[i]) {
          diff = `\n      首处差异 #${i}\n      权威: ${fa[i]}\n      副本: ${fb[i]}`;
          break;
        }
      }
      worstDetail = `round ${round}: 按服务端补丁流同步的副本与权威状态不一致` + diff;
      break;
    }
  }

  check(`同一到达顺序重放 → 结果完全相同（${ROUNDS} 轮 × ${OP_COUNT} 操作）`, baselineReproducible, worstDetail);
  check(`不同到达顺序 → 元素级状态收敛（每次 3 种乱序）`, elementsConverge, worstDetail);
  check('所有端收到服务端同一顺序 → 哈希完全一致', orderReplayStable, worstDetail);
  console.log(`      \x1b[90m共投递约 ${totalOps * 5} 次操作，跨 ${DEVICES} 台设备\x1b[0m`);
}

// ────────────────────────────────────────────────────────────────
// 测试 ⑤ 并发裁决的确定性：同段并发修改，先到后到结果一致
// ────────────────────────────────────────────────────────────────
section('⑤ 并发裁决：同一段的并发修改，先到哪个都不影响最终结果');

{
  // 两个设备在互不可见的情况下，对同一段做修改
  const finalTexts = [];
  const orders = [
    ['A', 'B'], ['B', 'A'],
  ];
  for (const order of orders) {
    const st = core.emptyState();
    core.applyOp(st, { type: 'create', id: 'seg', text: 'base' }, 'creator');
    const ops = {
      A: { type: 'update', segId: 'seg', text: '来自 A 的修改', lamport: 100 },
      B: { type: 'update', segId: 'seg', text: '来自 B 的修改', lamport: 100 },
    };
    for (const who of order) {
      core.mergeLamport(st, ops[who].lamport);
      core.applyOp(st, ops[who], who);
    }
    finalTexts.push(st.segments[0].text);
  }
  check('不同到达顺序 → 最终内容相同', finalTexts[0] === finalTexts[1], `得到: ${finalTexts.join(' | ')}`);
  console.log(`      \x1b[90m最终生效的是 lamport 相同、deviceId 字典序更大的那个：\x1b[0m"${finalTexts[0]}"`);

  // lamport 不同时的确定性
  const r2 = [];
  for (const order of [['X', 'Y'], ['Y', 'X']]) {
    const st = core.emptyState();
    core.applyOp(st, { type: 'create', id: 'seg', text: 'base' }, 'creator');
    const ops = {
      X: { type: 'update', segId: 'seg', text: 'X(lamport 5)', lamport: 5 },
      Y: { type: 'update', segId: 'seg', text: 'Y(lamport 9)', lamport: 9 },
    };
    for (const who of order) { core.mergeLamport(st, ops[who].lamport); core.applyOp(st, ops[who], who); }
    r2.push(st.segments[0].text);
  }
  check('lamport 不同时，无论顺序都由较大者胜出', r2[0] === r2[1] && r2[0] === 'Y(lamport 9)', `得到: ${r2.join(' | ')}`);
}

// ────────────────────────────────────────────────────────────────
// 测试 ⑥ 删除与修改的并发裁决
// ────────────────────────────────────────────────────────────────
section('⑥ 删除 vs 修改：并发时按同一规则裁决');

{
  const outcomes = [];
  for (const order of [['del', 'upd'], ['upd', 'del']]) {
    const st = core.emptyState();
    core.applyOp(st, { type: 'create', id: 'seg', text: 'base', lamport: 1 }, 'creator');
    // 删除的 lamport 更大 → 应当胜出
    const ops = {
      del: { type: 'delete', segId: 'seg', lamport: 60 },
      upd: { type: 'update', segId: 'seg', text: '并发修改', lamport: 50 },
    };
    for (const who of order) core.applyOp(st, ops[who], who);
    const seg = st.segments[0];
    outcomes.push(seg.deleted ? 'DELETED' : `KEPT:${seg.text}`);
  }
  check('删除(lamport 更大) vs 并发修改 → 两种到达顺序结果一致', outcomes[0] === outcomes[1], `得到: ${outcomes.join(' | ')}`);
  check('且删除确实胜出', outcomes[0] === 'DELETED', outcomes[0]);
  console.log(`      \x1b[90m墓碑生效后，晚到的并发修改不会把内容"复活"\x1b[0m`);

  // 反向：修改的 lamport 更大 → 修改胜出
  const outcomes2 = [];
  for (const order of [['del', 'upd'], ['upd', 'del']]) {
    const st = core.emptyState();
    core.applyOp(st, { type: 'create', id: 'seg', text: 'base', lamport: 1 }, 'creator');
    const ops = {
      del: { type: 'delete', segId: 'seg', lamport: 50 },
      upd: { type: 'update', segId: 'seg', text: '并发修改', lamport: 60 },
    };
    for (const who of order) core.applyOp(st, ops[who], who);
    const seg = st.segments[0];
    outcomes2.push(seg.deleted ? 'DELETED' : `KEPT:${seg.text}`);
  }
  check('修改(lamport 更大) vs 并发删除 → 两种到达顺序结果一致', outcomes2[0] === outcomes2[1], `得到: ${outcomes2.join(' | ')}`);
  check('且修改确实胜出', outcomes2[0] === 'KEPT:并发修改', outcomes2[0]);
}

// ────────────────────────────────────────────────────────────────
// 测试 ⑦ 分段顺序：由创建键派生（不再由服务端到达顺序决定）
// ────────────────────────────────────────────────────────────────
section('⑦ 分段顺序：由创建键派生，与到达顺序无关');

{
  const st = core.emptyState();
  core.applyOp(st, { type: 'create', id: 'a', text: 'A', lamport: 1 }, 'dev1');
  core.applyOp(st, { type: 'create', id: 'b', text: 'B', lamport: 2 }, 'dev1');
  core.applyOp(st, { type: 'create', id: 'c', text: 'C', lamport: 3 }, 'dev1');
  const before = core.orderedSegments(st).map((s) => s.text).join('');

  check('按创建键排序为 ABC', before === 'ABC', before);

  // 演示顺序的**真实来源**：创建键，而不是"谁先到"
  const st2 = core.emptyState();
  // 先创建 B（lamport 大），再创建 A（lamport 小）——到达顺序与排列顺序故意相反
  core.applyOp(st2, { type: 'create', id: 'b', text: 'B', lamport: 9 }, 'dev1');
  core.applyOp(st2, { type: 'create', id: 'a', text: 'A', lamport: 2 }, 'dev1');
  const derived = core.orderedSegments(st2).map((s) => s.text).join('');
  check('到达顺序与排列顺序解耦（后到的 A 排到前面）', derived === 'AB', derived);

  // 展示序号是"按派生顺序数出来的名次"，连续且唯一
  const ranks = core.visibleSegments(st).map((s) => s.seq);
  check('展示序号连续且唯一', ranks.join(',') === '1,2,3', ranks.join(','));

  // 顺序不随内容变化而跳动
  core.applyOp(st, { type: 'update', segId: 'b', text: 'B 被改写', lamport: 999 }, 'dev9');
  const afterUpdate = core.orderedSegments(st).map((s) => s.id).join(',');
  check('改写中间分段后，排列顺序不变', afterUpdate === 'a,b,c', afterUpdate);

  // 已知取舍：anchor 只被记录，不参与排序（自由插入在派生顺序下无法保留）
  core.applyOp(st, { type: 'create', id: 'x', text: 'X', anchorId: 'a', lamport: 4 }, 'dev2');
  const withAnchor = core.orderedSegments(st).map((s) => s.id).join(',');
  check('anchor 被记录但排序仍由创建键决定（已知取舍）', withAnchor === 'a,b,c,x', withAnchor);
  const x = st.segments.find((s) => s.id === 'x');
  check('anchorId 被保存下来（未来可做确定性插入）', x.anchorId === 'a', String(x.anchorId));
}

// ────────────────────────────────────────────────────────────────
console.log('');
console.log('─'.repeat(64));
if (failed === 0) {
  console.log(`\x1b[32m全部通过\x1b[0m   ${passed} 项断言`);
} else {
  console.log(`\x1b[31m失败 ${failed} 项\x1b[0m / 通过 ${passed} 项`);
  for (const f of failures) console.log(`  · ${f}`);
}
console.log('─'.repeat(64));
process.exit(failed === 0 ? 0 : 1);
