#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
    cat <<'HELP'
Usage: sudo bash scripts/install-linux-vm.sh [options]

Install Dama on a Debian or Ubuntu systemd VM.
  --domain HOST         Public deployment hostname. Prompted if omitted.
  --cert-dir PATH       Use fullchain.pem and privkey.pem from PATH
                        (default /etc/letsencrypt/live/HOST).
  --prebuilt DIR        Install a packaged Dama build from DIR.
  --route53 EMAIL       Issue the domain certificate if needed, then
                        enable daily renewal. Requires root Route 53 credentials.
  --certbot-renewal     Enable daily renewal for an existing Certbot certificate.
  --accept-acme-terms   Accept ACME terms and issue without interactive prompts.
  --nginx-admin-only    Register Nginx management on an existing Dama VM.
  --help                Show these instructions.
HELP
}

fail() { printf 'Dama installer: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[Dama] %s\n' "$*"; }

cert_dir=
prebuilt=
host=
route53_email=
renew=false
nginx_admin_only=false
acme_arguments=()
while (($#)); do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --domain)
            (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail '--domain requires a hostname.'
            host=$2
            shift 2
            ;;
        --cert-dir)
            (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail '--cert-dir requires an absolute directory.'
            cert_dir=${2%/}
            shift 2
            ;;
        --prebuilt)
            (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail '--prebuilt requires a directory.'
            prebuilt=$2
            shift 2
            ;;
        --route53)
            (($# >= 2)) && [[ "$2" == *@* && "$2" != --* ]] || fail '--route53 requires an email address.'
            route53_email=$2
            renew=true
            shift 2
            ;;
        --certbot-renewal) renew=true; shift ;;
        --nginx-admin-only) nginx_admin_only=true; shift ;;
        --accept-acme-terms) acme_arguments=(--agree-tos --non-interactive); shift ;;
        *) fail "Unknown option $1. See --help." ;;
    esac
done

[[ "$(uname -s)" == Linux && -d /run/systemd/system ]] || fail 'Run this inside the Debian/Ubuntu systemd VM.'
[[ $EUID == 0 ]] || fail 'Run with sudo. The installer registers system services.'
. /etc/os-release
[[ "$ID" == debian || "$ID" == ubuntu ]] || fail 'Supported distributions are Debian and Ubuntu.'

if "$nginx_admin_only" && [[ -r /etc/dama/dama.env ]]; then
    active_host=$(sed -n -E 's/^DAMA_DEPLOYMENT_DOMAIN=([A-Za-z0-9.-]+)$/\1/p' /etc/dama/dama.env)
    if [[ -z "$active_host" ]]; then
        active_host=$(sed -n -E 's!^DAMA_NGINX_PROBE=https://([A-Za-z0-9.-]+)/?$!\1!p' /etc/dama/dama.env)
    fi
    if [[ -n "$host" && -n "$active_host" && "${host,,}" != "${active_host,,}" ]]; then
        fail 'The supplied domain differs from the installed Nginx deployment domain.'
    fi
    host=${host:-$active_host}
    if [[ -z "$cert_dir" && -r /etc/nginx/conf.d/dama-apps.conf ]]; then
        cert_dir=$(sed -n -E 's!^[[:space:]]*ssl_certificate[[:space:]]+(/[^; ]+)/fullchain\.pem;[[:space:]]*$!\1!p' /etc/nginx/conf.d/dama-apps.conf | head -n 1)
    fi
fi
if [[ -z "$host" ]]; then
    [[ -t 0 ]] || fail 'Specify --domain HOST for noninteractive installation.'
    read -r -p 'Deployment domain (example: apps.example.com): ' host
