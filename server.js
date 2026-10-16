#!/usr/bin/env node
/**
 * 局域网实时同步 Demo —— 服务端
 * ------------------------------------------------------------
 * 设计目标（对应产品原则）：
 *   1. 逻辑上一份文件，物理上多份副本 —— 每台设备（端）都是一份完整副本
 *   2. 写入永不阻塞：端可随时本地写入，不等服务端确认
 *   3. 服务端只做"机械一致性"：保留真实操作顺序 + 确定性排序，不做语义裁决
 *   4. 稳定后收敛：所有活跃端收到全部操作后，各端状态逐字节一致
 *   5. 稳定之前的分叉被保留：服务端记录完整操作日志（时间线）
 *
 * 零第三方依赖：只使用 Node 内置模块（http / fs / crypto）。
 * 云端部署：node server.js --port 8787，前面可挂反向代理。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const core = require('./core');

// ---------------------------------------------------------------- 配置
const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  port: Number(args.port || process.env.PORT || 8787),
  host: args.host || process.env.HOST || '0.0.0.0',
  passcode: args.passcode || process.env.SYNC_PASSCODE || '1111',
  dataDir: path.resolve(args.data || process.env.SYNC_DATA || path.join(__dirname, 'data')),
  publicDir: path.join(__dirname, 'public'),
  activeWindowMs: 45000, // 多久没心跳算"离线端"
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 时间与哈希
function nowMs() { return Date.now(); }

/** 墙钟时间字符串（仅用于日志展示，绝不参与任何排序） */
/** 规范化哈希：用于"同步校验"，判定两端状态是否逐字节一致 */
const stateHash = (s) => core.stateHash(s);

// ---------------------------------------------------------------- 数据层
/**
 * 一份"逻辑文件"的权威状态。
 * 分段模型：文件 = 一串分段（segment），每个分段记录它的来源设备。
 * 这是"每台设备内容独立成层、可重叠查看"的数据基础。
 */
let state = null;

function emptyState() {
  return core.emptyState();
}

function loadState() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const file = path.join(CONFIG.dataDir, 'state.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    state = Object.assign(emptyState(), parsed);
    // 重算逻辑时钟上界，避免重启后时钟回退
    let maxLamport = 0;
    for (const s of state.segments) maxLamport = Math.max(maxLamport, s.lamport || 0);
    for (const o of state.ops) maxLamport = Math.max(maxLamport, o.lamport || 0);
    state.lamport = Math.max(state.lamport || 0, maxLamport);
    // 重启后所有端都算离线，等它们各自连接上来
    for (const d of Object.values(state.devices)) { d.online = false; d.conns = 0; }
    console.log(`[state] 已载入 ${file} —— ${core.visibleSegments(state).length} 个可见分段（另有墓碑 ${state.segments.filter((x) => x.deleted).length} 个）/ ${state.ops.length} 条操作记录`);
  } catch (e) {
    state = emptyState();
    console.log('[state] 新建空白文档');
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const file = path.join(CONFIG.dataDir, 'state.json');
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file); // 原子写入：断电不坏档
    } catch (e) {
      console.error('[state] 保存失败:', e.message);
    }
  }, 400);
}

// ---------------------------------------------------------------- 同步内核（共用 core.js）
/**
 * 服务端在同步中的角色 —— 只做"机械一致性"，不做任何语义裁决：
 *
 *   1. 保留真实操作顺序：所有到达的操作都进时间线（含未生效的并发操作）
 *   2. 确定性排序：分段显示顺序由服务端分配的 seq 决定（先到先排）
 *   3. 并发裁决：同一分段的冲突修改，按 (lamport, deviceId) 比较，字典序大的胜出
 *   4. 提供权威哈希：供各端做"同步校验"，判定是否已收敛
 *
 * 这三条都不解释用户意图，只保证"所有副本算出来的结果相同"。
 */
function applyOp(op, deviceId) {
  return core.applyOp(state, op, deviceId);
}

function publicSeg(s, displaySeq) {
  return core.publicSeg(s, displaySeq);
}

/** 服务端维护的逻辑时钟：合并客户端 lamport，保证不回退 */
function mergeLamport(clientLamport) {
  return core.mergeLamport(state, clientLamport);
}

function recordOp(op, deviceId, lamport, extra) {
  return core.recordOp(state, op, deviceId, lamport, extra);
}

// ---------------------------------------------------------------- 设备台账
function touchDevice(device, isConnect) {
  if (!device || !device.id) return null;
  let d = state.devices[device.id];
  if (!d) {
    d = {
      id: device.id,
      name: device.name || '未命名设备',
      firstSeen: nowMs(),
      lastSeen: 0,
      opCount: 0,
      conns: 0,
      online: false,
    };
    state.devices[device.id] = d;
  }
  if (device.name) d.name = device.name;
  d.lastSeen = nowMs();
  if (isConnect) d.conns = (d.conns || 0) + 1;
  d.online = true;
  return d;
}

