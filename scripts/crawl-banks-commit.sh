#!/usr/bin/env bash
# Run the bank discovery crawl in the LIVE crate checkout and commit the diff.
# Invoked by vimsical-crate-crawl-banks.service (weekly timer). Safe to run by
# hand too. Commits ONLY data/banks.json + shared/banks-digest.md, and only when
# the crawl succeeded and actually changed something.
set -euo pipefail

REPO="/home/builder/apps/crate"
cd "$REPO"

echo "[$(date -u +%FT%TZ)] crawl-banks: starting"

# The crawler writes atomically and leaves the old index untouched on failure;
# a non-zero exit here means we skip the commit entirely.
if ! npm run --silent crawl-banks; then
  echo "[$(date -u +%FT%TZ)] crawl-banks: crawl FAILED — leaving index untouched, no commit"
  exit 1
fi

if git diff --quiet -- data/banks.json shared/banks-digest.md; then
  echo "[$(date -u +%FT%TZ)] crawl-banks: no changes to the index — nothing to commit"
  exit 0
fi

git add data/banks.json shared/banks-digest.md
git commit -m "chore(crawl): refresh Strudel bank discovery index ($(date -u +%F))" \
  -m "Automated weekly crawl via vimsical-crate-crawl-banks.timer."
echo "[$(date -u +%FT%TZ)] crawl-banks: committed refreshed index"
