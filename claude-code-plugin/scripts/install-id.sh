#!/bin/sh
# xlsx-for-ai plugin: Claude Code's headersHelper for the spreadsheets server.
#
# Prints {"x-xfa-install":"<id>"} and nothing else. The id is 64 random hex
# characters, made once and kept in this plugin's own data folder (the first
# argument, ${CLAUDE_PLUGIN_DATA}) as install-id, readable by the user only.
# The hosted server uses it to offer a sign-in link on the first tool call and
# to know this install after the user approves. The script reads no other
# file and sends nothing itself.
#
# On any problem it prints {} so the server answers as it did before this
# header existed (sign in through /mcp).

dir=${1:-$CLAUDE_PLUGIN_DATA}
none() { printf '{}\n'; exit 0; }

is_id() {
  case $1 in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ ${#1} -eq 64 ]
}

[ -n "$dir" ] || none
umask 077
mkdir -p "$dir" 2>/dev/null || none
f=$dir/install-id

id=$(cat "$f" 2>/dev/null)
if ! is_id "$id"; then
  new=$(od -An -tx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \n')
  is_id "$new" || none
  tmp=$f.$$
  printf '%s' "$new" > "$tmp" 2>/dev/null || none
  chmod 600 "$tmp" 2>/dev/null
  if [ -e "$f" ]; then
    # A damaged file: replace it.
    mv -f "$tmp" "$f" 2>/dev/null
  elif ! ln "$tmp" "$f" 2>/dev/null; then
    # ln refuses when another session made the file first: keep theirs.
    # Where hard links are not supported, move the file into place.
    [ -e "$f" ] || mv -f "$tmp" "$f" 2>/dev/null
  fi
  rm -f "$tmp" 2>/dev/null
  id=$(cat "$f" 2>/dev/null)
  is_id "$id" || none
fi
chmod 600 "$f" 2>/dev/null

printf '{"x-xfa-install":"%s"}\n' "$id"
