#!/usr/bin/env bash
# EC2 bootstrap script for Obsidian MCP Server
# Tested on: Amazon Linux 2023 / Ubuntu 22.04
# Run as ec2-user (not root): bash scripts/setup-ec2.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/YOUR_USERNAME/obsidian-mcp.git}"
VAULT_REPO="${VAULT_REPO:-git@github.com:YOUR_USERNAME/obsidian-vault.git}"
APP_DIR="$HOME/obsidian-mcp"
VAULT_DIR="$HOME/vault"
NODE_VERSION="20"

echo "==> [1/8] Install Node.js ${NODE_VERSION} via nvm"
if ! command -v node &>/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh"
  nvm install "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"
fi
echo "    Node: $(node --version), npm: $(npm --version)"

echo "==> [2/8] Clone vault (read-only deploy key must already be on this host)"
if [ ! -d "$VAULT_DIR/.git" ]; then
  git clone "$VAULT_REPO" "$VAULT_DIR"
else
  echo "    Vault already cloned at $VAULT_DIR — skipping"
fi

echo "==> [3/8] Clone obsidian-mcp server"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  echo "    Repo already cloned at $APP_DIR — pulling latest"
  git -C "$APP_DIR" pull --ff-only
fi

echo "==> [4/8] Install npm dependencies"
cd "$APP_DIR"
npm ci --omit=dev

echo "==> [5/8] Build TypeScript"
npm run build

echo "==> [6/8] Create .env from .env.example (edit before starting!)"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i "s|/home/ec2-user/vault|$VAULT_DIR|g" "$APP_DIR/.env"
  # Generate a random auth token
  TOKEN=$(openssl rand -hex 32)
  sed -i "s|change-me-to-a-strong-random-token|$TOKEN|g" "$APP_DIR/.env"
  sed -i "s|^TRANSPORT=.*|TRANSPORT=http|g" "$APP_DIR/.env"
  echo "    .env created. TOKEN saved. REMEMBER: edit VAULT_PATH if needed."
  echo "    Generated MCP_AUTH_TOKEN: $TOKEN"
else
  echo "    .env already exists — skipping"
fi

echo "==> [7/8] Install systemd units"
SYSTEMD_DIR="/etc/systemd/system"
sudo cp "$APP_DIR/systemd/obsidian-mcp.service"          "$SYSTEMD_DIR/"
sudo cp "$APP_DIR/systemd/obsidian-vault-sync.service"   "$SYSTEMD_DIR/"
sudo cp "$APP_DIR/systemd/obsidian-vault-sync.timer"     "$SYSTEMD_DIR/"
sudo systemctl daemon-reload
sudo systemctl enable obsidian-mcp
sudo systemctl enable obsidian-vault-sync.timer
sudo systemctl start  obsidian-vault-sync.timer

echo "==> [8/8] Start MCP server"
sudo systemctl start obsidian-mcp
sudo systemctl status obsidian-mcp --no-pager

echo ""
echo "════════════════════════════════════════════"
echo "  Obsidian MCP Server is running!"
echo ""
echo "  Next steps:"
echo "  1. Install nginx: sudo apt install nginx"
echo "  2. Copy nginx config:"
echo "     sudo cp $APP_DIR/nginx/obsidian-mcp.conf /etc/nginx/sites-available/"
echo "     sudo ln -s /etc/nginx/sites-available/obsidian-mcp.conf /etc/nginx/sites-enabled/"
echo "  3. Get TLS cert: sudo certbot --nginx -d mcp.yourdomain.com"
echo "  4. Edit /etc/nginx/sites-available/obsidian-mcp.conf → set your domain"
echo "  5. sudo systemctl reload nginx"
echo ""
echo "  Logs:  journalctl -u obsidian-mcp -f"
echo "  Sync:  journalctl -u obsidian-vault-sync -f"
echo "════════════════════════════════════════════"
