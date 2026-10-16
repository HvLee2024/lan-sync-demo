#!/usr/bin/env bash
# 一次性跑完所有测试
# 用法：bash test/run-all.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

# 用 PATH 里的 node；不在 PATH 时可显式指定
NODE="${NODE:-$(command -v node || true)}"

if [ -z "${NODE:-}" ] || [ ! -x "$NODE" ]; then
  echo "找不到 node（需要 Node.js 18+）。" >&2
  echo "  或显式指定：NODE=/path/to/node bash test/run-all.sh" >&2
  exit 1
fi

FAILED=0

run() {
  local name="$1"; shift
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  $name"
  echo "════════════════════════════════════════════════════════════════"
  if "$NODE" "$@"; then
    :
  else
    FAILED=$((FAILED + 1))
  fi
}

run "哈希实现一致性（浏览器端 vs 服务端）" "$ROOT/test/hash-parity.test.js"
run "焦点保护（同步不得抢走键盘/光标）" "$ROOT/test/focus.test.js"
run "多服务器顺序一致性（每一端都能当服务器）" "$ROOT/test/multi-server.test.js"
run "收敛性质测试（确定性 / 幂等 / 乱序 / 批量收敛）" "$ROOT/test/convergence.test.js"
run "端到端测试（真启服务端 + 两个 WebSocket 客户端）" "$ROOT/test/integration.test.js"
run "抗乱序压力诊断（200 轮 × 500 操作）" "$ROOT/test/diagnose.js" 200 500

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$FAILED" -eq 0 ]; then
  echo "  全部测试通过 ✓"
else
  echo "  有 $FAILED 个测试文件失败 ✗"
fi
echo "════════════════════════════════════════════════════════════════"
exit "$FAILED"
