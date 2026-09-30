#!/bin/sh
set -eu

certificate="/etc/letsencrypt/live/suomirap-proxy-ip/fullchain.pem"
before="0"
if [ -f "$certificate" ]; then
  before=$(stat -c '%Y' "$certificate")
fi

/usr/bin/docker run --rm --network host \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  -v /var/log/letsencrypt:/var/log/letsencrypt \
  certbot/certbot:v5.4.0 renew --quiet

after=$(stat -c '%Y' "$certificate")
if [ "$after" -gt "$before" ]; then
  /usr/bin/systemctl restart suomirap-stream-proxy.service
fi
