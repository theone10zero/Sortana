#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
svg_dir="$script_dir/svg"
out_dir="$script_dir/img"
sizes=(16 32 64)
themes=(light dark)

get_theme_color() {
  case "$1" in
    light) printf '%s\n' '#000000' ;;
    dark) printf '%s\n' '#ffffff' ;;
    *)
      printf 'Unknown theme: %s\n' "$1" >&2
      exit 1
      ;;
  esac
}

ensure_temp_svg() {
  local input_svg="$1"
  local color="$2"
  local temp_svg="$3"

  python3 - "$input_svg" "$color" "$temp_svg" <<'PY'
import pathlib
import re
import sys

input_path = pathlib.Path(sys.argv[1])
color = sys.argv[2]
output_path = pathlib.Path(sys.argv[3])
content = input_path.read_text(encoding="utf-8")
patched, count = re.subn(r"<svg([^>]*?)>", f'<svg\\1 style="color: {color}">', content, count=1)
if count != 1:
    raise SystemExit("Couldn't find <svg> tag to patch.")
output_path.write_text(patched, encoding="utf-8")
PY
}

if [[ ! -d "$svg_dir" ]]; then
  echo "SVG source directory not found: $svg_dir" >&2
  exit 1
fi

mkdir -p "$out_dir"

if ! command -v inkscape >/dev/null 2>&1; then
  echo "Inkscape CLI is not installed or not in PATH. Please install it from https://inkscape.org/" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to patch the SVG color attribute." >&2
  exit 1
fi

shopt -s nullglob
svg_files=("$svg_dir"/*.svg)
shopt -u nullglob

if [[ ${#svg_files[@]} -eq 0 ]]; then
  echo "No SVG files found in $svg_dir" >&2
  exit 0
fi

temp_svg="$(mktemp "${TMPDIR:-/tmp}/sortana-svg2img.XXXXXX.svg")"
cleanup() {
  rm -f "$temp_svg"
}
trap cleanup EXIT

for svg_path in "${svg_files[@]}"; do
  base_name="$(basename "${svg_path%.svg}")"

  for theme in "${themes[@]}"; do
    color="$(get_theme_color "$theme")"
    ensure_temp_svg "$svg_path" "$color" "$temp_svg"

    for size in "${sizes[@]}"; do
      out_file="$out_dir/$base_name-$theme-$size.png"
      echo "Exporting $out_file (color $color)..."
      inkscape "$temp_svg" \
        --export-type=png \
        --export-filename="$out_file" \
        --export-width="$size" \
        --export-height="$size" \
        --actions=export-do
    done
  done
done

echo "Done generating light/dark themed PNGs."
