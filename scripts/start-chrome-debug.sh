#!/usr/bin/env bash
# 使用独立 user-data-dir 启动带远程调试端口的 Chrome，避免与日常浏览器配置冲突。
set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"
USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$HOME/.zero-token/chrome-debug-profile}"

# CHROME_HEADLESS=1 时以无头模式运行（仍暴露 CDP，供本工具 attach）
EXTRA=()
if [[ "${CHROME_HEADLESS:-0}" == "1" || "${CHROME_HEADLESS:-}" == "true" ]]; then
  EXTRA+=(--headless=new)
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    open -na "Google Chrome" --args \
      --remote-debugging-port="${PORT}" \
      --user-data-dir="${USER_DATA_DIR}" \
      --no-first-run \
      "${EXTRA[@]}"
  else
    echo "未找到 /Applications/Google Chrome.app，请安装 Google Chrome 或自行用 Chromium 增加 --remote-debugging-port=${PORT}" >&2
    exit 1
  fi
elif command -v google-chrome-stable &>/dev/null; then
  google-chrome-stable --remote-debugging-port="${PORT}" --user-data-dir="${USER_DATA_DIR}" --no-first-run "${EXTRA[@]}" &
elif command -v google-chrome &>/dev/null; then
  google-chrome --remote-debugging-port="${PORT}" --user-data-dir="${USER_DATA_DIR}" --no-first-run "${EXTRA[@]}" &
elif command -v chromium &>/dev/null; then
  chromium --remote-debugging-port="${PORT}" --user-data-dir="${USER_DATA_DIR}" --no-first-run "${EXTRA[@]}" &
else
  echo "未找到 google-chrome / chromium，请手动启动并加上: --remote-debugging-port=${PORT} --user-data-dir=..." >&2
  exit 1
fi

if [[ ${#EXTRA[@]} -gt 0 ]]; then
  echo "已尝试以无头模式启动 Chrome，远程调试: http://127.0.0.1:${PORT}"
else
  echo "已尝试启动 Chrome，远程调试: http://127.0.0.1:${PORT}"
fi
echo "自检: curl -sS http://127.0.0.1:${PORT}/json/version | head -c 200"
echo "环境变量 BROWSER_CDP_URL 可设为: http://127.0.0.1:${PORT}"
