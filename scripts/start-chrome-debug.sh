#!/usr/bin/env bash
# 使用独立 user-data-dir 启动带远程调试端口的 Chrome，避免与日常浏览器配置冲突。
set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"
USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$HOME/.zero-token/chrome-debug-profile}"

# CHROME_HEADLESS=1 时附加 --headless=new（仍暴露 CDP，供本工具 attach；登录/扫码等需有界面时勿用）
# CHROME_DEBUG_QUIET=1 时不向终端 echo，且子进程（Chrome）stdout/stderr 重定向，避免 "DevTools listening" 等（make 目标使用）
EXTRA=()
if [[ "${CHROME_HEADLESS:-0}" == "1" || "${CHROME_HEADLESS:-}" == "true" ]]; then
  EXTRA+=(--headless=new)
fi

# 用 bundle 内可执行文件启动，避免 open --args 丢參致秒退
# 空数组 + set -u 在 Bash 3.2 下会误报 unbound，用 :+ 规避
_run_chrome() {
  if [[ "${CHROME_DEBUG_QUIET:-0}" == "1" || "${CHROME_DEBUG_QUIET:-}" == "true" ]]; then
    "$@" &>/dev/null &
  else
    "$@" &
  fi
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  CHROME_APP="/Applications/Google Chrome.app"
  CHROME_MAC_BIN="${CHROME_APP}/Contents/MacOS/Google Chrome"
  if [[ -x "$CHROME_MAC_BIN" ]]; then
    _run_chrome "$CHROME_MAC_BIN" \
      --remote-debugging-port="${PORT}" \
      --user-data-dir="${USER_DATA_DIR}" \
      --no-first-run \
      ${EXTRA[@]:+"${EXTRA[@]}"}
  else
    echo "未找到可执行的 Chrome: ${CHROME_MAC_BIN}（需安装到 ${CHROME_APP}），或自行用 Chromium 加 --remote-debugging-port=${PORT}" >&2
    exit 1
  fi
elif command -v google-chrome-stable &>/dev/null; then
  _run_chrome google-chrome-stable --remote-debugging-port="${PORT}" --user-data-dir="${USER_DATA_DIR}" --no-first-run ${EXTRA[@]:+"${EXTRA[@]}"}
elif command -v google-chrome &>/dev/null; then
  _run_chrome google-chrome --remote-debugging-port="${PORT}" --user-data-dir="${USER_DATA_DIR}" --no-first-run ${EXTRA[@]:+"${EXTRA[@]}"}
elif command -v chromium &>/dev/null; then
  _run_chrome chromium --remote-debugging-port="${PORT}" --user-data-dir="${USER_DATA_DIR}" --no-first-run ${EXTRA[@]:+"${EXTRA[@]}"}
else
  echo "未找到 google-chrome / chromium，请手动启动并加上: --remote-debugging-port=${PORT} --user-data-dir=..." >&2
  exit 1
fi

if [[ "${CHROME_DEBUG_QUIET:-0}" != "1" && "${CHROME_DEBUG_QUIET:-}" != "true" ]]; then
  if [[ ${#EXTRA[@]} -gt 0 ]]; then
    echo "已尝试以无头模式启动 Chrome，远程调试: http://127.0.0.1:${PORT}"
  else
    echo "已尝试启动 Chrome（有界面、默认非无头，便于登录与扫码），远程调试: http://127.0.0.1:${PORT}"
  fi
  echo "用户数据: ${USER_DATA_DIR}"
  echo "若仍闪退：同一路径只能被单个 Chrome 占用，请先退出用该配置启动的实例，或设 CHROME_USER_DATA_DIR=其他目录"
  echo "自检: curl -sS http://127.0.0.1:${PORT}/json/version | head -c 200"
  echo "环境变量 BROWSER_CDP_URL 可设为: http://127.0.0.1:${PORT}"
fi
