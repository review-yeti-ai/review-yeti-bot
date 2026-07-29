#!/usr/bin/env bash
set -e

mkdir -p screenshots

PORT=3000
URL="http://localhost:${PORT}"

# Check server availability
if ! curl -s "${URL}" > /dev/null; then
  echo "Starting Express/Next static server on port 3000..."
  npx serve public -p 3000 &
  SERVER_PID=$!
  trap "kill $SERVER_PID 2>/dev/null || true" EXIT
  
  for i in {1..30}; do
    if curl -s "${URL}" > /dev/null; then
      echo "Server is ready."
      break
    fi
    sleep 1
  done
fi

routes=("" "live" "repos" "settings" "integrations" "github-app")
route_names=("overview" "live" "repos" "settings" "integrations" "github-app")

for i in "${!routes[@]}"; do
  route="${routes[$i]}"
  name="${route_names[$i]}"
  target_url="${URL}/${route}"

  echo "Capturing screenshots for route: ${name} (${target_url})"

  # Desktop
  npx playwright screenshot --full-page --viewport-size "1440, 900" --wait-for-timeout 1000 "${target_url}" "screenshots/${name}.png"
  
  # Tablet
  npx playwright screenshot --full-page --viewport-size "768, 1024" --wait-for-timeout 1000 "${target_url}" "screenshots/${name}-tablet.png"

  # Mobile
  npx playwright screenshot --full-page --viewport-size "375, 667" --wait-for-timeout 1000 "${target_url}" "screenshots/${name}-mobile.png"
done

echo "Screenshots successfully captured into screenshots/ folder."
