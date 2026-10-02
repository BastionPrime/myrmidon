set -eu
cd "$1"
for d in data/hermes workspace scratch; do
  chmod 0700 "$d"
  chown 10001:10001 "$d"
done