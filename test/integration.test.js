#!/usr/bin/env node
/**
 * 端到端集成测试
 * ------------------------------------------------------------
 * 真正启动服务端，用两个独立的 WebSocket 客户端（模拟两台设备）：
 *   · 各自走 /api/login 用权限密码换取令牌
 *   · 同时写入、并发修改同一分段
 *   · 稳定之后比对两端的 stateHash 与可见内容
 *
 * 这是对"HTTP + 自实现 WebSocket + 鉴权 + 同步内核"整条链路的验证，
 * 而单元测试只覆盖了内核。
 *
 * 用法：node test/integration.test.js
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8899;
const PASSCODE = 'test-pass';
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail) console.log(`      ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 测试用客户端 ───────────────────────────
class TestDevice {
  constructor(name, id) {
    this.name = name;
    this.id = id;
    this.token = null;
    this.ws = null;
    this.segments = new Map();
    this.devices = [];
    this.lamport = 0;
    this.seq = 0;
    this.hash = null;
    this.visible = () => [...this.segments.values()].filter((s) => !s.deleted).sort((a, b) => a.seq - b.seq);
  }

  async login() {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: PASSCODE, device: { id: this.id, name: this.name } }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`登录失败: ${data.error}`);
    this.token = data.token;
    return data;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(this.token)}`);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', device: { id: this.id, name: this.name } }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        this.onMessage(msg);
        if (msg.type === 'init') resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket 错误'));
      setTimeout(() => reject(new Error('连接超时')), 4000);
    });
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'init':
        this.segments.clear();
        for (const s of msg.segments) { s.deleted = !!s.deleted; this.segments.set(s.id, s); }
        this.devices = msg.devices || [];
        this.lamport = msg.lamport || 0;
        this.seq = msg.seq || 0;
        this.hash = msg.hash;
        break;
      case 'patches':
        this.lamport = Math.max(this.lamport, msg.lamport || 0);
        this.seq = msg.seq || this.seq;
        for (const p of msg.patches) {
          if (p.kind === 'remove') {
            const cur = this.segments.get(p.segId);
            if (cur) cur.deleted = true;
          } else {
            const seg = Object.assign({}, p.seg, { deleted: !!p.seg.deleted });
            this.segments.set(seg.id, seg);
          }
        }
        if (msg.hash) this.hash = msg.hash;
        break;
      case 'ack':
        this.hash = msg.hash;
        this.lamport = Math.max(this.lamport, msg.lamport || 0);
        break;
      case 'timeline':
        this.lamport = Math.max(this.lamport, msg.lamport || 0);
        if (msg.hash) this.hash = msg.hash;
        if (msg.devices) this.devices = msg.devices;
        break;
      case 'devices':
        this.devices = msg.devices || [];
        break;
      case 'check-result':
        this.hash = msg.hash;
        break;
    }
  }

  nextLamport() { return ++this.lamport; }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  create(text, id) {
    this.send({ type: 'op', op: { type: 'create', id: id || crypto.randomUUID(), text, lamport: this.nextLamport() } });
  }
  update(segId, text, lamport) {
    const lam = lamport !== undefined ? lamport : this.nextLamport();
    if (lamport === undefined) { /* 已自增 */ } else { this.lamport = Math.max(this.lamport, lam); }
    this.send({ type: 'op', op: { type: 'update', segId, text, lamport: lam } });
  }
  del(segId, lamport) {
    const lam = lamport !== undefined ? lamport : this.nextLamport();
    this.send({ type: 'op', op: { type: 'delete', segId, lamport: lam } });
  }
  check() { this.send({ type: 'check' }); }

  async serverState() {
    const res = await fetch(`${BASE}/api/state`, { headers: { Authorization: 'Bearer ' + this.token } });
    return res.json();
  }

  close() { try { this.ws.close(); } catch {} }
}

/** 与服务端/前端一致的哈希（这里直接向服务端索取权威值来比对） */
async function serverHash(token) {
  const res = await fetch(`${BASE}/api/state`, { headers: { Authorization: 'Bearer ' + token } });
  const d = await res.json();
  return d.hash;
}

