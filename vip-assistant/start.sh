#!/bin/bash

# ==========================================================================
# VIP Assistant Launcher Script
# ==========================================================================

# Exit immediately if a command exits with a non-zero status
set -e

# Project Directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}===========================================================${NC}"
echo -e "${GREEN}             Initializing VIP Assistant...                ${NC}"
echo -e "${CYAN}===========================================================${NC}"

# Check for node and npm
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed on this system.${NC}"
    echo -e "${YELLOW}Please install Node.js (v18+) to run VIP Assistant.${NC}"
    exit 1
fi

# Install dependencies if node_modules does not exist
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}node_modules not found. Installing dependencies...${NC}"
    npm install
    echo -e "${GREEN}Dependencies installed successfully!${NC}"
else
    echo -e "${GREEN}Dependencies already installed.${NC}"
fi

# Setup .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}.env file not found. Creating default config...${NC}"
    echo "# VIP Assistant Configuration" > .env
    echo "PORT=3000" >> .env
    echo "WORKSPACE_DIR=$PROJECT_DIR/.." >> .env
    echo "# Add your API keys here or input them in the UI settings panel" >> .env
    echo "GEMINI_API_KEY=" >> .env
    echo "ANTHROPIC_API_KEY=" >> .env
    echo -e "${GREEN}Created .env file.${NC}"
fi

# Print run instructions
echo -e "\n${GREEN}VIP Assistant is ready!${NC}"
echo -e "You can run it in two ways:"
echo -e "  1. ${CYAN}Interactive Mode:${NC} Run `./start.sh` (or `npm start` directly)"
echo -e "  2. ${CYAN}Background / Permanent Mode:${NC} Run the following command:"
echo -e "     ${YELLOW}nohup node server.js > assistant.log 2>&1 &${NC}"
echo -e "     (This runs it permanently in the background. Stop it anytime using: ${YELLOW}kill \$(lsof -t -i:3000)${NC})"
echo -e "-----------------------------------------------------------"

# Run server
echo -e "${GREEN}Starting VIP Assistant in foreground...${NC}"
npm start
