#!/bin/sh
set -eu

INCLUDE_DIR=/etc/nginx/conf.d/includes
HTTP_INCLUDE="$INCLUDE_DIR/frontend-http.conf"
SSL_INCLUDE="$INCLUDE_DIR/frontend-ssl.conf"

mkdir -p "$INCLUDE_DIR"
: > "$HTTP_INCLUDE"
: > "$SSL_INCLUDE"

is_truthy() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

ssl_enabled=false
if is_truthy "${NGINX_SSL_ENABLED:-false}"; then
    ssl_enabled=true
fi

if is_truthy "${NGINX_HTTP_REDIRECT_TO_HTTPS:-false}"; then
    if [ "$ssl_enabled" != "true" ]; then
        echo >&2 "NGINX_HTTP_REDIRECT_TO_HTTPS=true requires NGINX_SSL_ENABLED=true."
        exit 1
    fi

    cat > "$HTTP_INCLUDE" <<'EOF'
    return 301 https://$host$request_uri;
EOF
fi

if [ "$ssl_enabled" != "true" ]; then
    exit 0
fi

certificate="${NGINX_SSL_CERTIFICATE:-/etc/nginx/ssl/fullchain.pem}"
certificate_key="${NGINX_SSL_CERTIFICATE_KEY:-/etc/nginx/ssl/privkey.pem}"

if [ ! -f "$certificate" ]; then
    echo >&2 "SSL certificate not found: $certificate"
    exit 1
fi

if [ ! -f "$certificate_key" ]; then
    echo >&2 "SSL certificate key not found: $certificate_key"
    exit 1
fi

server_name="${NGINX_SERVER_NAME:-_}"
ssl_protocols="${NGINX_SSL_PROTOCOLS:-TLSv1.2 TLSv1.3}"
ssl_ciphers="${NGINX_SSL_CIPHERS:-HIGH:!aNULL:!MD5}"
ssl_session_timeout="${NGINX_SSL_SESSION_TIMEOUT:-1d}"
hsts_header=""

if is_truthy "${NGINX_HSTS_ENABLED:-false}"; then
    hsts_max_age="${NGINX_HSTS_MAX_AGE:-15552000}"
    hsts_header="    add_header Strict-Transport-Security \"max-age=$hsts_max_age\" always;"
fi

cat > "$SSL_INCLUDE" <<EOF
server {
    listen 443 ssl;
    http2 on;
    server_name $server_name;

    ssl_certificate "$certificate";
    ssl_certificate_key "$certificate_key";
    ssl_protocols $ssl_protocols;
    ssl_ciphers $ssl_ciphers;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout $ssl_session_timeout;
    ssl_session_tickets off;
$hsts_header

    include /etc/nginx/conf.d/includes/frontend-locations.conf;
}
EOF
