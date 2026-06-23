# Installing the weekly bank discovery crawl timer

These units run `npm run crawl-banks` weekly in the **live** crate checkout
(`/home/builder/apps/crate`), regenerate `data/banks.json` +
`shared/banks-digest.md`, and commit the diff. The generation server reads those
files at generation time, so no rebuild or service restart is needed.

> **Do NOT run the crawl from a git worktree.** The service's `WorkingDirectory`
> is the live checkout on purpose — a worktree branch is not live.

## Files (committed in this repo)

- `deploy/vimsical-crate-crawl-banks.service` — oneshot: runs the crawl + commit.
- `deploy/vimsical-crate-crawl-banks.timer` — weekly schedule (Mon 04:30).
- `scripts/crawl-banks-commit.sh` — the wrapper the service calls (crawl, then
  commit only on success + a real diff).

## Prerequisites

- The `gh` CLI must be authenticated as `den1k` for the `builder` user
  (`gh auth status` — it reads `~/.config/gh`). The crawl uses that token for
  GitHub code search; no new secret is introduced.
- `git` in the live checkout must be able to commit (it commits locally only;
  pushing, if ever wanted, is a separate concern).

## Install (run as a user with sudo)

```bash
mkdir -p /home/builder/logs

# ⚠️ /etc gotcha (this box): /etc is sometimes mounted read-only, so installing
# unit files fails with "Read-only file system". If so, remount it rw first:
#   sudo mount -o remount,rw /etc
# (See project memory: etc-readonly-systemd-deploy.md.) DO NOT do this here —
# unit installation is the human operator's step, not the build agent's.

sudo cp /home/builder/apps/crate/deploy/vimsical-crate-crawl-banks.service \
        /etc/systemd/system/
sudo cp /home/builder/apps/crate/deploy/vimsical-crate-crawl-banks.timer \
        /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now vimsical-crate-crawl-banks.timer
```

## Verify / operate

```bash
systemctl status vimsical-crate-crawl-banks.timer
systemctl list-timers vimsical-crate-crawl-banks.timer   # next fire time
sudo systemctl start vimsical-crate-crawl-banks.service   # run once now
journalctl -u vimsical-crate-crawl-banks.service -f
tail -f /home/builder/logs/crate-crawl-banks.log
```

The crawl is resilient: a search failure, rate-limit, or zero-result run leaves
the existing index untouched (it writes atomically only on a fully successful
run), and the wrapper commits only when the index actually changed.
