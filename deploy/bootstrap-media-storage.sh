#!/usr/bin/env sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 77; }

MEDIA_GID=${MEAL_MEDIA_GID:-29003}
MEDIA_GROUP=${MEAL_MEDIA_GROUP:-meal-media}
MEDIA_ROOT=${MEDIA_STORAGE_HOST_ROOT:-/var/lib/meal-planner/media/provider}
SECRETS_ROOT=${MEAL_SECRETS_ROOT:-/etc/meal-planner/secrets}
ACCESS_KEY_ID=${MEDIA_STORAGE_ACCESS_KEY_ID:-meal-backend-v1}
PROCESSOR_ACCESS_KEY_ID=${MEDIA_PROCESSOR_STORAGE_ACCESS_KEY_ID:-meal-media-processor-v1}

[ "$MEDIA_GID" = 29003 ] || { echo "MEAL_MEDIA_GID must remain 29003" >&2; exit 64; }
case "$MEDIA_ROOT" in /var/lib/meal-planner/media/provider) ;; *) echo "Unsafe media root" >&2; exit 64 ;; esac
case "$SECRETS_ROOT" in /etc/meal-planner/secrets) ;; *) echo "Unsafe secrets root" >&2; exit 64 ;; esac

for path in /var/lib/meal-planner /var/lib/meal-planner/media "$MEDIA_ROOT" "$SECRETS_ROOT"; do
    [ ! -L "$path" ] || { echo "Refusing symlink: $path" >&2; exit 77; }
done

if getent group "$MEDIA_GROUP" >/dev/null 2>&1; then
    [ "$(getent group "$MEDIA_GROUP" | cut -d: -f3)" = "$MEDIA_GID" ] || {
        echo "$MEDIA_GROUP has unexpected GID" >&2; exit 77;
    }
elif getent group "$MEDIA_GID" >/dev/null 2>&1; then
    echo "GID $MEDIA_GID is already assigned" >&2
    exit 77
else
    groupadd --system --gid "$MEDIA_GID" "$MEDIA_GROUP"
fi
getent group meal-secrets >/dev/null 2>&1 || { echo "meal-secrets group is required" >&2; exit 77; }

install -d -o root -g root -m 0750 /var/lib/meal-planner/media
install -d -o root -g "$MEDIA_GROUP" -m 2770 "$MEDIA_ROOT"
install -d -o root -g root -m 0750 "$SECRETS_ROOT"

create_secret() {
    target=$1 value=$2 owner_group=$3 mode=$4
    if [ -e "$target" ] || [ -L "$target" ]; then
        [ -f "$target" ] && [ ! -L "$target" ] || { echo "Unsafe secret path" >&2; exit 77; }
    else
        umask 077
        temporary="$target.tmp.$$"
        trap 'rm -f "$temporary"' EXIT HUP INT TERM
        (set -C; printf '%s\n' "$value" >"$temporary") 2>/dev/null || {
            echo "Unable to create secret" >&2; exit 77;
        }
        chown root:"$owner_group" "$temporary"
        chmod "$mode" "$temporary"
        mv "$temporary" "$target"
        trap - EXIT HUP INT TERM
    fi
    [ "$(stat -c '%u %G %a' "$target")" = "0 $owner_group $mode" ] || {
        echo "Unsafe secret metadata" >&2; exit 77;
    }
}

access_secret=$(openssl rand -hex 32)
processor_access_secret=$(openssl rand -hex 32)
signing_key=$(openssl rand -base64 32 | tr -d '\n')
encryption_key=$(openssl rand -base64 32 | tr -d '\n')
[ "$signing_key" != "$encryption_key" ] || { echo "Generated media keys must differ" >&2; exit 70; }