// ─────────────────────────── 主流程 ───────────────────────────
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-test-'));
  console.log(`\n\x1b[1m启动服务端\x1b[0m  port=${PORT} data=${dataDir}`);

  const server = spawn(process.execPath, [
    path.join(ROOT, 'server.js'),
    '--port', String(PORT),
    '--host', '127.0.0.1',
    '--passcode', PASSCODE,
    '--data', dataDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let serverOut = '';
  server.stdout.on('data', (b) => { serverOut += b.toString(); });
  server.stderr.on('data', (b) => { serverOut += b.toString(); });

  // 等服务端就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/hello`);
      if (r.ok) { ready = true; break; }
    } catch {}
    await sleep(150);
  }
  check('服务端已启动并响应 /api/hello', ready, serverOut.slice(-300));
  if (!ready) { server.kill(); process.exit(1); }

  console.log('\n\x1b[1m鉴权\x1b[0m');

  // 错误密码应被拒绝
  {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'wrong', device: { id: 'x', name: 'x' } }),
    });
    check('错误权限密码被拒绝（401）', res.status === 401, `实际 ${res.status}`);
  }
  {
    const res = await fetch(`${BASE}/api/state`);
    check('未带令牌访问 /api/state 被拒绝（401）', res.status === 401, `实际 ${res.status}`);
  }

  const A = new TestDevice('设备A', 'dev-aaa');
  const B = new TestDevice('设备B', 'dev-bbb');

  await A.login();
  await B.login();
  check('两台设备用正确密码登录成功', !!A.token && !!B.token);

  await A.connect();
  await B.connect();
  check('两台设备 WebSocket 连接并完成 join', A.seq !== undefined && B.seq !== undefined);

  console.log('\n\x1b[1m基本写入与实时同步\x1b[0m');

  A.create('来自设备 A 的第一段');
  await sleep(250);
  check('A 写入后，B 端出现了该分段',
    B.visible().some((s) => s.text === '来自设备 A 的第一段'),
    JSON.stringify(B.visible().map((s) => s.text)));

  B.create('来自设备 B 的第一段');
  await sleep(250);
  check('B 写入后，A 端出现了该分段',
    A.visible().some((s) => s.text === '来自设备 B 的第一段'));

  check('两端分段数量一致', A.visible().length === B.visible().length,
    `A=${A.visible().length} B=${B.visible().length}`);
  check('两端排列顺序一致',
    A.visible().map((s) => s.seq).join(',') === B.visible().map((s) => s.seq).join(','));

  console.log('\n\x1b[1m并发写入同一分段（竞态）\x1b[0m');

  const target = A.visible()[0].id;
  // 两台设备用同一个 lamport，制造真正的并发：只有 deviceId 字典序大的胜出
  A.lamport = Math.max(A.lamport, B.lamport) + 10;
  const raceLamport = A.lamport;
  B.lamport = raceLamport;
  A.update(target, 'A 的并发修改', raceLamport);
  B.update(target, 'B 的并发修改', raceLamport);
  await sleep(400);

  const textA = A.visible().find((s) => s.id === target)?.text;
  const textB = B.visible().find((s) => s.id === target)?.text;
  check('并发修改后两端内容一致', textA === textB, `A="${textA}" B="${textB}"`);
  check('并发裁决结果确定（按 deviceId 规则，两端一致）',
    textA === 'B 的并发修改', `实际 "${textA}"`);
  const raceSegId = target;

  console.log('\n\x1b[1m同步校验：稳定后哈希一致\x1b[0m');

  A.check(); B.check();
  await sleep(300);
  const hA = A.hash, hB = B.hash;
  const sA = await serverHash(A.token);
  check('两台设备与服务端三方的哈希一致', hA === hB && hB === sA,
    `A=${hA} B=${hB} server=${sA}`);

  console.log('\n\x1b[1m删除即墓碑：对外隐藏、对内保留\x1b[0m');

  // 删掉 B 写的那一段（并发竞态改写的是 A 写的那一段，两者互不影响）
  const delTarget = A.visible().find((s) => s.text === '来自设备 B 的第一段').id;
  check('找到待删除的分段', !!delTarget);
  A.del(delTarget);
  await sleep(300);
  check('A 端不再显示该分段', !A.visible().some((s) => s.id === delTarget));
  check('B 端也不再显示该分段', !B.visible().some((s) => s.id === delTarget));
  check('其他分段不受影响（并发竞态改写的分段仍在）',
    A.visible().some((s) => s.id === raceSegId));

  const st = await serverState_fetch(A.token);
  const tomb = st.segments.find((s) => s.id === delTarget);
  check('服务端对外不返回墓碑分段', tomb === undefined);

  A.check(); B.check();
  await sleep(300);
  check('删除后两端哈希仍一致', A.hash === B.hash, `A=${A.hash} B=${B.hash}`);

  console.log('\n\x1b[1m操作时间线：稳定之前的过程被保留\x1b[0m');

  const stateFull = await serverState_fetch(A.token);
  const concurrent = stateFull.ops.filter((o) => o.type === 'update' && o.lamport === raceLamport);
  check('时间线保留了两次并发修改（同一逻辑时钟）', concurrent.length === 2,
    `lamport=${raceLamport} 的记录 ${concurrent.length} 条`);
  check('时间线记录了删除操作', stateFull.ops.some((o) => o.type === 'delete'));

  // 真正会"不生效"的场景：重复投递同一次修改（幂等）或迟到的旧修改
  {
    const segId = raceSegId;
    // 用同一个 lamport 重复投递：内容相同 → 无变化 → applied=false
    A.update(segId, 'B 的并发修改', raceLamport);
    await sleep(300);
    const after = await serverState_fetch(A.token);
    check('重复投递同一操作被识别为不生效（幂等）',
      after.ops.some((o) => o.applied === false),
      `未生效条数=${after.ops.filter((o) => o.applied === false).length}`);

    // 迟到的旧修改（lamport 更小）应当落败，但依然进时间线
    A.update(segId, '一条迟到的旧修改', 1);
    await sleep(300);
    const after2 = await serverState_fetch(A.token);
    const stale = after2.ops.find((o) => o.text === '一条迟到的旧修改');
    check('迟到的旧修改被裁决为不生效', stale && stale.applied === false,
      JSON.stringify(stale));
    check('但落败操作仍然被记入时间线', !!stale);
    const cur = A.visible().find((s) => s.id === segId)?.text;
    check('可见内容未被迟到的旧修改污染', cur === 'B 的并发修改', `实际 "${cur}"`);
  }

  console.log('\n\x1b[1m持久化：重启后状态不丢\x1b[0m');

  const beforeRestart = await serverState_fetch(A.token);
  A.close(); B.close();
  await sleep(200);
  server.kill('SIGINT');
  await sleep(700);

  const server2 = spawn(process.execPath, [
    path.join(ROOT, 'server.js'),
    '--port', String(PORT), '--host', '127.0.0.1',
    '--passcode', PASSCODE, '--data', dataDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready2 = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/hello`); if (r.ok) { ready2 = true; break; } } catch {}
    await sleep(150);
  }
  check('服务端重启成功', ready2);

  const C = new TestDevice('设备A', 'dev-aaa');
  await C.login();
  await C.connect();
  const afterRestart = await C.serverState();
  check('重启后分段数量不变',
    afterRestart.segments.length === beforeRestart.segments.length,
    `${beforeRestart.segments.length} → ${afterRestart.segments.length}`);
  check('重启后哈希不变', afterRestart.hash === beforeRestart.hash,
    `${beforeRestart.hash} → ${afterRestart.hash}`);
  check('重启后时间线不丢', afterRestart.ops.length >= beforeRestart.ops.length);

  C.close();
  server2.kill('SIGINT');
  await sleep(400);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}

  console.log('');
  console.log('─'.repeat(64));
  if (failed === 0) console.log(`\x1b[32m全部通过\x1b[0m   ${passed} 项断言`);
  else {
    console.log(`\x1b[31m失败 ${failed} 项\x1b[0m / 通过 ${passed} 项`);
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log('─'.repeat(64));
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\x1b[31m测试异常终止:\x1b[0m', err);
  process.exit(1);
});

async function serverState_fetch(token) {
  const res = await fetch(`${BASE}/api/state`, { headers: { Authorization: 'Bearer ' + token } });
  return res.json();
}
