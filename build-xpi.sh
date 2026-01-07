#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
release_dir="$script_dir/release"
manifest="$script_dir/manifest.json"

if [[ ! -f "$manifest" ]]; then
  echo "manifest.json not found at $manifest" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to build the XPI." >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  version="$(jq -r '.version // empty' "$manifest")"
else
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to read manifest.json without jq." >&2
    exit 1
  fi
  version="$(python3 - <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
print(data.get('version', '') or '')
PY
"$manifest")"
fi

if [[ -z "$version" ]]; then
  echo "No version found in manifest.json" >&2
  exit 1
fi

mkdir -p "$release_dir"

xpi_name="sortana-$version.xpi"
zip_path="$release_dir/ai-filter-$version.zip"
xpi_path="$release_dir/$xpi_name"

rm -f "$zip_path" "$xpi_path"

mapfile -d '' files < <(
  find "$script_dir" -type f \
    ! -name '*.sln' \
    ! -name '*.ps1' \
    ! -name '*.sh' \
    ! -path "$release_dir/*" \
    ! -path "$script_dir/.vs/*" \
    ! -path "$script_dir/.git/*" \
    -printf '%P\0'
)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No files found to package." >&2
  exit 0
fi

for rel in "${files[@]}"; do
  full="$script_dir/$rel"
  size=$(stat -c '%s' "$full")
  echo "Zipping: $rel <- $full ($size bytes)"
done

(
  cd "$script_dir"
  printf '%s\n' "${files[@]}" | zip -q -9 -@ "$zip_path"
)

mv -f "$zip_path" "$xpi_path"

echo "Built XPI at: $xpi_path"
