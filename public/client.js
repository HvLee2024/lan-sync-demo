/* ════════════════════════════════════════════════════════════
   局域网实时同步 Demo —— 前端
   ------------------------------------------------------------
   这一端 = "一个副本"。所有设备都跑这份代码，各持一份完整副本。
   写入立刻在本地生效（不等待服务端），服务端负责机械一致性：
     保留真实操作顺序 + 用 (lamport, deviceId) 做确定性裁决。
   稳定之后，所有副本的 stateHash 相同。
   ════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─────────────────────────── 设备身份 ───────────────────────────
  const ADJ = ['青', '蓝', '绿', '橙', '紫', '红', '灰', '金', '银', '墨'];
  const NOUN = ['笔记本', '平板', '手机', '台式机', '小主机', '阅读器'];

  const LS = {
    get id() { return localStorage.getItem('lsd.deviceId'); },
    set id(v) { localStorage.setItem('lsd.deviceId', v); },
    get name() { return localStorage.getItem('lsd.deviceName'); },
    set name(v) { localStorage.setItem('lsd.deviceName', v); },
    get token() { return localStorage.getItem('lsd.token'); },
    set token(v) { v ? localStorage.setItem('lsd.token', v) : localStorage.removeItem('lsd.token'); },
  };

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  if (!LS.id) LS.id = uuid();
  if (!LS.name) LS.name = ADJ[Math.floor(Math.random() * ADJ.length)] + NOUN[Math.floor(Math.random() * NOUN.length)];
  const MY_ID = LS.id;

  // 设备 → 固定的颜色与徽标（同一个设备在所有端上颜色一致）
  const PALETTE = ['#4c8dff', '#35c98a', '#f0a63c', '#c471ed', '#f2585b', '#00bcd4', '#ff8f5e', '#8bc34a', '#e91e8c', '#7e8ba3'];
  const GLYPHS = ['◆', '●', '■', '▲', '★', '✦', '⬢', '◐', '✚', '❖'];
  function devHash(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Math.abs(h);
  }
  function devColor(id) { return PALETTE[devHash(id) % PALETTE.length]; }
  function devGlyph(id) { return GLYPHS[devHash(id) % GLYPHS.length]; }

  // ─────────────────────────── 本地状态（本副本） ───────────────────────────
  const S = {
    token: LS.token,
    ws: null,
    connected: false,
    joined: false,
    segments: new Map(),      // id -> seg
    devices: [],
    ops: [],
    lamport: 0,
    seq: 0,
    serverHash: null,
    localHash: null,
    view: 'merged',
    baseText: new Map(),      // 每个分段"上次与服务端同步"的文本，用于检测本地改动
    focusDefer: new Set(),    // 正在编辑中被远端更新推迟刷新的分段
    outbox: [],               // 断线期间待发操作
    lastServerTime: 0,
    lastSyncAt: 0,
  };

  // ─────────────────────────── 工具 ───────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const hhmmss = (ts) => {
    const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  /**
   * 分段排列顺序 —— 与服务端 core.compareOrder **逐字对应**。
   *
   * 顺序从"创建键"派生： (createLamport, createDevice, id)
   * 不用服务端分配的 seq。原因是"每一端都能当服务器"：
   * 顺序必须是纯函数，任何一个服务器/副本都要算出同样的结果，
   * 不能依赖"谁先到达服务端"。
   */
  function compareOrder(a, b) {
    const la = Number(a.createLamport) || 0;
    const lb = Number(b.createLamport) || 0;
    if (la !== lb) return la - lb;
    const da = String(a.createDevice || '');
    const db = String(b.createDevice || '');
    if (da !== db) return da < db ? -1 : 1;
    const ia = String(a.id || '');
    const ib = String(b.id || '');
    if (ia === ib) return 0;
    return ia < ib ? -1 : 1;
  }

  /** 按派生顺序排序（含墓碑） */
  const orderedSegments = () => [...S.segments.values()].sort(compareOrder);

  /** 按派生顺序排序后的可见分段（过滤墓碑） */
  const visibleSegments = () => orderedSegments().filter((s) => !s.deleted);

  /** 兼容旧调用点：sortedSegments 现在等于 orderedSegments */
  const sortedSegments = orderedSegments;

  /**
   * 与服务端 core.stateHash 完全相同的规范化哈希（多端比对即可判定收敛）。
   * 逐字段对应，任何一处不一致都会让"同步校验"永远报警。
   */
  function stateHash(segments) {
    const canonical = segments.slice()
      .sort(compareOrder)
      .map((s) => [
        s.id,
        s.createLamport, s.createDevice,
        s.deviceId, s.wLamport, s.wDevice,
        s.dmLamport, s.dmDevice,
        s.deleted ? 'D' : 'A',
        (s.text || '').replace(/\s+$/, ''),
      ].join('\u0001'))
      .join('\u0002');
    return sha16(canonical);
  }
  function sha16(str) {
    // 同步实现的 SHA-256（避免异步 crypto.subtle 带来的时序复杂性）
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const bytes = new TextEncoder().encode(str);
    const bitLen = bytes.length * 8;
    const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
    withPad.set(bytes);
    withPad[bytes.length] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
    dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296), false);

    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
        h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    const w = new Uint32Array(64);
    for (let i = 0; i < withPad.length; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(w[t-15],7) ^ rotr(w[t-15],18) ^ (w[t-15] >>> 3);
        const s1 = rotr(w[t-2],17) ^ rotr(w[t-2],19) ^ (w[t-2] >>> 10);
        w[t] = (w[t-16] + s0 + w[t-7] + s1) >>> 0;
      }
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
      for (let t = 0; t < 64; t++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h=g; g=f; f=e; e=(d + t1) >>> 0; d=c; c=b; b=a; a=(t1 + t2) >>> 0;
      }
      h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
      h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
    }
    return [h0,h1,h2,h3,h4,h5,h6,h7].map((x) => x.toString(16).padStart(8, '0')).join('').slice(0, 16);
  }

  // ─────────────────────────── 登录 ───────────────────────────
  $('#gate-name').value = LS.name;

  async function login(passcode) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode, device: { id: MY_ID, name: LS.name } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `登录失败（HTTP ${res.status}）`);
    return data.token;
  }

  $('#gate-btn').addEventListener('click', doLogin);
  $('#gate-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#gate-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    const pass = $('#gate-pass').value.trim();
    const name = $('#gate-name').value.trim();
    if (!pass) { $('#gate-msg').textContent = '请输入权限密码'; return; }
    if (name) { LS.name = name; }
    $('#gate-msg').textContent = '正在连接…';
    $('#gate-btn').disabled = true;
    try {
      S.token = await login(pass);
      LS.token = S.token;
      enterApp();
    } catch (err) {
      $('#gate-msg').textContent = err.message;
      $('#gate-btn').disabled = false;
    }
  }

  function enterApp() {
    $('#gate').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#me').innerHTML = '';
    const badge = el('span', 'dev-badge');
    badge.textContent = devGlyph(MY_ID);
    badge.style.background = devColor(MY_ID);
    $('#me').append(badge, el('span', null, `本设备：${LS.name}`));
    connect();
    if (window.innerWidth > 880) $('#new-text').focus();
  }

  // ─────────────────────────── WebSocket ───────────────────────────
  let reconnectTimer = null;

  function connect() {
    clearTimeout(reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}`;
    let ws;
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
    S.ws = ws;

    ws.onopen = () => {
      S.connected = true;
      setConn('on', '已连接，正在加入…');
      ws.send(JSON.stringify({ type: 'join', device: { id: MY_ID, name: LS.name }, token: S.token }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServer(msg);
    };

    ws.onclose = () => {
      S.connected = false;
      S.joined = false;
      setConn('off', '连接断开，正在重连…');
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose 会接手 */ };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (S.token) connect();
    }, 1500);
  }

  function setConn(state, text) {
    const dot = $('#conn-dot');
    dot.className = 'dot ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : '');
    $('#conn-text').textContent = text;
  }

  function send(obj) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /** 发起一个本地操作：本地状态立刻生效（本地优先），再投递给服务端 */
  function submitOp(op) {
    // 允许调用方指定逻辑时钟（编辑分段时需要"必然胜出"的键）；
    // 否则本地时钟自增一。
    S.lamport = (typeof op.lamport === 'number') ? Math.max(S.lamport, op.lamport) : S.lamport + 1;
    const full = Object.assign({}, op, { lamport: S.lamport });
    applyLocalOptimistic(full);              // 立刻在本地生效 —— 写入不等待
    if (!send({ type: 'op', op: full })) {
      S.outbox.push(full);                   // 断线：排队，恢复后重放
    }
  }

  function flushOutbox() {
    if (!S.connected) return;
    const pending = S.outbox.splice(0, S.outbox.length);
    for (const op of pending) send({ type: 'op', op });
  }

  // ─────────────────────────── 本地乐观应用 ───────────────────────────
  /** 与内核完全一致的裁决规则：比较 (lamport, deviceId) 有序对 */
  function beats(opLamport, opDevice, refLamport, refDevice) {
    const a = Number(opLamport) || 0;
    const b = Number(refLamport);
    if (b === undefined || b === null || Number.isNaN(b)) return true;
    if (a !== b) return a > b;
    return String(opDevice) > String(refDevice);
  }

  /**
   * 生成一个"必然胜出"的逻辑时钟：
   * 取本端与目标分段当前键的较大者再 +1。
   *
   * 这一步在真实产品里对应"客户端逻辑时钟跟随已知最大键前进"（Lamport 时钟的标准做法）。
   * 没有它，一台长时间离线、之后重连的设备会带着很小的时钟回来，
   * 它的每一次编辑都会被裁决掉 —— 用户会觉得"我打字没反应"。
   */
  function winningKey(seg) {
    const a = S.lamport;
    const b = seg && typeof seg.lamport === 'number' ? seg.lamport : 0;
    return Math.max(a, b) + 1;
  }

  function applyLocalOptimistic(op) {
    if (op.type === 'create') {
      // 本地先给一个临时 seq（很大的值），服务端分配的真实 seq 到达后会纠正
      const tmpSeq = 1e9 + (S.segments.size);
      const seg = {
        id: op.id, seq: tmpSeq, deviceId: MY_ID, text: op.text,
        createLamport: op.lamport, createDevice: MY_ID,
        wLamport: op.lamport, wDevice: MY_ID,
        dmLamport: -1, dmDevice: '',
        lamport: op.lamport, rev: 1, deleted: false,
        createdAt: Date.now(), updatedAt: Date.now(), _local: true,
      };
      S.segments.set(seg.id, seg);
      S.baseText.set(seg.id, seg.text);
      renderAll();
      return;
    }
    const seg = S.segments.get(op.segId);
    if (!seg) return;

    if (op.type === 'update') {
      // 只用同一个裁决规则做本地预演；服务端返回权威补丁后会覆盖。
      // 事件监听器里的卫兵会拦住"键更小的写入"，所以这里基本总成立。
      if (!beats(op.lamport, MY_ID, seg.lamport, seg.deviceId)) return;
      seg.text = op.text;
      seg.lamport = op.lamport;
      seg.deviceId = MY_ID;
      seg.wLamport = op.lamport;    // 裁决键：与内核一样独立保存
      seg.wDevice = MY_ID;
      seg.deleted = false;          // 键更大的写入让墓碑失效（与内核一致）
      seg.rev = (seg.rev || 0) + 1;
      seg.updatedAt = Date.now();
      S.baseText.set(seg.id, seg.text);
      renderAll();
      return;
    }

    if (op.type === 'delete') {
      // 墓碑：对外隐藏、对内保留（与服务端一致）
      seg.deleted = true;
      seg.deletedText = seg.text;
      seg.rev = (seg.rev || 0) + 1;
      renderAll();
    }
  }

  // ─────────────────────────── 服务端消息 ───────────────────────────
  function handleServer(msg) {
    switch (msg.type) {
      case 'init': {
        S.joined = true;
        S.segments.clear();
        S.baseText.clear();
        for (const s of msg.segments) {
          s.deleted = !!s.deleted;
          if (s.wLamport === undefined) s.wLamport = s.lamport;
          if (s.wDevice === undefined) s.wDevice = s.deviceId;
          if (s.dmLamport === undefined) s.dmLamport = -1;
          if (s.dmDevice === undefined) s.dmDevice = '';
          if (s.createLamport === undefined) s.createLamport = s.lamport;
          if (s.createDevice === undefined) s.createDevice = s.deviceId;
          S.segments.set(s.id, s);
          S.baseText.set(s.id, s.text);
        }
        S.devices = msg.devices || [];
        S.ops = msg.ops || [];
        S.lamport = Math.max(S.lamport, msg.lamport || 0);
        S.seq = msg.seq || 0;
        S.serverHash = msg.hash;
        setConn('on', '已连接');
        renderAll();
        flushOutbox();
        updateHashPanel();
        break;
      }
      case 'patches': {
        S.lamport = Math.max(S.lamport, msg.lamport || 0);
        S.seq = msg.seq || S.seq;
        for (const p of msg.patches) {
          if (p.kind === 'upsert') {
            const incoming = p.seg;
            incoming.deleted = !!incoming.deleted;
            if (incoming.wLamport === undefined) incoming.wLamport = incoming.lamport;
            if (incoming.wDevice === undefined) incoming.wDevice = incoming.deviceId;
            if (incoming.dmLamport === undefined) incoming.dmLamport = -1;
            if (incoming.dmDevice === undefined) incoming.dmDevice = '';
            if (incoming.createLamport === undefined) incoming.createLamport = incoming.lamport;
            if (incoming.createDevice === undefined) incoming.createDevice = incoming.deviceId;
            const cur = S.segments.get(incoming.id);
            // 正在编辑的分段：先记住，失焦后再刷新，避免打断输入
            if (cur && document.activeElement && document.activeElement.dataset
                && document.activeElement.dataset.segId === incoming.id) {
              S.focusDefer.add(incoming.id);
              S.segments.set(incoming.id, incoming);
              S.baseText.set(incoming.id, incoming.text);
              continue;
            }
            S.segments.set(incoming.id, incoming);
            S.baseText.set(incoming.id, incoming.text);
            flash(incoming.id);
          } else if (p.kind === 'patch') {
            // 只更新裁决键（不改可见性、不换内容）——
            // 删除键参与哈希，所以这一条也必须收下
            const cur = S.segments.get(p.segId);
            if (cur) {
              if (p.dmLamport !== undefined) cur.dmLamport = p.dmLamport;
              if (p.dmDevice !== undefined) cur.dmDevice = p.dmDevice;
              if (p.rev !== undefined) cur.rev = p.rev;
            }
          } else if (p.kind === 'remove') {
            // 墓碑：对外不可见，但记录保留 —— 这正是"删除不销毁内容"
            const cur = S.segments.get(p.segId);
            if (cur) {
              cur.deleted = true;
              cur.deletedText = cur.text;
              // 删除裁决键必须一起收下，否则本地哈希与服务端对不上（会误报"不一致"）
              if (p.dmLamport !== undefined) cur.dmLamport = p.dmLamport;
              if (p.dmDevice !== undefined) cur.dmDevice = p.dmDevice;
              if (p.rev !== undefined) cur.rev = p.rev;
            }
            S.focusDefer.delete(p.segId);
          }
        }
        S.serverHash = msg.hash;
        renderAll();
        updateHashPanel();
        break;
      }
      case 'timeline': {
        S.lamport = Math.max(S.lamport, msg.lamport || 0);
        S.seq = msg.seq || S.seq;
        S.ops.unshift(msg.entry);
        if (S.ops.length > 80) S.ops.length = 80;
        if (msg.devices) S.devices = msg.devices;
        S.serverHash = msg.hash;
        renderTimeline();
        renderDevices();
        updateHashPanel();
        break;
      }
      case 'devices':
        S.devices = msg.devices || [];
        renderDevices();
        break;
      case 'ack': {
        S.lamport = Math.max(S.lamport, msg.lamport || 0);
        S.seq = msg.seq || S.seq;
        S.serverHash = msg.hash;
        if (!msg.applied) showToast('该操作被并发裁决（未生效），已记入时间线');
        updateHashPanel();
        break;
      }
      case 'check-result': {
        S.serverHash = msg.hash;
        S.lastSyncAt = Date.now();
        if (msg.devices) S.devices = msg.devices;
        updateHashPanel();
        renderDevices();
        break;
      }
      case 'pong':
        S.lastServerTime = msg.serverTime;
        break;
    }
  }

  // ─────────────────────────── 渲染 ───────────────────────────
  function renderAll() {
    S.localHash = stateHash([...S.segments.values()]);
    $('#pill-hash').textContent = 'hash ' + (S.localHash || '–');

    // 渲染前记住光标，渲染后如果焦点被打断就恢复 —— 保证"同步不会抢键盘"
    const caret = saveCaret();

    if (S.view === 'merged') renderMerged();
    else renderLayers();
    renderDevices();
    renderTimeline();
    updateFoot();

    restoreCaret(caret);
  }

  /**
   * 轻量刷新：只更新与状态有关的小块，**不碰编辑区**。
   * 用户正在打字时走这条路径，从根上避免任何 DOM 重建打断输入。
   */
  function renderLight() {
    S.localHash = stateHash([...S.segments.values()]);
    $('#pill-hash').textContent = 'hash ' + (S.localHash || '–');
    updateFoot();
  }

  /**
   * 正在编辑的分段 id（光标所在的那一段）。
   * 这一段在渲染时必须"只更新、不重建"，否则浏览器会连同光标一起丢掉焦点，
   * 手机上还会把软键盘收起来 —— 用户看到的就是"同步一发生，我的输入就被打断了"。
   */
  function editingSegId() {
    const a = document.activeElement;
    return (a && a.dataset && a.dataset.segId) ? a.dataset.segId : null;
  }

  /** 保存光标在本段文本中的字符偏移（只支持单节点 contenteditable，够本 Demo 用） */
  function saveCaret() {
    const a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.segId) return null;
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) return { segId: a.dataset.segId, offset: null };
    const range = sel.getRangeAt(0);
    if (!a.contains(range.startContainer)) return { segId: a.dataset.segId, offset: null };
    const pre = range.cloneRange();
    pre.selectNodeContents(a);
    pre.setEnd(range.startContainer, range.startOffset);
    return { segId: a.dataset.segId, offset: pre.toString().length };
  }

  /** 恢复光标：只有在渲染后焦点确实丢了、且目标节点还在时才动手 */
  function restoreCaret(saved) {
    if (!saved || saved.offset == null) return;
    const a = document.activeElement;
    const stillThere = (a && a.dataset && a.dataset.segId === saved.segId);
    if (stillThere) return;                       // 焦点没丢，别多事
    const node = document.querySelector('.seg-body[data-seg-id="' + saved.segId + '"]');
    if (!node) return;                            // 分段已被删除，不该恢复
    node.focus();
    const sel = window.getSelection && window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    let remaining = saved.offset;
    let placed = false;
    for (const child of node.childNodes) {
      const len = (child.textContent || '').length;
      if (remaining <= len) {
        range.setStart(child, remaining);
        placed = true;
        break;
      }
      remaining -= len;
    }
    if (!placed) {
      range.selectNodeContents(node);
      range.collapse(false);
    } else {
      range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * 重建/更新分段列表。
   *
   * 关键纪律：**绝不清空容器**。
   * 一旦 `list.innerHTML = ''`，正在编辑的 contenteditable 节点就被移出文档，
   * 焦点与光标位置随之丢失。正确做法是按 id 增量对齐：缺的补、多的删、顺序不对的移。
   * 而且"能不动就不动"——移动节点同样会打断光标。
   */
  function renderMerged() {
    const list = $('#merged-list');
    const segs = visibleSegments();

    // 空状态提示（它没有 data-seg-id，不会被当成分段节点）
    const emptyNode = list.querySelector('.seglist-empty');
    if (!segs.length) {
      if (!emptyNode) {
        const empty = el('div', 'fine seglist-empty');
        empty.style.padding = '18px 4px';
        empty.textContent = '还没有内容。在下面输入第一段吧——用另一台设备同时写，你会看到两边立刻互相出现。';
        list.appendChild(empty);
      }
    } else if (emptyNode) {
      emptyNode.remove();
    }

    // 只认 data-seg-id，绝不碰其它子节点
    const existing = new Map();
    for (const node of Array.from(list.children)) {
      if (node.dataset && node.dataset.segId) existing.set(node.dataset.segId, node);
    }

    const editing = editingSegId();
    const wanted = new Set(segs.map((s) => s.id));

    // 1) 移除已不存在的分段 —— 但绝不删正在编辑的那一个
    for (const [id, node] of Array.from(existing)) {
      if (wanted.has(id)) continue;
      if (id === editing) continue;   // 光标在这里：先留着，等失焦后再清理
      node.remove();
      existing.delete(id);
    }

    // 2) 按目标顺序对齐
    let cursor = list.firstChild;
    for (const seg of segs) {
      let node = existing.get(seg.id);
      if (!node) {
        node = buildSegNode(seg);
        existing.set(seg.id, node);
        list.insertBefore(node, cursor);
        continue;
      }
      updateSegNode(node, seg);
      if (cursor === node) {
        cursor = node.nextSibling;    // 已经在正确位置：不动它
      } else {
        list.insertBefore(node, cursor);
      }
    }

    // 3) 收尾：清理第 1 步因为"正在编辑"而暂时留下的已删除节点
    for (const [id, node] of Array.from(existing)) {
      if (!wanted.has(id) && id !== editing) node.remove();
    }
  }

  function buildSegNode(seg) {
    const wrap = el('div', 'seg');
    wrap.dataset.segId = seg.id;

    const bar = el('div', 'seg-bar');
    const main = el('div', 'seg-main');
    const head = el('div', 'seg-head');
    const owner = el('span', 'seg-owner');
    const meta = el('span', 'seg-meta');
    head.append(owner, meta);

    const body = el('div', 'seg-body');
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.dataset.segId = seg.id;
    body.textContent = seg.text;

    body.addEventListener('input', () => onSegInput(seg.id, body));
    body.addEventListener('focus', () => { body.dataset.editing = '1'; });
    body.addEventListener('blur', () => {
      body.dataset.editing = '';
      // 失焦后才把之前推迟的远端内容刷新上来，并清理已删除的节点
      if (S.focusDefer.has(seg.id)) {
        S.focusDefer.delete(seg.id);
      }
      renderAll();
    });
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        const after = seg.id;
        body.blur();
        addSegment('', after);
      }
      if (e.key === 'Backspace' && body.textContent === '') {
        e.preventDefault();
        if (confirm('删除这个分段？')) submitOp({ type: 'delete', segId: seg.id });
      }
    });

    const del = el('button', 'seg-del', '×');
    del.title = '删除这一段';
    del.addEventListener('click', () => {
      if (confirm('删除这个分段？')) submitOp({ type: 'delete', segId: seg.id });
    });

    main.append(head, body);
    wrap.append(bar, main, del);
    updateSegNode(wrap, seg);
    return wrap;
  }

  function updateSegNode(node, seg) {
    const bar = node.querySelector('.seg-bar');
    const owner = node.querySelector('.seg-owner');
    const meta = node.querySelector('.seg-meta');
    const body = node.querySelector('.seg-body');
    const color = devColor(seg.deviceId);
    const isMine = seg.deviceId === MY_ID;

    bar.style.background = color;
    owner.textContent = `${devGlyph(seg.deviceId)} ${deviceName(seg.deviceId)}`;
    owner.style.color = color;
    owner.classList.toggle('mine', isMine);
    meta.textContent = `#${seg.seq} · v${seg.rev} · λ${seg.lamport}${seg._local ? ' · 待确认' : ''}`;

    // 判断"这一段是否正在被编辑"要用真实的 activeElement，
    // 而不是可能过期或漏设的 dataset 标志
    const isEditing = document.activeElement === body;

    // 绝不在用户输入时替换文本：那会同时丢掉未提交的内容和光标
    if (body.textContent !== seg.text && !isEditing) {
      body.textContent = seg.text;
    }
    if (isEditing && body.textContent !== seg.text) {
      // 用户正在输入，远端有新版本：标记待刷新，不打断输入
      node.style.borderColor = 'rgba(240,166,60,.5)';
      node.title = '远端有更新，失焦后会自动刷新为权威内容';
    } else {
      node.style.borderColor = '';
      node.title = '';
    }
  }

  const inputTimers = new Map();
  function onSegInput(segId, body) {
    const text = body.textContent;
    const seg = S.segments.get(segId);
    if (seg) seg.text = text;   // 本地立刻生效：写入永不等待
    renderLight();              // 只更新哈希与字数，绝不重建编辑区
    clearTimeout(inputTimers.get(segId));
    // 防抖：停止输入 220ms 后投递。防抖期间用户继续输入不受任何阻塞。
    inputTimers.set(segId, setTimeout(() => {
      const cur = S.segments.get(segId);
      if (!cur) return;
      submitOp({ type: 'update', segId, text: body.textContent, lamport: winningKey(cur) });
    }, 220));
  }

  function renderLayers() {
    const box = $('#layers-list');
    box.innerHTML = '';
    const segs = visibleSegments();
    const ids = [...new Set(segs.map((s) => s.deviceId))];
    if (!ids.length) {
      const e = el('div', 'layer-empty', '还没有任何设备写入内容。');
      box.appendChild(e);
      return;
    }
    // 本设备永远排在最前，这样"我写的那一份"永远在第一层
    ids.sort((a, b) => (a === MY_ID ? -1 : b === MY_ID ? 1 : a.localeCompare(b)));

    for (const id of ids) {
      const mine = id === MY_ID;
      const layer = el('div', 'layer');
      const head = el('div', 'layer-head');
      const badge = el('span', 'dev-badge');
      badge.textContent = devGlyph(id);
      badge.style.background = devColor(id);
      const name = el('span', 'layer-name', deviceName(id) + (mine ? '（本设备）' : ''));
      const count = segs.filter((s) => s.deviceId === id).length;
      head.append(badge, name, el('span', 'layer-tag', `${count} 个分段`));
      layer.appendChild(head);

      for (const seg of segs.filter((s) => s.deviceId === id)) {
        const body = el('div', 'layer-body', seg.text);
        body.style.borderLeftColor = devColor(id);
        layer.appendChild(body);
      }
      box.appendChild(layer);
    }
  }

  function flash(segId) {
    const node = document.querySelector(`.seg[data-seg-id="${segId}"]`);
    if (!node) return;
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  function deviceName(id) {
    if (id === MY_ID) return LS.name;
    const d = S.devices.find((x) => x.id === id);
    return d ? d.name : id.slice(0, 6);
  }

  function renderDevices() {
    const box = $('#dev-list');
    box.innerHTML = '';
    const seenOps = new Map();
    for (const op of S.ops) seenOps.set(op.deviceId, (seenOps.get(op.deviceId) || 0) + 1);

    // 合并"服务端台账"和"当前已出现过的设备"
    const map = new Map();
    for (const d of S.devices) map.set(d.id, { ...d });
    for (const s of S.segments.values()) {
      if (!map.has(s.deviceId)) map.set(s.deviceId, { id: s.deviceId, name: deviceName(s.deviceId), online: null, opCount: 0 });
    }
    const list = [...map.values()].sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));

    for (const d of list) {
      const row = el('div', 'dev' + (d.id === MY_ID ? ' me' : ''));
      const badge = el('span', 'dev-badge');
      badge.textContent = devGlyph(d.id);
      badge.style.background = devColor(d.id);
      const name = el('span', 'dev-name', d.name + (d.id === MY_ID ? '（本设备）' : ''));
      const segCount = [...S.segments.values()].filter((s) => s.deviceId === d.id).length;
      const stat = el('span', 'dev-stat', `${segCount} 段`);
      const on = d.online === true || d.id === MY_ID;
      const state = el('span', 'dev-state' + (on ? ' on' : ''), on ? '在线' : '离线');
      row.append(badge, name, stat, state);
      box.appendChild(row);
    }
    const online = list.filter((d) => d.online || d.id === MY_ID).length;
    $('#pill-devices').textContent = `在线设备 ${online} / ${list.length}`;
    $('#dev-count').textContent = `共 ${list.length} 台`;
  }

  function renderTimeline() {
    const box = $('#timeline');
    box.innerHTML = '';
    if (!S.ops.length) {
      box.appendChild(el('div', 'fine', '暂无操作。'));
      return;
    }
    for (const op of S.ops.slice(0, 40)) {
      const row = el('div', 'tl' + (op.applied === false ? ' skip' : ''));
      row.append(el('span', 'tl-seq', '#' + op.n));
      row.append(el('span', 'tl-time', hhmmss(op.at)));
      row.append(el('span', 'tl-op', OP_LABEL[op.type] || op.type));
      const dev = el('span', 'tl-dev', deviceName(op.deviceId).slice(0, 4));
      dev.style.color = devColor(op.deviceId);
      row.append(dev);
      row.append(el('span', 'tl-text', op.text ? op.text.replace(/\n/g, '⏎') : ''));
      row.title = op.applied === false
        ? '这次操作与另一次并发操作冲突，被确定性裁决为不生效——但过程被完整保留在这里'
        : '已生效';
      box.appendChild(row);
    }
  }

  const OP_LABEL = { create: '新增', update: '修改', delete: '删除', join: '加入' };

  function updateFoot() {
    const segs = visibleSegments();
    const chars = segs.reduce((n, s) => n + (s.text || '').length, 0);
    $('#foot-left').textContent = `${segs.length} 个分段 · ${chars} 字 · 本端 lamport ${S.lamport}`;
  }

  function updateHashPanel() {
    $('#hash-local').textContent = S.localHash ? S.localHash : '–';
    $('#hash-server').textContent = S.serverHash ? S.serverHash : '–';
    const v = $('#hash-verdict');
    if (!S.localHash || !S.serverHash) { v.className = 'verdict'; v.textContent = '点击「同步校验」比对'; return; }
    if (S.localHash === S.serverHash) {
      v.className = 'verdict ok';
      v.textContent = '✓ 一致 —— 本端与服务端状态逐字节相同';
    } else {
      v.className = 'verdict bad';
      v.textContent = '✕ 暂不一致 —— 可能有未确认的本地改动，稍后再校验';
    }
  }

  let toastTimer = null;
  function showToast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ─────────────────────────── 交互 ───────────────────────────
  function addSegment(text, anchorId) {
    const id = uuid();
    submitOp({ type: 'create', id, text: text || '', anchorId: anchorId || null });
    return id;
  }

  $('#btn-add').addEventListener('click', () => {
    const ta = $('#new-text');
    if (!ta.value.trim()) { showToast('先输入内容'); return; }
    addSegment(ta.value);
    ta.value = '';
    ta.focus();
  });

  $('#new-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#btn-add').click();
    }
  });

  $('#btn-check').addEventListener('click', () => {
    send({ type: 'check' });
    showToast('已向服务端请求校验');
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      S.view = tab.dataset.view;
      $('#view-merged').classList.toggle('hidden', S.view !== 'merged');
      $('#view-layers').classList.toggle('hidden', S.view !== 'layers');
      renderAll();
    });
  });

  /**
   * 并发竞态演示：对同一个分段连续投递 3 次"并发修改"。
   * 三次操作都会到达服务端、都进入时间线，但只有排序最大的那次生效 ——
   * 这就是"不做语义裁决，只做确定性排序"的可视化。
   */
  $('#btn-race').addEventListener('click', () => {
    if (!S.joined) { showToast('尚未连接'); return; }
    const anchor = sortedSegments().slice(-1)[0];
    const now = Date.now();
    S.lamport += 10;
    const base = S.lamport;
    // 故意"高键先到、低键晚到"：前两次会被确定性裁决掉，第三次生效。
    // 这样时间线上能直接看到"落败但被保留"的记录 ——
    // 这正是"稳定之前的分叉必须被保留、但由固定规则决定谁生效"的可视化。
    const payloads = [
      { lamport: base, text: `【竞态 C】lamport 最大，最终生效` },
      { lamport: base - 3, text: `【竞态 B】lamport 居中，预期被裁决掉` },
      { lamport: base - 6, text: `【竞态 A】lamport 最小，预期被裁决掉` },
    ];
    const segId = anchor ? anchor.id : addSegment('（竞态演示的承载分段）');
    for (const p of payloads) {
      setTimeout(() => {
        send({ type: 'op', op: { type: 'update', segId, text: p.text, lamport: p.lamport } });
      }, 40 + Math.random() * 160); // 故意乱序投递
    }
    showToast('已乱序投递 3 次并发修改：看时间线里谁生效、谁被裁决掉');
  });

  $('#btn-copy').addEventListener('click', async () => {
    const text = visibleSegments().map((s) => s.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制纯文本');
    } catch {
      showToast('复制失败（浏览器限制）');
    }
  });

  // 定期心跳 + 自动校验（让"是否稳定"始终可见）
  setInterval(() => {
    if (!S.connected) return;
    send({ type: 'ping' });
    send({ type: 'check' });
  }, 6000);

  setInterval(() => {
    if (S.connected && S.joined) send({ type: 'check' });
  }, 15000);

  // 已登录过就直接进入
  if (S.token) {
    (async () => {
      try {
        const res = await fetch('/api/state', { headers: { Authorization: 'Bearer ' + S.token } });
        if (res.ok) { enterApp(); return; }
      } catch {}
      LS.token = null; S.token = null;
      $('#gate-msg').textContent = '上次的会话已失效，请重新输入权限密码';
    })();
  }
})();
