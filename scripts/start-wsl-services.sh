#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == --check ]]; then
    systemctl is-active --quiet docker.service dama.service nginx.service dama-worker.service
    invocation=$(systemctl show -p InvocationID --value dama-worker.service)
    [[ -n "$invocation" && "$invocation" != 00000000000000000000000000000000 ]]
    journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$invocation" | grep -F '기존 배포 확인 완료' >/dev/null
    curl -fsS --max-time 5 http://127.0.0.1:3100/api/health >/dev/null
    [[ "$(curl -fsS --max-time 10 --resolve apps.objlabs.team:443:127.0.0.1 https://apps.objlabs.team/_dama/ready)" == dama-nginx-ready ]]
    exit
fi
# WSL can start before Windows finishes initializing networking and services.
for ((attempt=0; attempt<60; attempt++)); do
    if [[ -d /run/systemd/system ]] && systemctl start docker.service; then
        break
    fi
    sleep 2
done
systemctl start dama.service
systemctl start nginx.service
systemctl start dama-worker.service
exec sleep infinity