function markOffline(deviceId) {
  const d = state.devices[deviceId];
  if (!d) return;
  d.conns = Math.max(0, (d.conns || 0) - 1);
  if (d.conns === 0) d.online = false;
}

function deviceList() {
  const now = nowMs();
  return Object.values(state.devices)
    .map((d) => ({
      id: d.id,
      name: d.name,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      opCount: d.opCount || 0,
      online: !!d.online && now - d.lastSeen < CONFIG.activeWindowMs,
      active: now - d.lastSeen < CONFIG.activeWindowMs,
    }))
    .sort((a, b) => a.firstSeen - b.firstSeen);
}

// ---------------------------------------------------------------- 鉴权
const tokens = new Map(); // token -> { deviceId, issuedAt, lastUsed }

function issueToken(deviceId) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { deviceId, issuedAt: nowMs(), lastUsed: nowMs() });
  return token;
}

function checkToken(token) {
  if (!token) return null;
  const rec = tokens.get(token);
  if (!rec) return null;
  rec.lastUsed = nowMs();
  return rec;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // --- 登录：用权限密码换取会话令牌
  if (pathname === '/api/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }); }

    if (!safeEqual(body.passcode || '', CONFIG.passcode)) {
      return sendJSON(res, 401, { ok: false, error: '权限密码不正确' });
    }
    const device = body.device || {};
    if (!device.id) return sendJSON(res, 400, { ok: false, error: '缺少设备标识' });
    const d = touchDevice(device, false);
    const token = issueToken(device.id);
    scheduleSave();
    console.log(`[auth] ${d.name} (${device.id.slice(0, 8)}) 已登录`);
    return sendJSON(res, 200, { ok: true, token, seq: state.seq });
  }

  // --- 公开：局域网服务自述（用于错误提示，无需鉴权）
  if (pathname === '/api/hello') {
    return sendJSON(res, 200, {
      ok: true, service: 'lan-sync-demo', version: 1,
      segments: core.visibleSegments(state).length,
      devices: deviceList().length,
      needPasscode: true,
    });
  }

  // --- 以下接口需要令牌
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
  const auth = checkToken(token);

  if (pathname === '/api/state') {
    if (!auth) return sendJSON(res, 401, { ok: false, error: '未授权' });
    return sendJSON(res, 200, {
      ok: true,
      hash: stateHash(state),
      seq: state.seq,
      lamport: state.lamport,
      segments: core.visibleSegments(state),   // 已过滤墓碑（对外不可见，对内保留）
      devices: deviceList(),
      ops: state.ops.slice(-80).reverse(),
    });
  }

  if (pathname === '/api/devices') {
    if (!auth) return sendJSON(res, 401, { ok: false, error: '未授权' });
    return sendJSON(res, 200, { ok: true, devices: deviceList() });
  }

  // --- 静态资源
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.join(CONFIG.publicDir, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
  if (!resolved.startsWith(CONFIG.publicDir)) { res.writeHead(403); res.end('Forbidden'); return; }
  return sendFile(res, resolved);
});

// ---------------------------------------------------------------- WebSocket（自实现，零依赖）
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 把一个已升级的 socket 包装成极简 WebSocket 连接。
 * 只实现 demo 需要的部分：文本帧、ping/pong、关闭、分片。
 */
function makeConnection(socket) {
  const conn = {
    socket,
    alive: true,
    buffer: Buffer.alloc(0),
    handlers: { message: () => {}, close: () => {} },
    send(obj) {
      if (!this.alive) return;
      try { socket.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'))); }
      catch { this.destroy(); }
    },
    destroy() {
      this.alive = false;
      try { socket.destroy(); } catch {}
    },
  };

  socket.on('data', (chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    let guard = 0;
    while (guard++ < 1000) {
      let frame;
      try { frame = decodeFrame(conn.buffer); }
      catch (e) { conn.destroy(); return; }
      if (!frame) break;
      conn.buffer = conn.buffer.subarray(frame.total);

      if (frame.opcode === 0x8) { conn.destroy(); return; }
      if (frame.opcode === 0x9) { // ping -> pong
        try { socket.write(encodeFrame(frame.payload, 0xA)); } catch {}
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        conn.handlers.message(frame.payload.toString('utf8'));
      }
    }
  });

  const finish = () => {
    if (!conn.alive) return;
    conn.alive = false;
    conn.handlers.close();
  };
  socket.on('close', finish);
  socket.on('end', finish);
  socket.on('error', finish);
  return conn;
}

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** 返回 { opcode, payload, total } 或 null（数据不完整） */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 0x7fffffffn) throw new Error('frame too large');
    len = Number(big); offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  return { opcode, payload, total: offset + len };
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }

  const auth = checkToken(url.searchParams.get('token'));
  if (!auth) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  attachClient(makeConnection(socket), auth.deviceId);
});

// ---------------------------------------------------------------- 客户端会话
const clients = new Set();

