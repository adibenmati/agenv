SHELL   := bash
PORT    ?= 7681
HOST    ?= 127.0.0.1
FLAGS   ?= --no-qr
PIDFILE  = .agenv.pid

.PHONY: start stop restart destroy watch status logs help

help: ## Show available targets
	@echo ""
	@echo "  Agenv"
	@echo "  --------"
	@echo "  make start       Start the server (background)"
	@echo "  make stop        Stop the server gracefully"
	@echo "  make restart     Stop + start"
	@echo "  make destroy     Force kill all agenv node processes"
	@echo "  make watch       Start with auto-reload on file changes"
	@echo "  make status      Show whether server is running"
	@echo "  make logs        Tail the server log"
	@echo ""
	@echo "  Options:"
	@echo "    PORT=7685      Override port (default 7681)"
	@echo "    HOST=0.0.0.0   Override bind address"
	@echo "    FLAGS=...      Extra flags for server.js"
	@echo ""

start: ## Start the server in background
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "[agenv] Already running (PID $$(cat $(PIDFILE)))"; \
	else \
		node server.js --port $(PORT) --host $(HOST) $(FLAGS) > .agenv.log 2>&1 & \
		echo $$! > $(PIDFILE); \
		sleep 1; \
		if kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
			echo "[agenv] Started on $(HOST):$(PORT) (PID $$(cat $(PIDFILE)))"; \
		else \
			echo "[agenv] Failed to start — check .agenv.log"; \
			rm -f $(PIDFILE); \
			exit 1; \
		fi; \
	fi

stop: ## Stop the server gracefully
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "[agenv] Stopping PID $$(cat $(PIDFILE))..."; \
		kill $$(cat $(PIDFILE)) 2>/dev/null; \
		sleep 1; \
		kill -0 $$(cat $(PIDFILE)) 2>/dev/null && kill -9 $$(cat $(PIDFILE)) 2>/dev/null; \
		rm -f $(PIDFILE); \
		echo "[agenv] Stopped"; \
	else \
		echo "[agenv] Not running"; \
		rm -f $(PIDFILE); \
	fi

restart: stop start ## Stop then start

destroy: ## Force kill ALL agenv node processes on PORT
	@echo "[agenv] Force killing everything on port $(PORT)..."
	@-netstat -ano 2>/dev/null | grep ":$(PORT)" | grep LISTENING | awk '{print $$5}' | sort -u | while read pid; do \
		[ -n "$$pid" ] && [ "$$pid" != "0" ] && taskkill //F //PID $$pid 2>/dev/null && echo "[agenv] Killed PID $$pid"; \
	done
	@rm -f $(PIDFILE)
	@echo "[agenv] Destroyed"

watch: ## Start with auto-reload on file changes
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "[agenv] Stopping existing server first..."; \
		kill $$(cat $(PIDFILE)) 2>/dev/null; \
		sleep 1; \
		rm -f $(PIDFILE); \
	fi
	nodemon \
		--watch server.js \
		--watch public/ \
		--ext js,html,css \
		--delay 500ms \
		--signal SIGTERM \
		-- server.js --port $(PORT) --host $(HOST) $(FLAGS)

status: ## Check if server is running
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "[agenv] Running (PID $$(cat $(PIDFILE)), port $(PORT))"; \
	else \
		rm -f $(PIDFILE) 2>/dev/null; \
		echo "[agenv] Not running"; \
	fi

logs: ## Tail the server log
	@if [ -f .agenv.log ]; then \
		tail -f .agenv.log; \
	else \
		echo "[agenv] No log file found"; \
	fi
