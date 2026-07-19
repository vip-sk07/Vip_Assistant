#!/bin/bash

# Wait a brief moment for display manager and desktop environment components to settle
sleep 4

# Start the VIP Assistant systemd user service
systemctl --user start vip-assistant.service

# Launch the browser interface in Chrome
google-chrome http://localhost:3000 &