fi
host=${host,,}
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
[[ ${#host} -le 253 && $host =~ ^($label\.)+$label$ && ! $host =~ ^[0-9.]+$ ]] || fail 'Enter a DNS hostname without a scheme, port, or path.'
cert_dir=${cert_dir:-/etc/letsencrypt/live/$host}
[[ "$cert_dir" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail 'Use an absolute certificate directory without spaces.'
if [[ -n "$route53_email" && "$cert_dir" != "/etc/letsencrypt/live/$host" ]]; then
    fail "--route53 uses /etc/letsencrypt/live/$host."
fi
if "$renew"; then
    [[ "$cert_dir" =~ ^/etc/letsencrypt/live/[A-Za-z0-9._-]+$ ]] || fail 'Renewal requires a Certbot live certificate directory.'
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
templates="$source_dir/deploy/systemd"
[[ -f "$source_dir/package-lock.json" && -f "$templates/dama-site.conf.example" ]] || fail 'Run from the complete Dama source tree.'

install_config() {
    local mode=$1 source=$2 destination=$3
    if [[ -e "$destination" || -L "$destination" ]]; then
        [[ -f "$destination" && ! -L "$destination" ]] && cmp -s "$source" "$destination" ||
            fail "Existing configuration differs: $destination"
        return
    fi
    install -m "$mode" -- "$source" "$destination"
}

install_nginx_admin() {
    install -d -m 0755 -o dama -g dama /etc/nginx/dama-sites
    install -d -m 0755 /etc/dama/nginx-default
    for file in fullchain.pem privkey.pem; do
        link="/etc/dama/nginx-default/$file"
        if [[ ! -e "$link" && ! -L "$link" ]]; then ln -s "$cert_dir/$file" "$link"; fi
    done
    if [[ ! -e /etc/nginx/dama-sites/active.conf ]]; then
        install -o dama -g dama -m 0644 /dev/null /etc/nginx/dama-sites/active.conf
    fi
    install_config 0644 "$templates/dama-managed-sites.conf" /etc/nginx/conf.d/dama-managed-sites.conf
    install_config 0644 "$templates/dama-managed-check.conf" /etc/dama/nginx-candidate.conf
    install_config 0755 "$templates/nginx-admin" /usr/local/libexec/dama/nginx-admin
    install_config 0755 "$source_dir/deploy/nginx/private-cert" /usr/local/libexec/dama/private-cert
    visudo -cf "$templates/dama-nginx-admin.sudoers"
    install_config 0440 "$templates/dama-nginx-admin.sudoers" /etc/sudoers.d/dama-nginx-admin
}

enable_certbot_schedule() {
    install -d -m 0755 /etc/systemd/system/certbot.timer.d /etc/letsencrypt/renewal-hooks/deploy
    install_config 0644 "$templates/certbot-daily.conf" /etc/systemd/system/certbot.timer.d/90-dama-daily.conf
    install_config 0755 "$templates/reload-nginx-after-renewal.sh" /etc/letsencrypt/renewal-hooks/deploy/90-dama-reload-nginx
    systemctl daemon-reload
    systemctl enable --now certbot.timer
}

if "$nginx_admin_only"; then
    id dama >/dev/null 2>&1 || fail 'Install Dama on this VM first.'
    [[ -r "$cert_dir/fullchain.pem" && -r "$cert_dir/privkey.pem" ]] || fail "Missing certificate or key in $cert_dir."
    if ! command -v certbot >/dev/null; then
        apt-get update
        apt-get install -y --no-install-recommends certbot
    fi
    exec 9>/run/dama-install.lock
    flock --nonblock 9 || fail 'Another Dama installation is running.'
    install_nginx_admin
    /usr/local/libexec/dama/nginx-admin test
    enable_certbot_schedule
    if systemctl is-active --quiet nginx.service; then
        /usr/local/libexec/dama/nginx-admin reload
    fi
    exit 0
fi

node_version=26.13.1
case "$(uname -m)" in
    x86_64)
        node_arch=x64
        node_hash=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864
        ;;
    aarch64)
        node_arch=arm64
        node_hash=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd
        ;;
    *) fail 'Supported VM architectures are x86_64 and arm64.' ;;
esac
node_root="/opt/dama/runtime/node-v$node_version"
site=/etc/nginx/conf.d/dama-apps.conf
hosts_line="127.0.0.1 $host # Dama installer"

packages=()
command -v docker >/dev/null || packages+=(docker.io)
[[ -x /usr/sbin/nginx ]] || packages+=(nginx)
command -v git >/dev/null || packages+=(git)
command -v curl >/dev/null || packages+=(curl)
command -v xz >/dev/null || packages+=(xz-utils)
command -v sudo >/dev/null || packages+=(sudo)
command -v flock >/dev/null || packages+=(util-linux)
command -v openssl >/dev/null || packages+=(openssl)
for package in ca-certificates libatomic1; do
    if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)" != installed ]]; then
        packages+=("$package")
    fi
done
command -v certbot >/dev/null || packages+=(certbot)
if [[ -n "$route53_email" ]] && [[ "$(dpkg-query -W -f='${db:Status-Status}' python3-certbot-dns-route53 2>/dev/null || true)" != installed ]]; then
    packages+=(python3-certbot-dns-route53)
fi
if (("${#packages[@]}")); then
    log 'Install missing VM packages'
    apt-get update
    apt-get install -y --no-install-recommends "${packages[@]}"
fi

exec 9>/run/dama-install.lock
flock --nonblock 9 || fail 'Another Dama installation is running.'
for service in dama.service dama-worker.service; do
    if systemctl is-active --quiet "$service"; then
        fail "$service is already running. This installer is for initial setup."
    fi
done
if "$renew"; then
    systemctl cat certbot.timer >/dev/null
fi

scratch=$(mktemp -d /tmp/dama-install.XXXXXX)
site_added=false
hosts_added=false
start_attempted=false
complete=false
cleanup() {
    local result=$?
    if ! "$complete"; then
        if "$start_attempted"; then
            systemctl stop dama-worker.service dama.service || true
        fi
        if "$hosts_added"; then
            awk -v line="$hosts_line" '$0 != line' /etc/hosts > "$scratch/hosts"
            cat "$scratch/hosts" > /etc/hosts || true
        fi
        if "$site_added"; then
            rm -f -- "$site"
            if systemctl is-active --quiet nginx.service && /usr/sbin/nginx -t; then
                systemctl reload nginx.service || true
            fi
        fi
    fi
    rm -rf -- "$scratch"
    return "$result"
}
trap cleanup EXIT

log "Prepare Node.js $node_version and verify the build"
install -d -m 0755 /opt/dama/runtime /opt/dama/releases
if [[ ! -x "$node_root/bin/node" ]]; then
    archive="node-v$node_version-linux-$node_arch.tar.xz"
    curl -fsSL --retry 2 "https://nodejs.org/dist/v$node_version/$archive" -o "$scratch/$archive"
    checksum=$(sha256sum -- "$scratch/$archive")
    [[ "${checksum%% *}" == "$node_hash" ]] || fail "Checksum mismatch for $archive."
    mkdir "$scratch/node"
    tar -xJf "$scratch/$archive" -C "$scratch/node" --strip-components=1
    [[ ! -e "$node_root" ]] || fail "Incomplete runtime at $node_root."
    mv -T -- "$scratch/node" "$node_root"
fi
[[ "$("$node_root/bin/node" --version)" == "v$node_version" ]] || fail 'Installed Node version differs.'
if ! id dama >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/dama --shell /usr/sbin/nologin dama
fi

chmod 0755 "$scratch"
mkdir "$scratch/build"
if [[ -n "$prebuilt" ]]; then
    [[ -f "$prebuilt/src/server.js" && -f "$prebuilt/src/run-deployments.js" && -f "$prebuilt/public/app.js" ]] ||
        fail 'The packaged Dama build is incomplete.'
    cp -R -- "$prebuilt" "$scratch/build/dist"
    cp -- "$source_dir/package.json" "$scratch/build/"
    "$node_root/bin/node" --check "$scratch/build/dist/src/server.js"
else
    cp -R -- "$source_dir/src" "$source_dir/public" "$source_dir/scripts" "$source_dir/test" "$scratch/build/"
    cp -- "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir"/tsconfig*.json "$scratch/build/"
    chown -R dama:dama "$scratch/build"
    runuser -u dama -- env HOME="$scratch/build" PATH="$node_root/bin:/usr/bin:/bin" bash -c '
        cd "$1" && npm ci --ignore-scripts && npm test
    ' bash "$scratch/build"
fi

log 'Check Nginx ownership and certificate'
/usr/sbin/nginx -T > "$scratch/nginx-config"
if [[ ! -e "$site" ]] &&
    awk -v host="$host" 'BEGIN { RS=";" } {
        for (i=1; i<NF; i++) if ($i=="server_name")
            for (j=i+1; j<=NF; j++) if (tolower($j)==host) found=1
    } END { exit !found }' "$scratch/nginx-config"; then
    fail "An existing Nginx server already owns $host. Use the guide to connect it."
