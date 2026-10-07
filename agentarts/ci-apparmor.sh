#!/usr/bin/env bash
# A project-specific CI host profile. Never change docker-default, sysctl or daemon policy.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
profile=agentarts-runtime-bwrap-v1
output="${AGENTARTS_EVIDENCE_DIR:?Evidence directory is required}"
marker="$output/apparmor-profile-loaded"
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
mkdir -p -- "$output"
if [[ "${1:-}" == cleanup ]]; then
  if [[ -f "$marker" ]]; then
    sudo --non-interactive apparmor_parser -R "$repo_root/agentarts/apparmor-runtime.profile"
    rm -- "$marker"
    printf 'Removed only %s\n' "$profile" | tee "$output/apparmor-cleanup.txt"
  fi
  exit 0
fi
[[ "${1:-}" == setup && "${2:-}" =~ ^sha256:[a-f0-9]{64}$ ]]
image_id="$2"
platform="${AGENTARTS_TEST_PLATFORM:?Platform is required}"
[[ "$platform" == linux/amd64 || "$platform" == linux/arm64 ]]
[[ "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]]
cp -- "$repo_root/agentarts/apparmor-runtime.profile" "$output/apparmor-runtime.profile"
cp -- "$repo_root/agentarts/apparmor-source.json" "$output/apparmor-source.json"
sha256sum "$repo_root/agentarts/apparmor-runtime.profile" \
  "$repo_root/agentarts/seccomp-bwrap.json" \
  "$repo_root/assets/agentarts/worker-seccomp-x64.bpf" \
  "$repo_root/assets/agentarts/worker-seccomp-arm64.bpf" > "$output/namespace-policy-sha256.txt"
sudo --non-interactive cat /sys/kernel/security/apparmor/profiles | \
  awk '$1=="docker-default" || $1=="agentarts-runtime-bwrap-v1"' | tee "$output/apparmor-before.txt"
if grep -q "^$profile " "$output/apparmor-before.txt"; then
  printf 'Refusing to replace an existing project AppArmor profile.\n' >&2
  exit 1
fi
probe_args=(--platform "$platform" --rm --init --read-only --network none
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add KILL
  --security-opt no-new-privileges --security-opt "seccomp=$repo_root/agentarts/seccomp-bwrap.json"
  --pids-limit 64 --memory 256m --cpus 1
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=67108864
  --mount "type=bind,source=$repo_root/agentarts/namespace-probe.mjs,target=/probe/namespace-probe.mjs,readonly"
  --entrypoint node)
started="$(date --iso-8601=seconds)"
capture_denials() {
  if ! sudo --non-interactive journalctl -k --since "$started" --no-pager -o short-iso | \
    awk '/apparmor="DENIED"/ && /comm="bwrap"/ { if (++n <= 80) print }' > "$1"; then
    printf 'Kernel journal unavailable; use the fixed probe stderr for diagnosis.\n' > "$1"
  fi
}
set +e
timeout --signal=TERM --kill-after=2s 15s docker run "${probe_args[@]}" \
  --security-opt apparmor=docker-default "$image_id" /probe/namespace-probe.mjs | tee "$output/namespace-default.jsonl"
default_status=${PIPESTATUS[0]}
set -e
printf 'Default-profile fixed namespace probe exit: %s\n' "$default_status" | tee "$output/namespace-default-status.txt"
# This fixed probe ran no repository/model code. Preserve only its kernel AppArmor denial lines.
capture_denials "$output/apparmor-default-denials.txt"
sudo --non-interactive apparmor_parser -r -K "$repo_root/agentarts/apparmor-runtime.profile"
printf '%s\n' "$profile" > "$marker"
trap 'capture_denials "$output/apparmor-project-denials.txt"' EXIT
timeout --signal=TERM --kill-after=2s 15s docker run "${probe_args[@]}" \
  --security-opt "apparmor=$profile" "$image_id" /probe/namespace-probe.mjs | tee "$output/namespace-project.jsonl"
