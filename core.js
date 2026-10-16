/**
 * 同步内核（纯函数式，无 IO）
 * ------------------------------------------------------------
 * 服务端和收敛测试共用同一份实现，保证"被测的"就是"线上跑的"。
 *
 * 这里只做两件事：
 *   1. 保留真实操作顺序（时间线）
 *   2. 用一条固定的、确定性的规则决定并发冲突谁生效
 *
 * 确定性规则只有一条：
 *   比较 (lamport, deviceId)，字典序大的胜出。
 * 它不解释任何用户意图 —— 只保证"所有副本算出来的结果相同"。
 */

'use strict';

const crypto = require('crypto');

function emptyState() {
  return {
    version: 1,
    seq: 0,       // 仅用于展示的序号；**不再参与排序**
    lamport: 0,   // 逻辑时钟计数器
    segments: [],
    ops: [],      // 时间线（服务端保留；测试里可关闭）
    devices: {},
  };
}

/**
 * 分段的排列顺序 —— 从"创建操作自身的键"派生，而不是从"到达顺序"派生。
 * ------------------------------------------------------------
 * 这是"每一端都能当服务器"能否成立的分水岭。
 *
 * 如果顺序由服务端到达顺序决定（先到先排），那么：
 *   · A 设备的内嵌服务器给某段分配 seq=5
 *   · B 设备的内嵌服务器同时给它分配 seq=3
 *   · 两个服务器给出**不同**的顺序 → 不收敛
 *
 * 改成从创建键派生之后，顺序是一个**纯函数**：
 * 任何服务器、任何副本，只要看到同一组操作，就算出完全相同的顺序。
 * 于是不需要任何权威服务器来"定序"，离线设备自己也能算出正确顺序 ——
 * 这正是"不要因为没有公网就放弃同步策略"的前提。
 *
 * 排序键 = (创建时的 lamport, 创建设备 id, 分段 id)
 *   前两项来自创建操作自身；第三项是最终的确定性 tiebreak。
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

/** 按派生顺序排序后的全部分段（含墓碑） */
function orderedSegments(state) {
  return state.segments.slice().sort(compareOrder);
}

/**
 * 规范化哈希：多端比对即可判定是否收敛。
 *
 * 进哈希的是"确定性的最终事实"：位置、来源、并发裁决的赢家键、内容、墓碑状态。
 * 不进哈希的是 rev / updatedAt 这类**依赖到达顺序的计数器**——
 * 它们只用于界面展示，把它们算进哈希会让"内容已经一致"被误判成"不收敛"。
 */
