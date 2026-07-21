#!/usr/bin/env bash

# 用法：./scripts/release-sidemind.sh "提交说明" v0.5.28 "Tag 说明"
# 只提交已跟踪文件，避免把本地 ZIP、临时目录或个人草稿带入 GitHub。
set -euo pipefail

commit_message="${1:?请提供提交说明}"
tag_name="${2:?请提供版本 Tag，例如 v0.5.28}"
tag_notes="${3:-$commit_message}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$tag_name" in
  v[0-9]*.*.*) ;;
  *) echo "版本 Tag 应采用 v0.0.0 格式，例如 v0.5.28" >&2; exit 1 ;;
esac

cd "$repo_root"
node --check sidepanel.js
node tests/regression.mjs
git diff --check

# -u 只暂存已跟踪文件；脚本本身第一次加入仓库时显式加入。
git add -u
git add scripts/release-sidemind.sh

if git diff --cached --quiet; then
  echo "没有可提交的已跟踪改动。"
  exit 0
fi

if git rev-parse -q --verify "refs/tags/${tag_name}" >/dev/null; then
  echo "Tag ${tag_name} 已存在；为避免覆盖，已停止。" >&2
  exit 1
fi

git commit -m "$commit_message"
git tag -a "$tag_name" -m "$tag_notes"

# 只允许普通 fast-forward 推送到主分支，绝不强推。
git push origin HEAD:main
git push origin "$tag_name"

echo "已发布 ${tag_name} 到 origin/main。"
