#!/usr/bin/env bash
# Local throwaway Postgres cluster for dev and tests (trust auth, port 54329).
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v pg_ctl)")";
  elif [ -d "/c/Program Files/PostgreSQL/17/bin" ]; then PGBIN="/c/Program Files/PostgreSQL/17/bin";
  else echo "pg_ctl not found; set PGBIN" >&2; exit 1; fi
fi
DATA=".pgdata"; PORT="${PGPORT:-54329}"
case "${1:-start}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c max_connections=200" -l "$DATA/server.log" -w status >/dev/null 2>&1 \
      || "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c max_connections=200" -l "$DATA/server.log" -w start >/dev/null
    for db in leash leash_test; do
      "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
        || "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$db"
    done
    echo "postgres://postgres@127.0.0.1:$PORT/leash" ;;
  stop) "$PGBIN/pg_ctl" -D "$DATA" -w stop ;;
  *) echo "usage: dev-db.sh start|stop" >&2; exit 2 ;;
esac
