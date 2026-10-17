#!/bin/sh
# Prepare nginx from read-only deployment input, then replace this process with
# the requested command so container stop signals reach that command directly.
# Rendering or nginx validation failures stop startup under set -e; no generated
# example configuration is substituted when the private JSON is missing/invalid.
set -eu

# Configuration is immutable deployment input; generated files live outside /config.
# Other commands are passed through unchanged for explicit container inspection.
if [ "${1:-}" = "nginx" ] || [ "${1:-}" = "nginx-debug" ]; then
    python3 /opt/dobbelt-pi-hole/render_config.py \
        --config /config/config.json \
        --output-dir /run/dobbelt-pi-hole \
        --web-root /usr/share/nginx/html
    nginx -t
fi

# Keep nginx in the foreground through the Dockerfile's default arguments.
exec "$@"
