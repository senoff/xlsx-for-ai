# gh_retry — XLS-1796 D3: bounded exponential-backoff + jitter wrapper around a `gh` call.
#
# Source this file, then invoke `gh_retry <args…>` exactly as you would `gh <args…>`. It retries a
# failing call (transient network / 5xx / secondary rate-limit) up to GH_RETRY_ATTEMPTS times with
# exponential backoff (GH_RETRY_BASE_SECONDS, doubling, capped at GH_RETRY_CAP_SECONDS) plus a small
# random jitter, then returns the command's own exit status. It does NOT decide fail-open vs
# fail-closed — the caller does: the D1 check-runs read treats an exhausted read as fail-closed
# (no mint, no RED), while the marker POST on a passed head treats an exhausted post as RED.
#
# Each attempt is bounded by a per-call wall-clock `timeout` (GH_RETRY_TIMEOUT_SECONDS, default 60)
# so ONE hung `gh` cannot consume the whole job budget and starve the retry loop — a timed-out call
# is just another retryable failure. If the runner has no `timeout` binary the call runs unbounded
# (falls back to the bare invocation). The jittered backoff uses awk for fractional sleep but falls
# back to an integer sleep when awk is absent or `sleep` rejects fractions, so the retry path itself
# can never break on a minimal image.
#
# Defaults: ~5 attempts, 2→4→8→16s (jittered), 30s cap, 60s per-attempt timeout. Overridable via env.

gh_retry() {
  # Tolerate a non-numeric override (fall back to the default) so a stray env value can never turn
  # the retry helper itself into the failure — an unset/blank/non-integer knob just uses the default.
  local attempts="${GH_RETRY_ATTEMPTS:-5}"; case "$attempts" in ''|*[!0-9]*) attempts=5 ;; esac
  # Clamp to at least 1: '0' is all-digits (passes the numeric guard) but the loop still runs once,
  # so a 0 would report "failed after 0 attempt(s)" while having tried once. Floor it to an honest 1.
  [ "$attempts" -lt 1 ] && attempts=1
  local base="${GH_RETRY_BASE_SECONDS:-2}"; case "$base" in ''|*[!0-9]*) base=2 ;; esac
  local cap="${GH_RETRY_CAP_SECONDS:-30}"; case "$cap" in ''|*[!0-9]*) cap=30 ;; esac
  local tmo="${GH_RETRY_TIMEOUT_SECONDS:-60}"; case "$tmo" in ''|*[!0-9]*) tmo=60 ;; esac
  [ "$tmo" -lt 1 ] && tmo=60
  # Bound each attempt with `timeout` when the runner has it; otherwise run bare (still retried).
  local have_timeout=0
  if command -v timeout >/dev/null 2>&1; then have_timeout=1; fi
  local n=1 delay="$base" rc=0

  while :; do
    # Run one attempt in an AND-OR list so a failure is captured, never tripping the caller's set -e.
    if [ "$have_timeout" = 1 ]; then
      timeout "$tmo" gh "$@" && return 0 || rc=$?
    else
      gh "$@" && return 0 || rc=$?
    fi
    if [ "$n" -ge "$attempts" ]; then
      # Log ONLY a known-safe gh subcommand verb, never the raw first argument: a reusable wrapper
      # must not echo argv on failure, since a caller's args (or even argv[1] itself, in principle)
      # could carry a token/URL/-f field. Grace CRITICAL (2026-09-30): don't trust $1 at all — map it
      # through an explicit allowlist and log a fixed placeholder for anything else. rc + attempts
      # suffice for diagnosis; rc=124 here is a per-attempt timeout, surfaced like any other failure.
      local verb="<redacted>"
      case "${1:-}" in
        api|pr|issue|repo|run|workflow|release|auth|gist|org|secret|variable) verb="$1" ;;
      esac
      echo "gh_retry: 'gh ${verb} …' failed after ${attempts} attempt(s) (last rc=${rc})" >&2
      return "$rc"
    fi
    # jitter in [0,1)s from bash $RANDOM (seeded per-process, so parallel retries do NOT align —
    # unlike awk rand() with a fixed default seed); total sleep capped at ${cap}s.
    local jitter_ms=$(( RANDOM % 1000 ))
    local sleep_s=""
    if command -v awk >/dev/null 2>&1; then
      sleep_s="$(awk -v d="$delay" -v j="$jitter_ms" -v c="$cap" 'BEGIN{ s=d + j/1000; if (s>c) s=c; printf "%.2f", s }')"
    fi
    echo "gh_retry: attempt ${n}/${attempts} failed (rc=${rc}); retrying in ~${sleep_s:-$delay}s" >&2
    # Prefer the jittered fractional sleep; fall back to an integer sleep on a minimal image (no awk,
    # or a `sleep` that rejects fractions) so the backoff itself can never break the retry path.
    if [ -z "$sleep_s" ] || ! sleep "$sleep_s" 2>/dev/null; then
      local int_s="$delay"; [ "$int_s" -gt "$cap" ] && int_s="$cap"
      sleep "$int_s"
    fi
    n=$(( n + 1 ))
    delay=$(( delay * 2 ))
    [ "$delay" -gt "$cap" ] && delay="$cap"
  done
}
