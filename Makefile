.PHONY: install compose-ui run build preview stop status lint lint-fix format format-check \
	test test-watch test-cov check ci clean help golden-check

# Default target
.DEFAULT_GOAL := help

# Variables
PORT ?= 5173

# shared-react-ui: composed in-place from sibling repo dir during local dev.
# Outside the monorepo (after scaffold) the source dir is absent and the
# target becomes a no-op, so the scaffolded project keeps working unchanged.
SHARED_UI_SRC := ../shared-react-ui/src/ui
SHARED_UI_DEST := src/components/ui

## install: Install dependencies (composes shared-react-ui first)
install: compose-ui
	npm install

## compose-ui: Materialize src/components/ui/ from ../shared-react-ui/ (no-op outside monorepo)
compose-ui:
	@if [ -d "$(SHARED_UI_SRC)" ]; then \
		echo "[compose-ui] $(SHARED_UI_SRC) -> $(SHARED_UI_DEST) (excl. *.stories.tsx)"; \
		mkdir -p $(SHARED_UI_DEST); \
		rsync -a --exclude='*.stories.tsx' $(SHARED_UI_SRC)/ $(SHARED_UI_DEST)/; \
	fi

## run: Start the Vite dev server
run:
	npm run dev

## build: Build the production bundle
build:
	npm run build

## preview: Preview the production build locally
preview:
	npm run preview

## stop: Stop the dev server
stop:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null || true

## status: Check if the dev server is running
status:
	@lsof -i :$(PORT) >/dev/null 2>&1 && echo "yoga-pose-3d: running (:$(PORT))" || echo "yoga-pose-3d: stopped"

## lint: Run linter
lint:
	npm run lint

## lint-fix: Auto-fix lint issues
lint-fix:
	npm run lint:fix

## format: Format source files
format:
	npm run format

## format-check: Check formatting without modifying files
format-check:
	npm run format:check

## test: Run tests
test:
	npm run test

## test-watch: Run tests in watch mode
test-watch:
	npm run test:watch

## test-cov: Run tests with coverage
test-cov:
	npm run test:coverage

## verify-poses: 代表ポーズ画像の回帰スクショを e2e/output/ に生成（要: make run 起動済み）
verify-poses:
	node e2e/pose-verify.mjs

## golden-render: ゴールデンポーズを直接適用したレンダーを e2e/golden/renders/ に生成（要: make run 起動済み。POSE=<id> で単一）
golden-render:
	node e2e/golden-render.mjs

## pose-score: 実写真のパイプライン出力とゴールデンの角度差からスコアを算出（要: make run 起動済み + e2e/golden/sources.local.json）
pose-score:
	node e2e/pose-score.mjs

## golden-check: ゴールデン品質の定量指標（ROM/めり込み/写真整合）を出力（要: make run 起動済み。POSE=<id> で単一）
golden-check:
	node e2e/golden-check.mjs

## check: Run lint + test
check: lint test

## ci: Run lint + format-check + test with coverage + build
ci: lint format-check test-cov build

## clean: Remove build artifacts
clean:
	rm -rf dist node_modules coverage

## help: Show this help
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'
