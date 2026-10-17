#!/bin/sh
set -eu

# Configuration is immutable deployment input; generated files live outside /config.
if [ "${1:-}" = "nginx" ] || [ "${1:-}" = "nginx-debug" ]; then
    python3 /opt/dobbelt-pi-hole/render_config.py \
        --config /config/config.json \
        --output-dir /run/dobbelt-pi-hole \
        --web-root /usr/share/nginx/html
    nginx -t
fi

exec "$@"