fi
if [[ -n "$route53_email" && ( ! -s "$cert_dir/fullchain.pem" || ! -s "$cert_dir/privkey.pem" ) ]]; then
    certbot certonly --dns-route53 --cert-name "$host" --email "$route53_email" -d "$host" "${acme_arguments[@]}"
fi
[[ -s "$cert_dir/fullchain.pem" && -s "$cert_dir/privkey.pem" ]] || fail "Certificate and key required in $cert_dir. See --route53."
openssl x509 -in "$cert_dir/fullchain.pem" -noout -checkend 0
match=$(openssl x509 -in "$cert_dir/fullchain.pem" -noout -checkhost "$host")
[[ "$match" == *' does match certificate' ]] || fail "The certificate does not cover $host."

log 'Register Dama and verify service configuration'
install -d -m 0755 /etc/dama /usr/local/libexec/dama /etc/systemd/system/nginx.service.d /var/www/dama-acme
install -d -o dama -g dama -m 0755 /etc/nginx/dama
if [[ ! -e /etc/nginx/dama/routes.conf ]]; then
    install -o dama -g dama -m 0644 /dev/null /etc/nginx/dama/routes.conf
fi
runuser -u dama -- test -w /etc/nginx/dama/routes.conf
cat "$templates/dama.env.example" > "$scratch/dama.env"
printf 'DAMA_DEPLOYMENT_DOMAIN=%s\nDAMA_NGINX_PROBE=https://%s\n' "$host" "$host" >> "$scratch/dama.env"
install_config 0644 "$scratch/dama.env" /etc/dama/dama.env
install_config 0755 "$templates/nginx" /usr/local/libexec/dama/nginx
visudo -cf "$templates/dama-nginx.sudoers"
install_config 0440 "$templates/dama-nginx.sudoers" /etc/sudoers.d/dama-nginx
install_nginx_admin
install_config 0644 "$templates/nginx-after-dama.conf" /etc/systemd/system/nginx.service.d/after-dama.conf