function stateHash(state) {
  const canonical = orderedSegments(state)
    .map((s) => [
      s.id,
      s.createLamport, s.createDevice,      // 排列依据（派生，不是到达顺序）
      s.deviceId, s.wLamport, s.wDevice,    // 写入裁决结果
      s.dmLamport, s.dmDevice,              // 删除裁决结果
      s.deleted ? 'D' : 'A',
      (s.text || '').replace(/\s+$/, ''),
    ].join('\u0001'))
    .join('\u0002');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * 对外（客户端可见）的分段视图：不暴露墓碑。
 * seq 在这里只是"按派生顺序数出来的第几名"，纯展示用，不参与任何裁决。
 */
function publicSeg(s, displaySeq) {
  return {
    id: s.id,
    seq: displaySeq,                       // 展示用序号（按派生顺序编号）
    createLamport: s.createLamport,        // 排列依据，创建后不变
    createDevice: s.createDevice,
    deviceId: s.deviceId, text: s.text,    // 展示用：最后一次写入
    lamport: s.lamport,
    wLamport: s.wLamport, wDevice: s.wDevice,   // 写入裁决键（哈希要用）
    dmLamport: s.dmLamport, dmDevice: s.dmDevice, // 删除裁决键（哈希要用）
    rev: s.rev,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

/** 某分段按派生顺序排在第几（1 起，纯展示用） */
function displayRank(state, id) {
  const all = orderedSegments(state);
  const i = all.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i + 1;
}

/** 客户端可见的分段列表（过滤墓碑，按派生顺序编号） */
function visibleSegments(state) {
  return orderedSegments(state)
    .filter((s) => !s.deleted)
    .map((s, i) => publicSeg(s, i + 1));
}

/**
 * 应用一个操作到给定 state，返回受影响的 patch 列表。
 * 这个函数是**确定性**的：同一个 state + 同一组操作（无论投递顺序）
 * 最终会得到相同的结果。
 *
 * @param {object} state
 * @param {object} op      { type: 'create'|'update'|'delete', ... }
 * @param {string} deviceId 操作来源设备
 * @param {object} [opts]  { recordOps: boolean }
 */
/**
 * 应用一个操作到给定 state，返回受影响的 patch 列表。
 *
 * 确定性来源（这是整个系统能收敛的唯一原因）：
 *   · 每个操作携带一个**客户端生成**的逻辑时钟 (lamport, deviceId)
 *   · 服务端只做比较：字典序大的胜出，绝不重新生成或放大这个键
 *   · 因此"谁先到达服务端"永远不会影响最终结果
 *
 * 反过来说：如果服务端用到达顺序去放大 lamport，裁决就会依赖投递顺序，
 * 系统立刻不收敛 —— 这是本项目里最关键的一条纪律。
 *
 * @param {object} state
 * @param {object} op      { type: 'create'|'update'|'delete', ... }
 * @param {string} deviceId 操作来源设备
 */
function applyOp(state, op, deviceId) {
  const patches = [];
  const incoming = Number(op.lamport) || 0;

  state.lamport = Math.max(state.lamport, incoming);

  if (op.type === 'create') {
    let text = typeof op.text === 'string' ? op.text : '';
    if (text.length > 200000) text = text.slice(0, 200000);

    const id = op.id || crypto.randomUUID();

    // 幂等：同一个 create 重复到达，不重复插入
    const dup = state.segments.find((s) => s.id === id);
    if (dup) return patches;

    const seg = {
      id,
      deviceId,
      /**
       * 创建键：排列顺序的唯一依据。
       * 它在创建时确定，之后**永不改变** —— 即使这段后来被别台设备改写，
       * 它在文档里的位置也不会跳（那对用户来说才是"内容自己乱跑"）。
       */
      createLamport: incoming,
      createDevice: deviceId,
      anchorId: op.anchorId || null,   // 仅记录用户的相对意图，不作排序依据
      text,
      lamport: incoming,
      rev: 1,
      deleted: false,
      /**
       * 写入裁决键（与用于展示的 lamport/deviceId 分开保存）。
       *
       * 展示字段 deviceId 表示"最后一次写入是哪台设备"，它会随删除/复活而变；
       * 而裁决必须有一个**单调不减**的比较基准，否则一次删除就能把基准抬高，
       * 让随后到达的、本应生效的写入被误判为"更旧"。
       */
      wLamport: incoming,
      wDevice: deviceId,
      /**
       * 删除操作的独立裁决键 —— 必须与写入键分开保存。
       *
       * 如果把删除的键写进 seg.lamport，就会覆盖"最后一次写入的键"，
       * 于是晚到的、键更小的并发修改会被误判为"更旧"而丢弃，
       * 但它的内容其实已经被计入可见状态 —— 可见文本因此依赖到达顺序，收敛被破坏。
       *
       * 修正后的两条不变量（都只依赖操作集合，与投递顺序无关）：
       *   可见文本 = 键最大的那次**写入**
       *   是否删除 = 键最大的那次**删除** 是否比 键最大的那次**写入** 更大
       */
      dmLamport: -1,
      dmDevice: '',
      deletedText: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    state.segments.push(seg);
    state.seq = state.segments.length;   // 仅供旧调用方读取，不参与排序
    patches.push({ kind: 'upsert', seg: publicSeg(seg, displayRank(state, seg.id)) });
    return patches;
  }

  const seg = state.segments.find((s) => s.id === op.segId);
  if (!seg) return patches; // 目标还没到达：静默忽略

  /**
   * 并发裁决：只比较 (lamport, deviceId) 这个**有序对**，不解释任何用户意图。
   *
   * 必须按"对"比较，不能写成分步写法：
   *   ✗ if (incoming !== seg.lamport) return incoming > seg.lamport;
   *   ✓ 先比 lamport，相等再比 deviceId
   * 分步写法会让"删除 vs 修改"的结果依赖到达顺序，从而破坏收敛。
   */
  const gt = (lamport, dev, refLamport, refDev) => {
    if (lamport !== refLamport) return lamport > refLamport;
    return String(dev) > String(refDev);
  };

  /** 写入裁决：与独立的写入键比较（删除不参与、也不覆盖它） */
  const writeWins = () => gt(incoming, deviceId, seg.wLamport, seg.wDevice);
  /**
   * 删除裁决：只与"已有删除的键"比较。
   *
   * 刻意**不**要求删除强于最后一次写入 —— 因为"是否可见"是最终比较的结果，
   * 不是每一步都要求满足的条件。若在这里加上"必须强于写入"，则删除先到时
   * 墓碑会错误地保持生效，结果就依赖到达顺序。
   */
  const deleteWins = () => gt(incoming, deviceId, seg.dmLamport, seg.dmDevice);
  /**
   * 可见性重算：**每一次应用操作后都按最终比较重新计算**。
   *
   * 这是整个收敛的关键不变量：
   *     可见  <=>  最大写入键 > 最大删除键
   * 它只依赖"操作集合"，不依赖任何一个操作的到达时机。
   * 不要在某个分支里写 seg.deleted = false —— 那样会把先到的删除错误地抹掉。
   */
  const recomputeVisibility = () => {
    seg.deleted = gt(seg.dmLamport, seg.dmDevice, seg.wLamport, seg.wDevice);
  };

  if (op.type === 'update') {
    let text = typeof op.text === 'string' ? op.text : '';
    if (text.length > 200000) text = text.slice(0, 200000);
    if (!writeWins()) return patches;                   // 并发落败：丢弃，但已记入时间线

    const wasVisible = !seg.deleted;
    const changed = (text !== seg.text) || wasVisible === false;
    seg.text = text;
    seg.lamport = incoming;      // 展示用：最后一次写入的逻辑时钟
    seg.deviceId = deviceId;     // 展示用：最后一次写入的设备
    seg.wLamport = incoming;     // 裁决用：写入键
    seg.wDevice = deviceId;
    recomputeVisibility();
    if (!seg.deleted) seg.deletedText = '';
    if (changed) seg.rev++;
    seg.updatedAt = Date.now();
    if (changed) patches.push({ kind: 'upsert', seg: publicSeg(seg, displayRank(state, seg.id)) });
    return patches;
  }

  if (op.type === 'delete') {
    if (!deleteWins()) return patches;

    const wasVisible = !seg.deleted;
    seg.dmLamport = incoming;
    seg.dmDevice = deviceId;
    recomputeVisibility();
    if (seg.deleted) {
      // 删除不销毁内容：把它移进墓碑（对外隐藏、对内保留）。
      // deletedText 只是展示用，不参与收敛契约。
      seg.deletedText = seg.text;
    }
    seg.rev++;
    seg.updatedAt = Date.now();
    if (wasVisible && seg.deleted) patches.push({ kind: 'remove', segId: seg.id });
    return patches;
  }

  return patches;
}

/** 服务端维护逻辑时钟：合并客户端 lamport，保证不回退 */
function mergeLamport(state, clientLamport) {
  const c = Number(clientLamport) || 0;
  state.lamport = Math.max(state.lamport, c, state.lamport + 1);
  return state.lamport;
}

function recordOp(state, op, deviceId, lamport, extra = {}) {
  const entry = Object.assign({
    n: state.ops.length + 1,
    type: op.type,
    deviceId,
    segId: op.segId || op.id || null,
    text: typeof op.text === 'string' ? op.text.slice(0, 80) : undefined,
    lamport,
    at: Date.now(),
  }, extra);
  state.ops.push(entry);
  if (state.ops.length > 4000) state.ops.splice(0, state.ops.length - 4000);
  return entry;
}

module.exports = {
  emptyState, stateHash, publicSeg, visibleSegments,
  compareOrder, orderedSegments, displayRank,
  applyOp, mergeLamport, recordOp,
};
