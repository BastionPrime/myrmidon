set -eu
umask 077
cd "$1"
n=00000000ffffffff
# 1. staging from interrupted earlier applies
for root in data/hermes workspace scratch; do
  for stale in "$root"/.myrmidon-next-* "$root"/.myrmidon-apply-* "$root"/.myrmidon-old-*; do
    [ -e "$stale" ] || continue
    case "${stale#"$root"/}" in
      ".myrmidon-next-$n" | ".myrmidon-apply-$n") ;;
      *) rm -rf -- "$stale" ;;
    esac
  done
done
# 2. compiler-owned directories, replaced wholesale
staged="data/hermes/.myrmidon-next-$n/skills-board"
live="data/hermes/skills-board"
if [ -d "$staged" ]; then
  old="data/hermes/.myrmidon-old-$n"
  mkdir -p -- "$old"
  if [ -e "$live" ] || [ -L "$live" ]; then mv -f -T -- "$live" "$old/0"; fi
  mkdir -p -- "$(dirname -- "$live")"
  mv -f -T -- "$staged" "$live"
fi
# 3. every other staged file, one atomic rename each
list="data/hermes/.myrmidon-apply-00000000ffffffff/staged.list"
for root in data/hermes workspace scratch; do
  staging="$root/.myrmidon-next-$n"
  [ -d "$staging" ] || continue
  (cd "$staging" && find . -type f) > "$list"
  while IFS= read -r rel; do
    rel="${rel#./}"
    mkdir -p -- "$(dirname -- "$root/$rel")"
    mv -f -T -- "$staging/$rel" "$root/$rel"
  done < "$list"
done
# 4. files the previous apply wrote that this profile no longer has
removals="data/hermes/.myrmidon-apply-00000000ffffffff/remove.list"
if [ -f "$removals" ]; then
  while IFS= read -r p; do
    case "$p" in
      hermes/*) dest="data/hermes/${p#hermes/}" ;;
      workspace/*) dest="workspace/${p#workspace/}" ;;
      scratch/*) dest="scratch/${p#scratch/}" ;;
      *) continue ;;
    esac
    if [ -f "$dest" ] || [ -L "$dest" ]; then rm -f -- "$dest"; fi
  done < "$removals"
fi
# 5. the applied-state marker, strictly last
mkdir -p -- "data/hermes/.myrmidon"
mv -f -T -- "data/hermes/.myrmidon-apply-00000000ffffffff/applied.json" "data/hermes/.myrmidon/applied.json"
rm -rf -- "data/hermes/.myrmidon-next-$n" "workspace/.myrmidon-next-$n" "scratch/.myrmidon-next-$n" "data/hermes/.myrmidon-apply-00000000ffffffff" "data/hermes/.myrmidon-old-$n"