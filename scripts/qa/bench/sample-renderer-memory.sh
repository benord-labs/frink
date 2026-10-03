#!/bin/sh
# sample-renderer-memory.sh <out.csv> [seconds=600] [interval=10] [profile="Frink Dev-21399"] — one row per QA renderer per interval: ts,pid,footprint_mb (counts compressed pages),rss_mb.
OUT=$1; SECS=${2:-600}; INTERVAL=${3:-10}; PROFILE=${4:-Frink Dev-21399}
[ -n "$OUT" ] || { echo "usage: $0 <out.csv> [seconds] [interval] [profile]" >&2; exit 2; }
echo "ts,pid,footprint_mb,rss_mb" > "$OUT"
END=$(( $(date +%s) + SECS ))
while [ "$(date +%s)" -lt "$END" ]; do
  MAIN=$(ps -eo pid=,ppid=,command= | grep -- "--user-data-dir=$HOME/Library/Application Support/$PROFILE" | grep -v grep | awk '{print $2}' | sort -u | head -1)
  TS=$(date +%H:%M:%S)
  if [ -n "$MAIN" ]; then
    for PID in $(ps -eo pid=,ppid=,command= | awk -v m="$MAIN" '$2 == m && /--type=renderer/ { print $1 }'); do
      FP=$(footprint "$PID" 2>/dev/null | grep -o "Footprint: *[0-9.]* [KMG]B" | head -1 | awk '{ v = $2; if ($3 == "GB") v = v * 1024; if ($3 == "KB") v = v / 1024; printf "%.0f", v }')
      RSS=$(ps -o rss= -p "$PID" | awk '{ printf "%.0f", $1 / 1024 }')
      echo "$TS,$PID,$FP,$RSS" >> "$OUT"
    done
  else
    echo "$TS,,," >> "$OUT"
  fi
  sleep "$INTERVAL"
done
