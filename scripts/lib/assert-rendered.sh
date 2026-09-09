#!/usr/bin/env bash
# Shared post-render guard for every envsubst-based manifest renderer.
#
# envsubst substitutes bare ${VAR} only. It does NOT understand shell parameter
# expansion, so ${VAR:-default} is copied through verbatim and lands in the live
# object as the literal 12+ character string. Server-side apply accepts it, the
# rollout goes green, and the wrong value is only felt later at runtime -- for a
# boolean read as `=== 'true'` that silently means false.
#
# k8s/action-dispatch.yaml.tpl carried "${ACTION_DISPATCH_ALLOW_APP_GATE:-...}"
# from 2026-09-03 to 2026-09-09. It never once expanded, so every deploy through
# the script wrote a literal string and disabled app-gate admission -- the exact
# outcome the caller's "state true or false explicitly" prompt existed to
# prevent. Detection belongs here, next to the render, not in each caller.

# assert_no_unsubstituted_placeholders <rendered-file> [context]
assert_no_unsubstituted_placeholders() {
  local file="$1" context="${2:-$(basename "$1")}" leftover
  leftover="$(grep -n '\${' "$file" || true)"
  [[ -z "$leftover" ]] && return 0
  {
    echo "${context}: unsubstituted placeholder(s) remain after envsubst; refusing to apply."
    echo "$leftover" | sed 's/^/  /'
    echo "envsubst expands bare \${VAR} only -- \${VAR:-default} is NOT expanded."
    echo "Use a bare \${VAR} and enforce any default in the calling script."
  } >&2
  return 2
}