create_secret "$SECRETS_ROOT/media-storage-secret-access-key" "$access_secret" meal-secrets 640
create_secret "$SECRETS_ROOT/media-processor-storage-secret-access-key" "$processor_access_secret" meal-secrets 640
create_secret "$SECRETS_ROOT/media-signing-key-v1" "$signing_key" meal-secrets 640
create_secret "$SECRETS_ROOT/media-encryption-key-v1" "$encryption_key" meal-secrets 640
grep -Eq '^[a-f0-9]{64}$' "$SECRETS_ROOT/media-storage-secret-access-key" || { echo "Invalid storage credential" >&2; exit 77; }
grep -Eq '^[a-f0-9]{64}$' "$SECRETS_ROOT/media-processor-storage-secret-access-key" || { echo "Invalid processor storage credential" >&2; exit 77; }
[ "$(cat "$SECRETS_ROOT/media-storage-secret-access-key")" != "$(cat "$SECRETS_ROOT/media-processor-storage-secret-access-key")" ] || {
    echo "Backend and processor storage credentials must differ" >&2
    exit 77
}
grep -Eq '^[A-Za-z0-9+/]{43}=$' "$SECRETS_ROOT/media-signing-key-v1" || { echo "Invalid signing key" >&2; exit 77; }
grep -Eq '^[A-Za-z0-9+/]{43}=$' "$SECRETS_ROOT/media-encryption-key-v1" || { echo "Invalid encryption key" >&2; exit 77; }
[ "$(cat "$SECRETS_ROOT/media-signing-key-v1")" != "$(cat "$SECRETS_ROOT/media-encryption-key-v1")" ] || {
    echo "Stored media keys must differ" >&2
    exit 77
}

stored_secret=$(cat "$SECRETS_ROOT/media-storage-secret-access-key")
processor_stored_secret=$(cat "$SECRETS_ROOT/media-processor-storage-secret-access-key")
old_s3_config=$(printf '{"identities":[{"name":"meal-backend","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read","Write","List"]}]}' "$ACCESS_KEY_ID" "$stored_secret")
s3_config=$(printf '{"identities":[{"name":"meal-backend","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read","Write","List"]},{"name":"meal-media-processor","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read","Write","List"]}]}' "$ACCESS_KEY_ID" "$stored_secret" "$PROCESSOR_ACCESS_KEY_ID" "$processor_stored_secret")
s3_config_path="$SECRETS_ROOT/seaweedfs-s3-config.json"
if [ -f "$s3_config_path" ] && [ ! -L "$s3_config_path" ] && [ "$(stat -c '%u %G %a' "$s3_config_path")" = '0 root 400' ]; then
    chown root:"$MEDIA_GROUP" "$s3_config_path"
    chmod 440 "$s3_config_path"
fi
if [ -f "$s3_config_path" ] && [ ! -L "$s3_config_path" ] && [ "$(cat "$s3_config_path")" = "$old_s3_config" ]; then
    temporary="$s3_config_path.tmp.$$"
    trap 'rm -f "$temporary"' EXIT HUP INT TERM
    (set -C; printf '%s\n' "$s3_config" >"$temporary") 2>/dev/null || {
        echo "Unable to migrate SeaweedFS identity config" >&2; exit 77;
    }
    chown root:"$MEDIA_GROUP" "$temporary"
    chmod 440 "$temporary"
    mv "$temporary" "$s3_config_path"
    trap - EXIT HUP INT TERM
fi
create_secret "$s3_config_path" "$s3_config" "$MEDIA_GROUP" 440
[ "$(cat "$s3_config_path")" = "$s3_config" ] || {
    echo "SeaweedFS identity config does not match the backend credential" >&2
    exit 77
}

free_kib=$(df -Pk "$MEDIA_ROOT" | awk 'NR==2 {print $4}')
used_percent=$(df -Pk "$MEDIA_ROOT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
[ $((free_kib * 1024)) -ge 5368709120 ] && [ $((100 - used_percent)) -ge 20 ] || {
    echo "Media storage requires at least 5 GiB and 20 percent free" >&2
    exit 78
}

echo "Media storage host bootstrap passed; provider and user uploads remain disabled by default"
