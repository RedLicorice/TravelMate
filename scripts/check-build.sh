#!/usr/bin/env bash
# GitHub Pages has no SPA rewrite: it serves 404.html for unknown paths and
# index.html for "/". A SPA needs both, or the site 404s at its own root.
set -euo pipefail
test -f build/index.html || { echo "FAIL: build/index.html missing"; exit 1; }
test -f build/404.html   || { echo "FAIL: build/404.html missing"; exit 1; }
grep -q "sveltekit" build/index.html || { echo "FAIL: index.html is not the app shell"; exit 1; }
echo "PASS: static output has both entry points"
