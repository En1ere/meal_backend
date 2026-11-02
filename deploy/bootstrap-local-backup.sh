#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY=/var/backups/meal-planner/local-restic
PASSWORD_FILE=/etc/meal-planner/secrets/local-backup-password

[ "$(id -u)" = 0 ] || { echo 'Local backup bootstrap requires root' >&2; exit 77; }
for command in restic jq docker systemctl systemd-analyze systemd-tmpfiles openssl flock; do
    command -v "$command" >/dev/null 2>&1 || { echo "Required command is missing: $command" >&2; exit 69; }
done
for source in \
    "$SCRIPT_DIR/common.sh" \
    "$SCRIPT_DIR/local-backup.sh" \
    "$SCRIPT_DIR/local-backup-restore-drill.sh" \
    "$SCRIPT_DIR/systemd/meal-local-backup.service" \
    "$SCRIPT_DIR/systemd/meal-local-backup.timer" \
    "$SCRIPT_DIR/tmpfiles.d/meal-local-backup.conf"; do
    [ -f "$source" ] && [ ! -L "$source" ] || { echo "Unsafe bootstrap source: $source" >&2; exit 77; }
done

install -d -o root -g root -m 0755 /usr/local/libexec/meal-planner /etc/systemd/system /etc/tmpfiles.d
install -o root -g root -m 0755 "$SCRIPT_DIR/common.sh" /usr/local/libexec/meal-planner/common.sh
install -o root -g root -m 0755 "$SCRIPT_DIR/local-backup.sh" /usr/local/libexec/meal-planner/local-backup.sh
install -o root -g root -m 0755 "$SCRIPT_DIR/local-backup-restore-drill.sh" /usr/local/libexec/meal-planner/local-backup-restore-drill.sh
install -o root -g root -m 0644 "$SCRIPT_DIR/systemd/meal-local-backup.service" /etc/systemd/system/meal-local-backup.service
install -o root -g root -m 0644 "$SCRIPT_DIR/systemd/meal-local-backup.timer" /etc/systemd/system/meal-local-backup.timer
install -o root -g root -m 0644 "$SCRIPT_DIR/tmpfiles.d/meal-local-backup.conf" /etc/tmpfiles.d/meal-local-backup.conf
systemd-tmpfiles --create /etc/tmpfiles.d/meal-local-backup.conf

secret_directory=$(dirname "$PASSWORD_FILE")
[ -d "$secret_directory" ] && [ ! -L "$secret_directory" ] || {
    echo 'Existing /etc/meal-planner/secrets bootstrap is required' >&2; exit 77;
}
[ "$(stat -c %u "$secret_directory")" = 0 ] || { echo 'Secret directory must be root-owned' >&2; exit 77; }
case "$(stat -c %a "$secret_directory")" in 700|710|750) ;; *) echo 'Secret directory mode is unsafe' >&2; exit 77 ;; esac
if [ ! -e "$PASSWORD_FILE" ]; then
    umask 077
    openssl rand -base64 48 >"$PASSWORD_FILE"
fi
[ -f "$PASSWORD_FILE" ] && [ ! -L "$PASSWORD_FILE" ] && [ "$(stat -c %u "$PASSWORD_FILE")" = 0 ] || {
    echo 'Local backup password file is unsafe' >&2; exit 77;
}
[ "$(stat -c %a "$PASSWORD_FILE")" = 600 ] || {
    echo 'Existing local backup password must already have mode 0600' >&2; exit 77;
}

export RESTIC_REPOSITORY=$REPOSITORY RESTIC_PASSWORD_FILE=$PASSWORD_FILE
if [ ! -f "$REPOSITORY/config" ]; then restic init >/dev/null; fi
restic snapshots --json >/dev/null
systemd-analyze verify /etc/systemd/system/meal-local-backup.service /etc/systemd/system/meal-local-backup.timer
systemd-analyze calendar '*-*-* 01:00:00 Asia/Yekaterinburg' >/dev/null
systemctl daemon-reload
systemctl enable --now meal-local-backup.timer
echo 'Local encrypted backup repository and 01:00 Asia/Yekaterinburg timer are ready; run the initial backup explicitly'
