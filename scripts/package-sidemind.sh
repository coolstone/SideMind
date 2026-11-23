#!/usr/bin/env bash
# Build from working files, or an exact Git ref: bash scripts/package-sidemind.sh v0.5.31
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
ref="${1:-}"
package_paths=(
  manifest.json background.js content.js
  sidepanel.html sidepanel.css sidepanel.js options.html options.css options.js
  prompts.html prompts.css prompts.js artifact.html artifact.css artifact.js
  compare.html compare.css compare.js history-transfer.js history-archive.js prompt-library.js
  template-variables.js pdf-context.js workflow-core.js stream-reader.js model-client.js snippets.js
  sider-prompt-captures.json assets vendor README.md "SideMind-使用与扩展指南.md" tests/v0.5.31-validation.md
)
package_dir="$(mktemp -d "${TMPDIR:-/tmp}/sidemind-package.XXXXXX")"
temporary_zip="$package_dir/package.zip"
if [ -n "$ref" ]; then
  git archive --format=zip --output="$temporary_zip" "$ref" -- "${package_paths[@]}"
else
  node scripts/create-zip.mjs "$temporary_zip" "${package_paths[@]}"
fi
unzip -t "$temporary_zip" >/dev/null
version="$(node scripts/verify-package.mjs "$temporary_zip" "${package_paths[@]}")"
if [ -n "$ref" ] && [ "$ref" != "v$version" ]; then
  echo "Tag 与安装包版本不一致：$ref / $version" >&2
  exit 1
fi
mv -f "$temporary_zip" "SideMind-v${version}.zip"
rmdir "$package_dir"
echo "本地安装包完整性检查通过：$repo_root/SideMind-v${version}.zip"
shasum -a 256 "SideMind-v${version}.zip"
