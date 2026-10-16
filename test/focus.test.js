#!/usr/bin/env node
/**
 * 焦点保护回归测试
 * ------------------------------------------------------------
 * 曾经的真实 bug：
 *
 *     function renderMerged() {
 *       list.innerHTML = '';    // ← 把所有分段节点销毁
 *       ...
 *     }
 *
 * 每次同步补丁到达都会走 renderMerged()，于是**正在编辑的 contenteditable
 * 节点被移出文档 → 焦点与光标丢失 → 手机上软键盘收起**。
 * 用户看到的现象就是"我还没打完，同步就把我的键盘抢走了"。
 *
 * 这个测试用一个极简 DOM 替身，从 public/client.js 里**直接抽取真实的
 * renderMerged / buildSegNode / updateSegNode 代码**来跑，验证：
 *
 *   ① 有焦点时渲染，focused 的 contenteditable 节点必须仍在文档内
 *   ② 渲染不得清空容器（尤其不得删除 focused 节点）
 *   ③ 正在编辑时，绝不覆盖 DOM 文本内容
 *   ④ 新增/删除/重排分段后，focused 节点仍然存活
 *
 * 用法：node test/focus.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'public', 'client.js');
const src = fs.readFileSync(CLIENT, 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
}

// ───────────────────────── 极简 DOM ─────────────────────────
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this._text = '';
    this.style = {};
    this.dataset = {};
    this._listeners = {};
  }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this; this.children.push(n); return n;
  }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    if (!ref) { this.children.push(n); return n; }
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null; return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) {
    for (let p = n; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
  setAttribute() {} getAttribute() { return null; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  focus() { FAKE_DOM.activeElement = this; }
  blur() { if (FAKE_DOM.activeElement === this) FAKE_DOM.activeElement = null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  dispatch(t, ev) { for (const fn of this._listeners[t] || []) fn(ev || {}); }
  matches(sel) {
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    return false;
  }
  querySelector(sel) {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const deeper = c.querySelector(sel);
      if (deeper) return deeper;
    }
    return null;
  }
  querySelectorAll(sel, out = []) {
    for (const c of this.children) {
      if (c.matches(sel)) out.push(c);
      c.querySelectorAll(sel, out);
    }
    return out;
  }
}

const FAKE_DOM = {
  activeElement: null,
  _byId: new Map(),
  createElement(tag) { return new FakeEl(tag); },
  querySelector(sel) {
    if (sel.startsWith('#')) return this._byId.get(sel.slice(1)) || null;
    if (sel.startsWith('.')) return this.getElementById('merged-list').querySelector(sel);
    return null;
  },
  getElementById(id) { return this._byId.get(id) || null; },
  addById(id) { const n = new FakeEl('div'); n.dataset.id = id; this._byId.set(id, n); return n; },
};
FAKE_DOM.addById('merged-list');

// ───────────────────── 从 client.js 抽取真实函数 ─────────────────────
/**
 * 从源码里抽取一段绑定：既支持 `function name(...) {`，
 * 也支持 `const name = (...) => {` / `const name = () => ...;`
 */
function extractBinding(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // '$' 必须转义，否则会被当成正则锚点
  const fnRe = new RegExp('function\\s+' + esc + '\\s*\\([^)]*\\)\\s*\\{');
  const arrowRe = new RegExp('const\\s+' + esc + '\\s*=\\s*\\([^)]*\\)\\s*=>');
  let m = fnRe.exec(src);
  if (m) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
    }
    throw new Error(`函数 ${name} 括号不平衡`);
  }
  m = arrowRe.exec(src);
  if (!m) throw new Error(`在 client.js 中找不到绑定 ${name}（可能被重命名了）`);
  const after = src.slice(m.index + m[0].length).trimStart();
  if (!after.startsWith('{')) {
    // 简写箭头函数：取到分号为止。保持 `const name = ...;` 的声明形式，
    // 这样多个绑定可以安全拼接（若在此处写 return 会提前结束整个函数体）。
    const end = src.indexOf(';', m.index + m[0].length);
    return src.slice(m.index, end) + ';';
  }
  let depth = 0;
  const braceStart = src.indexOf('{', m.index + m[0].length - 1);
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1) + ';'; }
  }
  throw new Error(`绑定 ${name} 括号不平衡`);
}

const NAMES = ['$', 'el', 'editingSegId', 'saveCaret', 'restoreCaret',
  'renderMerged', 'buildSegNode', 'updateSegNode'];

const body = NAMES.map(extractBinding).join('\n')
  + '\nreturn { renderMerged, buildSegNode, updateSegNode, editingSegId, el };';

const S = {
  segments: new Map(),
  devices: [],
  ops: [],
  view: 'merged',
  baseText: new Map(),
  focusDefer: new Set(),
  lamport: 0,
  seq: 0,
};
const MY_ID = 'dev-me';
const LS = { name: '本机' };
const DEVICE_COLORS = {};

const api = new Function(
  'document', 'window', 'S', 'MY_ID', 'LS', 'devColor', 'devGlyph', 'deviceName',
  'visibleSegments', 'sortedSegments',
  body
)(
  FAKE_DOM,
  { getSelection: () => null },
  S, MY_ID, LS,
  () => '#4c8dff', () => '◆', () => '设备',
  () => [...S.segments.values()].filter((s) => !s.deleted).sort((a, b) => a.seq - b.seq),
  () => [...S.segments.values()].sort((a, b) => a.seq - b.seq),
  null
);

