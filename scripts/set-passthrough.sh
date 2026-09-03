#!/usr/bin/env bash
# set-passthrough.sh
# Enables, disables, or checks Review Yeti emergency passthrough mode organization-wide
# at the exampleorg/example-review-actions dispatch level.

set -euo pipefail

TARGET_REPO="exampleorg/example-review-actions"
COMMAND="${1:-status}"

case "$COMMAND" in
  on|enable|true)
    echo "Enabling Review Yeti passthrough mode organization-wide on ${TARGET_REPO}..."
    gh variable set REVIEW_YETI_PASSTHROUGH --body "true" -R "$TARGET_REPO"
    echo "✓ Passthrough mode is now ENABLED. All dispatched reviews across all repositories will bypass LLM and deliver immediate SHIP."
    ;;
  off|disable|false)
    echo "Disabling Review Yeti passthrough mode organization-wide on ${TARGET_REPO}..."
    gh variable set REVIEW_YETI_PASSTHROUGH --body "false" -R "$TARGET_REPO"
    echo "✓ Passthrough mode is now DISABLED. Standard Review Yeti LLM review panel restored across all repositories."
    ;;
  status)
    val="$(gh variable get REVIEW_YETI_PASSTHROUGH -R "$TARGET_REPO" --json value -q .value 2>/dev/null || echo "not set")"
    echo "Review Yeti central passthrough variable (${TARGET_REPO}): ${val}"
    if [[ "$val" == "true" || "$val" == "1" ]]; then
      echo "Status: PASSTHROUGH MODE IS ACTIVE (All dispatched repos bypass LLM and receive immediate SHIP)"
    else
      echo "Status: PASSTHROUGH MODE IS INACTIVE (Standard LLM review panel is active)"
    fi
    ;;
  *)
    echo "Usage: $0 [on|off|status]"
    echo ""
    echo "Commands:"
    echo "  on      Enable passthrough mode org-wide (all repos bypass LLM and receive immediate SHIP)"
    echo "  off     Disable passthrough mode org-wide (standard LLM evaluation resumes)"
    echo "  status  Check current central passthrough status on ${TARGET_REPO}"
    exit 1
    ;;
esac
