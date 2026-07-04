#!/bin/bash
# amber-focus uninstaller — removes services, hosts entries, and pf rules.

echo "=== amber-focus uninstaller ==="

# Stop and remove server
echo "Removing server..."
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.amberfocus.server.plist 2>/dev/null || true
# Also try old plist name for backwards compatibility
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.welf.amberfocus.server.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.amberfocus.server.plist
rm -f ~/Library/LaunchAgents/com.welf.amberfocus.server.plist
echo "Server removed."

# Stop and remove daemon (requires sudo)
echo "Removing daemon (requires sudo)..."
sudo launchctl bootout system /Library/LaunchDaemons/com.amberfocus.daemon.plist 2>/dev/null || true
sudo launchctl bootout system /Library/LaunchDaemons/com.welf.amberfocus.daemon.plist 2>/dev/null || true
sudo rm -f /Library/LaunchDaemons/com.amberfocus.daemon.plist
sudo rm -f /Library/LaunchDaemons/com.welf.amberfocus.daemon.plist
echo "Daemon removed."

# Clean hosts file
echo "Cleaning /etc/hosts..."
sudo sed -i '' '/# BEGIN AMBER FOCUS/,/# END AMBER FOCUS/d' /etc/hosts
echo "Hosts cleaned."

# Clean pf rules
echo "Cleaning pf rules..."
sudo rm -f /etc/pf.anchors/com.welf.amberfocus
# Remove anchor lines from pf.conf
if grep -q "com.welf.amberfocus" /etc/pf.conf 2>/dev/null; then
    sudo sed -i '' '/com\.welf\.amberfocus/d' /etc/pf.conf
    sudo sed -i '' '/# amber-focus blocking anchor/d' /etc/pf.conf
    sudo pfctl -f /etc/pf.conf 2>/dev/null || true
    echo "pf rules removed."
else
    echo "No pf rules found."
fi

# Flush DNS
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder 2>/dev/null || true
echo "DNS cache flushed."

# Config
echo ""
read -p "Remove config (~/.config/amber-focus)? [y/N] " REMOVE_CONFIG
if [ "$REMOVE_CONFIG" = "y" ] || [ "$REMOVE_CONFIG" = "Y" ]; then
    rm -rf ~/.config/amber-focus
    echo "Config removed."
else
    echo "Config preserved at: ~/.config/amber-focus/"
fi

echo ""
echo "=== Uninstall complete ==="
