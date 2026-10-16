#!/usr/bin/env bash
# 一键启动局域网实时同步 Demo
#
#   ./start.sh                     使用默认端口 8787、权限密码 1111
#   ./start.sh --port 9000         换端口
#   ./start.sh --passcode 8888     换权限密码
#
# 启动后终端会打印「局域网地址」，用同一 Wi-Fi 下的手机/平板打开即可。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 用 PATH 里的 node；如果它不在 PATH（例如被装在独立运行时目录里），
# 可以显式指定：NODE=/path/to/node ./start.sh
NODE="${NODE:-$(command -v node || true)}"

if [ -z "${NODE:-}" ] || [ ! -x "$NODE" ]; then
  echo "找不到 node 运行时（需要 Node.js 18+）。" >&2
  echo "  安装：https://nodejs.org/  或用发行版包管理器" >&2
  echo "  或显式指定：NODE=/path/to/node ./start.sh" >&2
  exit 1
fi

exec "$NODE" "$HERE/server.js" "$@"