function attachClient(conn, deviceId) {
  const client = { conn, deviceId, joined: false };
  clients.add(client);

  conn.handlers.message = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(client, msg);
  };

  conn.handlers.close = () => {
    clients.delete(client);
    markOffline(deviceId);
    broadcast({ type: 'devices', devices: deviceList() });
    scheduleSave();
    const d = state.devices[deviceId];
    if (d) console.log(`[ws] ${d.name} 断开 (剩余 ${clients.size} 个连接)`);
  };
}

function handleMessage(client, msg) {
  const { conn, deviceId } = client;

  if (msg.type === 'join') {
    const d = touchDevice({ id: deviceId, name: msg.device?.name }, true);
    client.joined = true;
    recordOp({ type: 'join' }, deviceId, state.lamport);
    conn.send({
      type: 'init',
      seq: state.seq,
      lamport: state.lamport,
      hash: stateHash(state),
      segments: core.visibleSegments(state),   // 已过滤墓碑（对外不可见，对内保留）
      devices: deviceList(),
      ops: state.ops.slice(-80).reverse(),
      serverTime: nowMs(),
    });
    broadcast({ type: 'devices', devices: deviceList() }, (c) => c !== client);
    console.log(`[ws] ${d.name} 加入 (当前在线连接 ${clients.size})`);
    scheduleSave();
    return;
  }

  if (msg.type === 'ping') {
    touchDevice({ id: deviceId }, false);
    conn.send({ type: 'pong', serverTime: nowMs(), lamport: state.lamport });
    return;
  }

  if (msg.type === 'op') {
    const op = msg.op || {};

    // 重要：**不要**在这里调用 mergeLamport 去"放大"操作的逻辑时钟。
    // 一旦服务端改写 op.lamport，到达顺序就会渗进并发裁决，系统立刻不收敛。
    // 逻辑时钟由客户端生成、服务端只做比较；state.lamport 的推进由 core.applyOp 负责。
    const patches = applyOp(op, deviceId);
    const incomingLamport = Number(op.lamport) || 0;

    // 无论操作是否产生了变化，都记入时间线：
    // 这是"稳定之前的分叉与异步过程必须被保留"的落点。
    const entry = recordOp(op, deviceId, incomingLamport);
    entry.applied = patches.length > 0;

    const d = state.devices[deviceId];
    if (d) { d.opCount = (d.opCount || 0) + 1; d.lastSeen = nowMs(); }

    if (patches.length > 0) {
      broadcast({
        type: 'patches',
        patches,
        seq: state.seq,
        lamport: state.lamport,
        hash: stateHash(state),
        by: deviceId,
      });
    }
    // 时间线对所有人可见（包括操作者本人），这样能看到"未生效的并发操作"
    broadcast({
      type: 'timeline',
      entry,
      seq: state.seq,
      lamport: state.lamport,
      hash: stateHash(state),
      devices: deviceList(),
    }, (c) => c !== client);
    conn.send({
      type: 'ack',
      hash: stateHash(state),
      seq: state.seq,
      lamport: state.lamport,
      applied: patches.length > 0,
      patches,
    });
    scheduleSave();
    return;
  }

  if (msg.type === 'check') {
    // "同步校验"：服务端权威哈希，供各端比对
    conn.send({
      type: 'check-result',
      hash: stateHash(state),
      seq: state.seq,
      segments: core.visibleSegments(state).length,
      devices: deviceList(),
      serverTime: nowMs(),
    });
    return;
  }
}

function broadcast(obj, filter) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = encodeFrame(data);
  for (const c of clients) {
    if (!c.joined) continue;
    if (filter && !filter(c)) continue;
    if (!c.conn.alive) continue;
    try { c.conn.socket.write(frame); } catch { c.conn.destroy(); }
  }
}

// ---------------------------------------------------------------- 心跳与清理
setInterval(() => {
  const now = nowMs();
  let changed = false;
  for (const d of Object.values(state.devices)) {
    if (d.online && now - d.lastSeen > CONFIG.activeWindowMs) { d.online = false; changed = true; }
  }
  if (changed) broadcast({ type: 'devices', devices: deviceList() });
}, 10000);

// ---------------------------------------------------------------- 启动
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

loadState();
server.listen(CONFIG.port, CONFIG.host, () => {
  const ips = lanAddresses();
  console.log('');
  console.log('  ╭──────────────────────────────────────────────────────╮');
  console.log('  │  局域网实时同步 Demo —— 服务端已启动                  │');
  console.log('  ╰──────────────────────────────────────────────────────╯');
  console.log('');
  console.log(`  本机访问 : http://localhost:${CONFIG.port}`);
  for (const ip of ips) console.log(`  局域网   : http://${ip}:${CONFIG.port}`);
  console.log('');
  console.log(`  权限密码 : ${CONFIG.passcode}`);
  console.log(`  数据文件 : ${path.join(CONFIG.dataDir, 'state.json')}`);
  console.log('');
  console.log('  用同一局域网的手机/平板/另一台电脑打开上面的「局域网」地址即可。');
  console.log('  按 Ctrl+C 停止服务。');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n[exit] 正在保存并退出…');
  try {
    const file = path.join(CONFIG.dataDir, 'state.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch {}
  process.exit(0);
});
