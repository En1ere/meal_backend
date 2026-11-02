# Local encrypted backup

Checkpoint 9 creates an encrypted **local** recovery repository on the current VPS. It reduces the risk of an application, migration or operator error, but it does not survive loss of the VPS or its disk. Every status and admin projection therefore keeps `offsite: false`; the existing offsite recovery contract remains blocked and is not weakened.

## Policy

- schedule: every day at `01:00 Asia/Yekaterinburg` (`UTC+05:00`, normally `20:00 UTC` on the previous calendar day);
- timer: persistent, so a run missed during reboot starts after the host returns;
- temporary RPO: 24 hours;
- temporary RTO: 4 hours;
- retention: 7 daily and 4 weekly snapshots;
- repository: `/var/backups/meal-planner/local-restic`;
- recovery password: `/etc/meal-planner/secrets/local-backup-password`, `root:root 0600`;
- bounded status: `/var/lib/meal-planner/observability/local-backup.json`, `root:meal-observability 0640`.

Restic supplies authenticated encryption, content checksums, immutable snapshot identities and exact restore. The repository password is generated once by the root bootstrap and is never printed, committed, copied into `deploy.env` or returned by an API. While both repository and password remain on this VPS, total host loss is unrecoverable. Exporting the password to an owner-controlled offline secret store and adding a separate immutable offsite repository are later checkpoints.

## Install

Ubuntu package installation is an explicit host operation:

```sh
apt-get update
apt-get install --yes restic jq
cd /srv/meal/deployment
./bootstrap-local-backup.sh
systemctl status meal-local-backup.timer --no-pager
systemd-analyze calendar '*-*-* 01:00:00 Asia/Yekaterinburg'
```

The bootstrap installs root-owned scripts and systemd units, creates fixed backup directories, generates the password only when absent, initializes the repository and enables the timer. The shared `/etc/meal-planner/secrets` directory must already exist as a root-owned `0700`, `0710` or `0750` directory; this checkpoint never changes its owner, group or mode. It does not silently create the first snapshot. Create and verify it explicitly:

```sh
systemctl start meal-local-backup.service
systemctl status meal-local-backup.service --no-pager
journalctl -u meal-local-backup.service --since -30m --no-pager
```

The job takes the same bounded deployment lock used by rollout and a separate non-waiting backup lock. It refuses to start below 5 GiB or 20% free space and also reserves space for the measured PostgreSQL database plus media tree. PostgreSQL is dumped online in custom format and validated with the pinned PostgreSQL image. Migration/grants manifests and immutable image inventory are exported from the pinned backend image. Secrets and full environment files are excluded.

When temporary SeaweedFS infrastructure is enabled but the user media API remains disabled, the job stops SeaweedFS under the deployment lock, hashes and snapshots the provider tree, and restarts it through an exit trap. If `MEDIA_STORAGE_ENABLED=true`, the job fails with `media_unsafe`: a live provider needs a separately approved quiesce or provider-native snapshot strategy. Archiving a changing SeaweedFS directory is never reported as a valid backup.

After an exact snapshot readback and `restic check`, retention runs as `keep-daily 7`, `keep-weekly 4`, followed by prune. Retention never runs before a new verified snapshot. Plaintext staging is root-only and removed on success, failure and interruption.

## Isolated restore drill

Use the complete 64-character snapshot ID from the root-only service output/status and a bounded change ticket:

```sh
/usr/local/libexec/meal-planner/local-backup-restore-drill.sh \
  --snapshot 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --change-ticket OPS-BACKUP-001
```

The drill restores to a fixed root-only temporary directory and starts the pinned PostgreSQL 18 image with `--network none`, no host port and tmpfs data. It verifies artifact hashes, restores in one transaction with `--no-owner --no-acl`, and requires schema `34`, 227 base tables and 519 foreign keys. A serializable read smoke and exact media checksum coverage must pass. The source database and provider tree are never mounted writable. The disposable container and exact restore directory are removed by a bounded trap; only the safe status/evidence remains. A measured duration above four hours fails the drill.

## Status and admin

The atomic JSON status contains schema version `1`; `ok`/`failed` state; attempt, success, snapshot and observation timestamps; snapshot ID; non-negative repository and artifact counts; recovery-key presence; the fixed schedule, retention and RPO/RTO/offsite policy; restore outcome and duration; and one bounded failure code. Failure codes are `disk_guard`, `postgres_unavailable`, `media_unsafe`, `snapshot_failed`, `verification_failed`, `restore_failed` and `runtime_failed`. It contains no filesystem paths, usernames, connection strings, image values, filenames or raw errors. The backend reads it through the existing read-only observability mount with strict owner/group/mode/size/mtime/symlink validation. Local readiness must not remove the independent `offsite_target_missing` blocker.

## Disable and recovery

Disable future runs without deleting evidence:

```sh
systemctl disable --now meal-local-backup.timer
```

Do not delete the repository, password or last status during disable. Re-enable with `systemctl enable --now meal-local-backup.timer`. Repository deletion, password rotation and restore into the live database are destructive operations and require a separate approved runbook. Losing the password makes every local snapshot permanently unreadable.
