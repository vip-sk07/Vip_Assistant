#!/bin/bash

# ==========================================================================
# VIP Assistant Systemd User Service Setup Script
# ==========================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}===========================================================${NC}"
echo -e "${GREEN}      Setting up Permanent background service...          ${NC}"
echo -e "${CYAN}===========================================================${NC}"

# Find Node path
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo -e "${RED}Error: Node.js executable not found in PATH.${NC}"
    exit 1
fi

# Ensure user systemd config folder exists
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

# Create service file
SERVICE_FILE="$SYSTEMD_USER_DIR/vip-assistant.service"

echo -e "Generating systemd user service at: ${CYAN}$SERVICE_FILE${NC}"

cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=VIP Assistant Local AI Agent Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_PATH server.js
Restart=always
RestartSec=5
Environment=PATH=/usr/bin:/usr/local/bin:$PATH
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

# Reload systemd configuration
echo -e "Reloading systemd daemon..."
systemctl --user daemon-reload

# Enable service to run on boot
echo -e "Enabling VIP Assistant service..."
systemctl --user enable vip-assistant.service

# Start service
echo -e "Starting VIP Assistant service..."
systemctl --user start vip-assistant.service

echo -e "${GREEN}===========================================================${NC}"
echo -e "${GREEN}  VIP Assistant background service is ACTIVE and RUNNING!   ${NC}"
echo -e "${GREEN}  It will start automatically on boot.                     ${NC}"
echo -e "-----------------------------------------------------------"
echo -e "  To check status: ${CYAN}systemctl --user status vip-assistant.service${NC}"
echo -e "  To view logs:    ${CYAN}journalctl --user -u vip-assistant.service -f${NC}"
echo -e "  To stop service: ${CYAN}systemctl --user stop vip-assistant.service${NC}"
echo -e "  To start service: ${CYAN}systemctl --user start vip-assistant.service${NC}"
echo -e "  Server address:  ${YELLOW}http://localhost:3000${NC}"
echo -e "${GREEN}===========================================================${NC}"