release=$(mktemp -d /opt/dama/releases/release.XXXXXX)
chmod 0755 "$release"
cp -R -- "$scratch/build/dist" "$scratch/build/package.json" "$release/"
chown -R root:root "$release"
install -d -m 0755 "$release/deploy/database"
for template in compose.yaml compose.host.yaml compose.shared.yaml; do
    install -m 0644 "$source_dir/deploy/database/$template" "$release/deploy/database/$template"
done
install -D -m 0644 "$source_dir/deploy/forgejo/compose.yaml" "$release/deploy/forgejo/compose.yaml"
chmod -R go-w "$release"
for unit in dama.service dama-worker.service; do
    sed -e 's|/opt/dama|/opt/dama/current|g' -e "s|/usr/bin/node|$node_root/bin/node|g" "$templates/$unit" > "$scratch/$unit"
    install_config 0644 "$scratch/$unit" "/etc/systemd/system/$unit"
done
if [[ -e /opt/dama/current && ! -L /opt/dama/current ]]; then fail '/opt/dama/current must be a symlink.'; fi
ln -s "$release" "$release/current-next"
mv -Tf "$release/current-next" /opt/dama/current

sed -e "s|@DOMAIN@|$host|g" -e "s|@CERTIFICATE@|$cert_dir/fullchain.pem|" -e "s|@PRIVATE_KEY@|$cert_dir/privkey.pem|" \
    "$templates/dama-site.conf.example" > "$scratch/dama-apps.conf"
[[ -e "$site" || -L "$site" ]] || site_added=true
install_config 0644 "$scratch/dama-apps.conf" "$site"
/usr/sbin/nginx -t
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/dama.service /etc/systemd/system/dama-worker.service
runuser -u dama -- "$node_root/bin/node" --experimental-sqlite -e 'new (require("node:sqlite").DatabaseSync)(":memory:").close()'
systemctl start docker.service
runuser -u dama -g docker -- docker info --format '{{.ServerVersion}}'
runuser -u dama -- /usr/local/libexec/dama/nginx -c /etc/nginx/nginx.conf -t

log 'Start Dama and confirm HTTPS and worker readiness'
start_attempted=true
systemctl start dama.service nginx.service
systemctl reload nginx.service
[[ "$(curl -fsS --retry 8 --retry-delay 1 --retry-connrefused --max-time 5 http://127.0.0.1:3100/api/health)" == '{"ok":true,"mode":"local-development"}' ]] &&
    systemctl is-active --quiet dama.service || fail 'The Dama dashboard did not pass its health check.'
[[ "$(curl -fsS --retry 8 --retry-delay 1 --retry-connrefused --max-time 5 --resolve "$host:443:127.0.0.1" "https://$host/_dama/ready")" == dama-nginx-ready ]] ||
    fail 'The Dama HTTPS host did not return its readiness response.'
if ! getent ahostsv4 "$host" | awk 'NR == 1 { local_address = ($1 == "127.0.0.1") } END { exit !local_address }'; then
    if awk -v host="$host" '{ sub(/#.*/, ""); for (i=2; i<=NF; i++) if ($i == host) found=1 } END { exit !found }' /etc/hosts; then
        fail "Resolve the existing /etc/hosts entry for $host before installing."
    fi
    printf '\n%s\n' "$hosts_line" >> /etc/hosts
    hosts_added=true
fi
systemctl start dama-worker.service
worker_ready=false
for ((attempt=0; attempt<60; attempt++)); do
    invocation=$(systemctl show -p InvocationID --value dama-worker.service)
    if [[ -n "$invocation" && "$invocation" != 00000000000000000000000000000000 ]] &&
        journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$invocation" | grep -F '기존 배포 확인 완료' >/dev/null; then
        worker_ready=true
        break
    fi
    sleep 1
done
"$worker_ready" || fail 'Worker is not ready. See journalctl -u dama-worker.service.'

if "$renew"; then
    log 'Verify existing Certbot renewal'
    certbot renew --cert-name "${cert_dir##*/}" --dry-run
fi
enable_certbot_schedule

systemctl enable docker.service dama.service nginx.service dama-worker.service
complete=true
printf '\nDashboard: http://127.0.0.1:3100\nDeployment host: https://%s\n' "$host"
if "$renew"; then systemctl list-timers --all certbot.timer; fi
