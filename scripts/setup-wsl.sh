#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID == 0 ]] || { echo 'WSL setup requires root.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
case "${1:-}" in
    prepare)
        # The Windows installer imports an isolated Ubuntu root filesystem.
        # Configure it before installing packages that may start services.
        printf '[boot]\nsystemd=true\n\n[network]\ngenerateHosts=false\n' > /etc/wsl.conf
        apt-get update
        apt-get -o Dpkg::Options::=--force-confold upgrade -y
        apt-get install -y --no-install-recommends systemd systemd-sysv python3
        ;;
    install)
        source_dir=$2
        domain=$3
        mode=$4
        [[ -d /run/systemd/system ]] || { echo 'WSL systemd did not start.' >&2; exit 1; }
        # Refresh startup helpers when retrying an earlier Windows installation.
        install -d -m 0755 /opt/dama/source
        for name in src public scripts test deploy package.json package-lock.json tsconfig.json tsconfig.base.json tsconfig.browser.json; do
            rm -rf -- "/opt/dama/source/$name"
            cp -R -- "$source_dir/$name" /opt/dama/source/
        done
        if [[ -d "$source_dir/prebuilt" ]]; then
            rm -rf -- /opt/dama/source/prebuilt
            cp -R -- "$source_dir/prebuilt" /opt/dama/source/
            build=(--prebuilt /opt/dama/source/prebuilt)
        else
            build=()
        fi
        if [[ -f /var/lib/dama/windows-install.complete ]]; then
            systemctl start docker.service dama.service nginx.service dama-worker.service
            curl -fsS --retry 10 --retry-delay 1 --retry-connrefused --max-time 5 http://127.0.0.1:3100/api/health
            exit
        fi
        case "$mode" in
            certificate)
                certificate_dir=$5
                install -d -m 0700 /etc/ssl/dama
                install -m 0644 "$certificate_dir/fullchain.pem" /etc/ssl/dama/fullchain.pem
                install -m 0600 "$certificate_dir/privkey.pem" /etc/ssl/dama/privkey.pem
                arguments=(--cert-dir /etc/ssl/dama)
                ;;
            route53)
                email=$5
                credentials=$6
                install -d -m 0700 /root/.aws
                install -m 0600 "$credentials" /root/.aws/credentials
                arguments=(--route53 "$email" --accept-acme-terms)
                ;;
            *) echo 'Unknown WSL certificate mode.' >&2; exit 1 ;;
        esac
        bash /opt/dama/source/scripts/install-linux-vm.sh --domain "$domain" "${build[@]}" "${arguments[@]}"
        touch /var/lib/dama/windows-install.complete
        ;;
    *) echo 'Usage: setup-wsl.sh prepare | install SOURCE DOMAIN certificate DIR | install SOURCE DOMAIN route53 EMAIL CREDENTIALS' >&2; exit 1 ;;
esac