// ───────────────────────── 测试 ─────────────────────────
console.log('\n\x1b[1m焦点保护：同步渲染不得抢走键盘/光标\x1b[0m');

function makeSeg(id, seq, text, deviceId = 'dev-other') {
  return { id, seq, deviceId, text, lamport: seq, rev: 1, deleted: false };
}

// 准备两条分段
S.segments.set('s1', makeSeg('s1', 1, '第一段', 'dev-a'));
S.segments.set('s2', makeSeg('s2', 2, '第二段', 'dev-b'));
api.renderMerged();

const list = FAKE_DOM.getElementById('merged-list');
check('渲染出两个分段节点', list.querySelectorAll('.seg').length === 2);

const bodyNode = list.querySelectorAll('.seg-body').find((n) => n.dataset.segId === 's1');
check('找到 s1 的编辑体', !!bodyNode);

// 用户把光标放进 s1 并开始输入
bodyNode.focus();
check('模拟：光标已在 s1 的编辑体上', FAKE_DOM.activeElement === bodyNode);

// ① 打字期间有远端补丁到达 → 触发渲染
{
  S.segments.set('s3', makeSeg('s3', 3, '远端新增的一段', 'dev-c'));
  api.renderMerged();
  check('① 远端新增分段后，focused 节点仍在文档内', bodyNode.parentNode !== null && list.contains(bodyNode));
  check('① 字体仍然持有焦点', FAKE_DOM.activeElement === bodyNode);
}

// ② 远端删除其它分段 → 渲染
{
  S.segments.delete('s2');
  api.renderMerged();
  check('② 远端删除别的分段后，focused 节点仍在文档内', list.contains(bodyNode));
  check('② 焦点仍在', FAKE_DOM.activeElement === bodyNode);
  check('② 被删除的分段确实从 DOM 移除', list.querySelectorAll('.seg').length === 2);
}

// ③ 正在编辑时，远端补丁改写了同一段内容 → 不得覆盖 DOM 文本
{
  S.segments.set('s1', { ...makeSeg('s1', 1, '远端改写的版本', 'dev-a') });
  api.renderMerged();
  check('③ 编辑中不被远端内容覆盖', bodyNode.textContent === '第一段',
    `实际="${bodyNode.textContent}"`);
  check('③ 但本地状态已记录远端内容（失焦后可刷新）',
    S.segments.get('s1').text === '远端改写的版本');
}

// ④ 模拟"用户正在打但还没提交"：DOM 文本比状态更新
{
  bodyNode.textContent = '第一段用户正在输入';
  S.segments.set('s3', makeSeg('s3', 3, '又一次远端更新', 'dev-c'));
  api.renderMerged();
  check('④ 用户未提交的输入不被抹掉', bodyNode.textContent === '第一段用户正在输入',
    `实际="${bodyNode.textContent}"`);
  check('④ 焦点未丢', FAKE_DOM.activeElement === bodyNode);
}

// ⑤ 分段重排（新分段插到最前）→ focused 节点仍需存活
{
  S.segments.set('s0', makeSeg('s0', 0, '插到最前面的段', 'dev-z'));
  for (const s of S.segments.values()) if (s.id !== 's0') s.seq += 1;
  api.renderMerged();
  check('⑤ 重排后 focused 节点仍在文档内', list.contains(bodyNode));
  check('⑤ 焦点未丢', FAKE_DOM.activeElement === bodyNode);
  const order = list.querySelectorAll('.seg').map((n) => n.dataset.segId).join(',');
  check('⑤ 顺序按 seq 正确重排', order === 's0,s1,s3', order);
}

// ⑥ 反面验证：源码里不得再出现清空容器的写法
{
  const bad = /merged-list'\)\s*;\s*\n\s*[\s\S]{0,80}?innerHTML\s*=\s*''/.test(src)
    || /function renderMerged[\s\S]{0,400}?innerHTML\s*=\s*''/.test(src);
  check('⑥ 源码中 renderMerged 不再清空容器（防止改回去）', !bad);
}

// ⑦ 保存光标的工具：无选区时不抛异常，且能识别出正在编辑的分段
{
  let ok = true, detail = '';
  try {
    const c = new Function('document', 'window',
      extractBinding('saveCaret') + '\nreturn saveCaret;')(FAKE_DOM, { getSelection: () => null });
    if (typeof c !== 'function') throw new Error('抽取结果不是函数');

    // 没有活动元素 → null
    FAKE_DOM.activeElement = null;
    if (c() !== null) throw new Error('无活动元素时应返回 null');

    // 有活动元素但拿不到选区 → 仍要返回 segId、offset 为 null（不炸）
    FAKE_DOM.activeElement = bodyNode;
    const r = c();
    if (!r || r.segId !== 's1' || r.offset !== null) {
      throw new Error('应返回 {segId:"s1",offset:null}，实际 ' + JSON.stringify(r));
    }
  }
  catch (e) { ok = false; detail = e.message; }
  check('⑦ saveCaret 无选区时安全返回，且能识别正在编辑的分段', ok, detail);
}

console.log('');
console.log('─'.repeat(64));
console.log(failed === 0 ? `\x1b[32m全部通过\x1b[0m   ${passed} 项断言` : `\x1b[31m失败 ${failed} 项\x1b[0m / 通过 ${passed} 项`);
console.log('─'.repeat(64));
process.exit(failed === 0 ? 0 : 1);
