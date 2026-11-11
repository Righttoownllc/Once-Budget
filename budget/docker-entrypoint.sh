#!/bin/sh
# Starts the server as PUID:PGID (default 1000:1000; Unraid's template uses 99:100). Started as root,
# it first makes the data folder belong to that user, because Docker and NAS systems often create the
# folder owned by root, and then the server can't create its database there.
set -e
DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ -n "$(find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit)" ]; then
    echo "Making $DATA_DIR belong to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi
# Already started as a specific user (docker run --user): just check the folder is writable.
if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  echo "Can't write to $DATA_DIR as user $(id -u):$(id -g). Make the folder you mapped to $DATA_DIR belong to that user." >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test"
exec "$@"
