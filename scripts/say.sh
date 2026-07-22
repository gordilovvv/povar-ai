#!/bin/sh
# say.sh "текст" — фокусит поле ввода открытого чата WA Web и отправляет текст
cd "$(dirname "$0")/.."
pnpm exec chrome-devtools evaluate_script '() => { const el = document.querySelector("footer div[contenteditable=\"true\"]"); if (!el) return "NO_INPUT"; el.focus(); return "focused"; }' 2>/dev/null
pnpm exec chrome-devtools type_text "$1" --submitKey Enter 2>/dev/null
