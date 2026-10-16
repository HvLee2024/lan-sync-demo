#!/usr/bin/env bash
# =============================================================================
#  push-to-github.sh —— 把本项目上传到 GitHub
#
#  这个脚本需要一次授权（创建远程仓库 + 推送只能用你自己的账号）。
#  它会尽量少问问题：
#
#     ./push-to-github.sh                 # 默认：公开仓库，仓库名 lan-sync-demo
#     ./push-to-github.sh --private       # 私有仓库
#     ./push-to-github.sh --name 别的名字  # 换仓库名
#     ./push-to-github.sh --no-push       # 只配好远程地址，不推送
#
#  优先用 gh CLI（会自动创建仓库并推送）。
#  没装 gh 或没登录时，会打印"手动三步"给你照着做。
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_NAME="lan-sync-demo"
VISIBILITY="--public"
DO_PUSH=1

for arg in "$@"; do
  case "$arg" in
    --private) VISIBILITY="--private" ;;
    --public)  VISIBILITY="--public" ;;
    --no-push) DO_PUSH=0 ;;
    --name)    shift; REPO_NAME="${1:-}" ;;
    --name=*)  REPO_NAME="${arg#--name=}" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_green=$'\033[32m'
c_yellow=$'\033[33m'; c_red=$'\033[31m'
step() { printf '\n%s==> %s%s\n' "$c_bold" "$*" "$c_reset"; }
ok()   { printf '%s  ✓ %s%s\n' "$c_green" "$*" "$c_reset"; }
warn() { printf '%s  ! %s%s\n' "$c_yellow" "$*" "$c_reset"; }
die()  { printf '%s  ✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }

command -v git >/dev/null || die "没有安装 git"

cd "$HERE"

# ---------------------------------------------------------------- 1. 本地提交
step "第 1 步 / 3：确认本地仓库"

if [ ! -d .git ]; then
  git init -q
  ok "已初始化 git 仓库"
else
  ok "git 仓库已存在"
fi

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "更新：$(date '+%Y-%m-%d %H:%M')" || true
  ok "已提交本地改动"
else
  ok "工作区干净，无需提交"
fi

BRANCH="$(git branch --show-current 2>/dev/null || echo main)"
[ -n "$BRANCH" ] || { git checkout -q -b main; BRANCH=main; }
ok "当前分支：$BRANCH"

# ---------------------------------------------------------------- 2. 有没有 gh
HAVE_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAVE_GH=1
fi

if [ "$HAVE_GH" = "0" ]; then
  step "第 2 步 / 3：需要你授权一次"
  if ! command -v gh >/dev/null 2>&1; then
    warn "没检测到 gh CLI。"
    echo "    安装（Arch）： sudo pacman -S github-cli"
    echo "    安装（其他）： https://cli.github.com/"
  else
    warn "gh 还没登录。运行下面这条，按提示选 GitHub.com → HTTPS → 浏览器登录："
    echo
    printf '        %sgh auth login%s\n' "$c_bold" "$c_reset"
    echo
    echo "    登录完成后重新运行本脚本即可："
    printf '        %s./push-to-github.sh%s\n' "$c_bold" "$c_reset"
  fi
  echo
  echo "  —— 或者完全不用 gh，手动三步 ——"
  echo
  echo "    1) 打开 https://github.com/new 新建仓库，名字填：$REPO_NAME"
  echo "       （不要勾选 Add README / .gitignore / license，本地已经有了）"
  echo
  echo "    2) 关联远程地址（把 <用户名> 换成你的 GitHub 用户名）："
  printf '        %sgit remote add origin https://github.com/<用户名>/%s.git%s\n' "$c_bold" "$REPO_NAME" "$c_reset"
  echo "       若已存在则改地址： git remote set-url origin <上面的地址>"
  echo
  echo "    3) 推送："
  printf '        %sgit push -u origin %s%s\n' "$c_bold" "$BRANCH" "$c_reset"
  echo
  exit 0
fi

# ---------------------------------------------------------------- 3. 建仓库并推送
step "第 2 步 / 3：创建远程仓库"

OWNER="$(gh api user --jq .login 2>/dev/null || echo '')"
[ -n "$OWNER" ] || die "拿不到 GitHub 用户名，试试重新 gh auth login"

if gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  ok "远程仓库已存在：$OWNER/$REPO_NAME"
else
  gh repo create "$REPO_NAME" "$VISIBILITY" \
    --description "局域网实时同步 Demo：逻辑上一份文件、物理上多份副本；写入不阻塞，稳定后一致" \
    >/dev/null 2>&1 && ok "已创建：$OWNER/$REPO_NAME" || die "创建仓库失败（可能同名仓库已占用）"
fi

REMOTE_URL="https://github.com/$OWNER/$REPO_NAME.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi
ok "远程地址：$REMOTE_URL"

step "第 3 步 / 3：推送"

if [ "$DO_PUSH" = "0" ]; then
  warn "按 --no-push 要求，只配好了远程地址，没有推送"
  echo "    想推送时运行： git push -u origin $BRANCH"
  exit 0
fi

if git push -u origin "$BRANCH"; then
  echo
  ok "完成！仓库地址："
  printf '    %shttps://github.com/%s/%s%s\n\n' "$c_bold" "$OWNER" "$REPO_NAME" "$c_reset"
else
  die "推送失败。常见原因：远程已有提交（先 git pull --rebase）或网络问题"
fi
