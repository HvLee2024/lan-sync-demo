#!/usr/bin/env node
/**
 * 哈希实现一致性测试
 * ------------------------------------------------------------
 * 浏览器端（public/client.js）与服务端（core.js）各自实现了一份 stateHash。
 * 两者只要有一个字节的差别，页面上的「同步校验」就会永远显示"不一致"，
 * 于是这个功能从"信任凭证"退化成"永远报警的假警报器"。
 *
 * 这个测试从 client.js 里**直接抽取**真实代码来跑，而不是复制一份，
 * 所以只要任何一方被改坏，它就会失败。
 *
 * 用法：node test/hash-parity.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', 'core.js'));

const CLIENT = path.join(__dirname, '..', 'public', 'client.js');
const src = fs.readFileSync(CLIENT, 'utf8');

/** 按大括号配对从源码里抽出一个函数定义的完整文本 */
function extractFunction(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error(`在 client.js 中找不到函数 ${name}`);
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error(`函数 ${name} 括号不平衡`);
}

const clientSide = new Function(
  [extractFunction('sha16'), extractFunction('compareOrder'), extractFunction('stateHash'),
   'return { stateHash, sha16, compareOrder };'].join('\n')
)();

let passed = 0, failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
}

/** 补全派生顺序与裁决键所需字段（真实数据由内核产出，测试里手工构造） */
function seg(o) {
  return Object.assign({
    createLamport: o.lamport, createDevice: o.deviceId,
    wLamport: o.lamport, wDevice: o.deviceId,
    dmLamport: -1, dmDevice: '', rev: 1, deleted: false, text: '',
  }, o);
}

const datasets = {
  '空文档': [],
  '单个分段': [
    seg({ id: 'a', deviceId: 'dev-1', lamport: 1, text: 'hello' }),
  ],
  '乱序 + 中文 + 墓碑': [
    seg({ id: 'a', deviceId: 'dev-1', lamport: 5, text: '第一段' }),
    seg({ id: 'b', deviceId: 'dev-2', lamport: 9, text: 'second' }),
    seg({ id: 'c', deviceId: 'dev-1', lamport: 7, deleted: true, text: '墓碑内容' }),
  ],
  'emoji 与首尾空白': [
    seg({ id: 'x', deviceId: '设备🖊', lamport: 0, text: '中文 + emoji 🎯\n换行  ' }),
  ],
  '相同 lamport 不同设备': [
    seg({ id: 'p', deviceId: 'dev-aaa', lamport: 13, text: 'A' }),
    seg({ id: 'q', deviceId: 'dev-bbb', lamport: 13, text: 'B' }),
  ],
  '大文档（2000 段）': Array.from({ length: 2000 }, (_, i) => seg({
    id: 'seg-' + i, deviceId: 'dev-' + (i % 7), lamport: i,
    deleted: i % 11 === 0, text: '段落内容 ' + i,
  })),
};

console.log('\n\x1b[1m浏览器端 stateHash  与  服务端 core.stateHash  逐字节一致\x1b[0m');
for (const [name, segs] of Object.entries(datasets)) {
  const a = clientSide.stateHash(segs);
  const b = core.stateHash({ segments: segs });
  check(name, a === b, `浏览器=${a} 内核=${b}`);
}

// 反面验证：内容变一个字，哈希必须变
console.log('\n\x1b[1m哈希灵敏度\x1b[0m');
{
  const base = [seg({ id: 'a', deviceId: 'd', lamport: 1, text: 'abc' })];
  const tweaked = [seg({ id: 'a', deviceId: 'd', lamport: 1, text: 'abd' })];
  check('内容改一个字 → 哈希改变', clientSide.stateHash(base) !== clientSide.stateHash(tweaked));

  const deleted = [seg({ id: 'a', deviceId: 'd', lamport: 1, deleted: true, text: 'abc' })];
  check('仅墓碑状态不同 → 哈希改变', clientSide.stateHash(base) !== clientSide.stateHash(deleted));

  const moved = [seg({ id: 'a', deviceId: 'd', lamport: 1, createLamport: 9, text: 'abc' })];
  check('创建键不同 → 哈希改变', clientSide.stateHash(base) !== clientSide.stateHash(moved));

  const revChanged = [seg({ id: 'a', deviceId: 'd', lamport: 1, rev: 99, text: 'abc' })];
  check('仅 rev 不同 → 哈希不变（rev 是顺序相关计数器，刻意不进哈希）',
    clientSide.stateHash(base) === clientSide.stateHash(revChanged));

  const seqChanged = [seg({ id: 'a', deviceId: 'd', lamport: 1, seq: 77, text: 'abc' })];
  check('仅展示序号 seq 不同 → 哈希不变（seq 已不参与排序与哈希）',
    clientSide.stateHash(base) === clientSide.stateHash(seqChanged));
}

console.log('');
console.log('─'.repeat(64));
console.log(failed === 0 ? `\x1b[32m全部通过\x1b[0m   ${passed} 项断言` : `\x1b[31m失败 ${failed} 项\x1b[0m / 通过 ${passed} 项`);
console.log('─'.repeat(64));
process.exit(failed === 0 ? 0 : 1);
