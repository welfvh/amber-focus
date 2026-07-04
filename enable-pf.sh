#!/bin/bash
# Enable pf (packet filter) blocking for amber-focus
# This provides IP-level blocking as a backup layer when DNS blocking is bypassed.
# Run with: sudo ./enable-pf.sh

PF_ANCHOR="/etc/pf.anchors/com.welf.amberfocus"

echo "# amber-focus pf rules - generated $(date)" > "$PF_ANCHOR"
echo "# Block outgoing connections to blocked service IPs" >> "$PF_ANCHOR"

cat >> "$PF_ANCHOR" << 'RULES'
# Twitter/X Corp (AS13414)
block drop out quick proto tcp to 104.244.42.0/24
block drop out quick proto tcp to 104.244.43.0/24
block drop out quick proto tcp to 104.244.44.0/24
block drop out quick proto tcp to 104.244.45.0/24
block drop out quick proto tcp to 104.244.46.0/24
block drop out quick proto tcp to 69.195.160.0/24
block drop out quick proto tcp to 192.133.77.0/24

# Meta/Facebook/Instagram (AS32934)
block drop out quick proto tcp to 157.240.0.0/16
block drop out quick proto tcp to 31.13.0.0/16
# Meta new ranges (2024+)
block drop out quick proto tcp to 57.141.0.0/16
block drop out quick proto tcp to 57.142.0.0/16
block drop out quick proto tcp to 57.143.0.0/16
block drop out quick proto tcp to 57.144.0.0/16
block drop out quick proto tcp to 57.145.0.0/16
block drop out quick proto tcp to 57.146.0.0/16
block drop out quick proto tcp to 57.147.0.0/16
block drop out quick proto tcp to 57.148.0.0/16
block drop out quick proto tcp to 57.149.0.0/16
block drop out quick proto tcp to 179.60.192.0/22
block drop out quick proto tcp to 185.60.216.0/22
block drop out quick proto tcp to 66.220.144.0/20
block drop out quick proto tcp to 69.63.176.0/20
block drop out quick proto tcp to 69.171.224.0/19
block drop out quick proto tcp to 74.119.76.0/22
block drop out quick proto tcp to 102.132.96.0/20
block drop out quick proto tcp to 103.4.96.0/22
block drop out quick proto tcp to 129.134.0.0/16
block drop out quick proto tcp to 147.75.208.0/20
block drop out quick proto tcp to 173.252.64.0/18
block drop out quick proto tcp to 204.15.20.0/22

# TikTok (ByteDance - partial)
block drop out quick proto tcp to 161.117.0.0/16
block drop out quick proto tcp to 162.62.0.0/16

# Netflix (AS2906) - primary ranges
block drop out quick proto tcp to 23.246.0.0/18
block drop out quick proto tcp to 37.77.184.0/21
block drop out quick proto tcp to 45.57.0.0/17
block drop out quick proto tcp to 64.120.128.0/17
block drop out quick proto tcp to 66.197.128.0/17
block drop out quick proto tcp to 108.175.32.0/20
block drop out quick proto tcp to 185.2.220.0/22
block drop out quick proto tcp to 185.9.188.0/22
block drop out quick proto tcp to 192.173.64.0/18
block drop out quick proto tcp to 198.38.96.0/19
block drop out quick proto tcp to 198.45.48.0/20
block drop out quick proto tcp to 208.75.76.0/22
RULES

# Check if anchor is referenced in main pf.conf
if ! grep -q "com.welf.amberfocus" /etc/pf.conf; then
    echo "" >> /etc/pf.conf
    echo "# amber-focus blocking anchor" >> /etc/pf.conf
    echo 'anchor "com.welf.amberfocus"' >> /etc/pf.conf
    echo 'load anchor "com.welf.amberfocus" from "/etc/pf.anchors/com.welf.amberfocus"' >> /etc/pf.conf
    echo "Added anchor to /etc/pf.conf"
fi

# Enable and load pf
pfctl -e 2>/dev/null
pfctl -f /etc/pf.conf
echo "pf blocking enabled with $(grep -c 'block drop' "$PF_ANCHOR") rules"
