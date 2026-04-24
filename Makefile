.PHONY: help install start chrome-debug login login-all typecheck health clean

# 默认目标
help:
	@echo "zero-token — 可用目标："
	@echo "  make install     安装依赖 (pnpm install)"
	@echo "  make start       启动 OpenAI 兼容网关 (可设 PORT=3001)"
	@echo "  make chrome-debug  启动带 --remote-debugging-port 的 Chrome (attach 登录用)"
	@echo "  make login       浏览器登录并保存凭据 (需设 PROVIDER=...)"
	@echo "  make login-all   按顺序登录全部平台 (单站失败不中断，见 README)"
	@echo "  make typecheck   运行 TypeScript 检查"
	@echo "  make health      请求本机 /health (需先 start，默认 PORT=3000)"
	@echo "  make clean       删除 node_modules 与锁文件 (慎用)"
	@echo ""
	@echo "示例："
	@echo "  make chrome-debug"
	@echo "  make login PROVIDER=chatgpt-web"
	@echo "  make login-all"
	@echo "  PORT=3001 make start"

PNPM := pnpm
PORT ?= 3000

install:
	$(PNPM) install

start:
	@PORT=$(PORT) $(PNPM) start

chrome-debug:
	@bash scripts/start-chrome-debug.sh

# 用法: make login PROVIDER=deepseek-web
PROVIDER ?=

login:
	@if [ -z "$(PROVIDER)" ]; then \
		echo "错误: 请设置 PROVIDER，例如: make login PROVIDER=chatgpt-web"; \
		exit 1; \
	fi
	$(PNPM) run login -- $(PROVIDER)

login-all:
	$(PNPM) run login -- all

typecheck:
	$(PNPM) run typecheck

health:
	@curl -sS "http://127.0.0.1:$(PORT)/health" && echo ""

clean:
	rm -rf node_modules pnpm-lock.yaml
