# simple-gpt-mcp: stdio MCP server for OpenAI conversations.
# Bare `make` prints help. Every target installs dependencies itself when the lockfile changes.

.DEFAULT_GOAL := help
DEPS := node_modules/.install-stamp

.PHONY: help mcp-config check build test dev format audit clean

help:
	@echo "simple-gpt-mcp"
	@echo ""
	@echo "  make mcp-config   Build, then print the MCP host config for this checkout"
	@echo "  make check        Everything CI runs: types, lint, format, build, tests + coverage"
	@echo ""
	@echo "  make build        Build dist/"
	@echo "  make test         Build and run tests without coverage gates"
	@echo "  make dev          Run the server from source over stdio"
	@echo "  make format       Rewrite files with Prettier"
	@echo "  make audit        Fail on high or critical dependency advisories"
	@echo "  make clean        Remove dist/ and node_modules/"

# engineStrict in pnpm-workspace.yaml refuses an unsupported Node version here.
$(DEPS): package.json pnpm-lock.yaml pnpm-workspace.yaml
	pnpm install --frozen-lockfile
	@touch $@

mcp-config: build
	@pnpm --silent run mcp-config

check: $(DEPS)
	pnpm run check

build: $(DEPS)
	pnpm run build

test: $(DEPS)
	pnpm test

dev: $(DEPS)
	pnpm run dev

format: $(DEPS)
	pnpm run format

audit: $(DEPS)
	pnpm audit --audit-level high

clean:
	rm -rf dist node_modules
