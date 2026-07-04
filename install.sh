#!/bin/bash
# amber-focus installer — one-line install for macOS distraction blocking.
# Usage: curl -fsSL amber.computer/focus/install | bash
#
# What it does:
#   1. Checks prerequisites (macOS, Xcode CLT, Node.js 18+, Claude Code)
#   2. Clones the repo to ~/dev/amber-focus (or pulls if it exists)
#   3. Builds the server (npm install + tsc)
#   4. Builds the native onboarding app (swiftc)
#   5. Launches the onboarding wizard
#      → The wizard handles: daemon install, server install, pf firewall,
#        MCP connection, skill install, and launches your first Claude session.

set -euo pipefail

# --- Colors ---
AMBER='\033[0;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "${AMBER}▸${RESET} $1"; }
ok()    { echo -e "${GREEN}✓${RESET} $1"; }
fail()  { echo -e "${RED}✗${RESET} $1"; exit 1; }
dim()   { echo -e "${DIM}  $1${RESET}"; }

INSTALL_DIR="$HOME/dev/amber-focus"

echo ""
echo -e "${AMBER}  ▓▓▓▓▓▓${RESET}"
echo -e "${AMBER}▓▓      ▓▓${RESET}"
echo -e "${AMBER}▓▓  ░░░░  ▓▓${RESET}"
echo -e "${AMBER}▓▓  ░░░░  ▓▓${RESET}"
echo -e "${AMBER}  ▓▓      ▓▓${RESET}"
echo -e "${AMBER}    ▓▓▓▓▓▓${RESET}"
echo ""
echo -e "${BOLD}amber focus${RESET} — the distracting internet is off."
echo ""

# --- 0. macOS check ---
if [[ "$(uname)" != "Darwin" ]]; then
    fail "amber-focus requires macOS. Detected: $(uname)"
fi
ok "macOS detected"

# --- 1. Xcode Command Line Tools ---
if ! xcode-select -p &>/dev/null; then
    info "Installing Xcode Command Line Tools (required for Swift compiler)..."
    xcode-select --install
    echo ""
    echo "A system dialog should appear. After installation completes, re-run this script:"
    echo "  curl -fsSL amber.computer/install | bash"
    exit 0
fi
ok "Xcode Command Line Tools"

# --- 2. Node.js 18+ ---
NODE_PATH="$(which node 2>/dev/null || true)"
if [[ -z "$NODE_PATH" ]]; then
    fail "Node.js not found. Install it first: brew install node"
fi
NODE_VERSION="$($NODE_PATH --version | sed 's/v//' | cut -d. -f1)"
if [[ "$NODE_VERSION" -lt 18 ]]; then
    fail "Node.js 18+ required (found v$($NODE_PATH --version | sed 's/v//')). Run: brew install node"
fi
ok "Node.js v$($NODE_PATH --version | sed 's/v//') at $NODE_PATH"

# --- 3. Claude Code (warn, not fatal) ---
CLAUDE_PATH="$(which claude 2>/dev/null || true)"
if [[ -z "$CLAUDE_PATH" ]]; then
    info "Claude Code not found — you'll need it after setup."
    dim "Install: npm install -g @anthropic-ai/claude-code"
    echo ""
else
    ok "Claude Code at $CLAUDE_PATH"
fi

# --- 4. Clone or update repo ---
if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Updating existing installation at $INSTALL_DIR..."
    cd "$INSTALL_DIR"
    git pull --quiet origin main
    ok "Updated to latest"
else
    info "Cloning amber-focus to $INSTALL_DIR..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --quiet https://github.com/welfvh/amber-focus.git "$INSTALL_DIR"
    ok "Cloned to $INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- 5. Build server ---
info "Installing dependencies..."
npm install --silent 2>&1
ok "Dependencies installed"

info "Building server..."
npx tsc 2>&1
ok "Server built"

# --- 6. Build onboarding app ---
info "Building onboarding app..."
cd "$INSTALL_DIR/app"
make --quiet 2>&1
ok "Onboarding app built"

# --- 7. Install CLI symlink ---
if [[ ! -L /usr/local/bin/amber-focus ]]; then
    info "Installing amber-focus CLI to /usr/local/bin..."
    if [[ -w /usr/local/bin ]]; then
        ln -sf "$INSTALL_DIR/bin/amber-focus" /usr/local/bin/amber-focus
        ok "CLI installed: amber-focus"
    else
        dim "Needs sudo for /usr/local/bin symlink"
        sudo ln -sf "$INSTALL_DIR/bin/amber-focus" /usr/local/bin/amber-focus
        ok "CLI installed: amber-focus"
    fi
else
    ok "CLI already installed"
fi

# --- 8. Launch onboarding ---
echo ""
echo -e "${BOLD}${AMBER}Ready.${RESET}"
echo ""
echo "The onboarding wizard will now open. It will:"
echo "  1. Ask what pulls you in (your triggers)"
echo "  2. Let you choose block categories"
echo "  3. Install the daemon, server, and firewall"
echo "  4. Connect Claude Code and launch your first session"
echo ""
info "Launching onboarding wizard..."
echo ""

# Launch the GUI app — it handles everything from here
"$INSTALL_DIR/app/amber-focus"
