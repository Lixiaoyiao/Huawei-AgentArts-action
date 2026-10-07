#!/usr/bin/env bash
# Explicit public npm-download proof; no model/cloud/GitHub call or credential mount.
# Usage: bash agentarts/check-image-extensions-session.sh IMAGE_SHA256 CLEAN_SOURCE DEV_DEPS_ROOT NEW_OUTPUT
# AGENTARTS_IMAGE_PROOF_TIMEOUT_SECONDS can lower the 240-second default (1..240).
set -euo pipefail
[[ $# == 4 ]] || { printf 'Expected fixed image ID, clean source checkout, dependency root and new output directory.\n' >&2; exit 2; }
image_id="$1"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]]
source_root="$(realpath -- "$2")"
dependencies_root="$(realpath -- "$3")"
[[ -d "$source_root" && -d "$dependencies_root/node_modules" ]]
source_commit="$(git -C "$source_root" rev-parse HEAD)"
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]]
[[ -z "$(git -C "$source_root" status --porcelain --untracked-files=normal)" ]]
cmp -- "$source_root/package-lock.json" "$dependencies_root/package-lock.json"
timeout_seconds="${AGENTARTS_IMAGE_PROOF_TIMEOUT_SECONDS:-240}"
[[ "$timeout_seconds" =~ ^[1-9][0-9]{0,2}$ && "$timeout_seconds" -le 240 ]]
output="$4"
[[ ! -e "$output" ]] || { printf 'Choose a new evidence directory; previous runs are preserved.\n' >&2; exit 2; }
mkdir -p -- "$output"
output="$(cd -- "$output" && pwd)"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$repo_root/agentarts/check-image-extensions-session.mjs"
sha256sum "$helper" "$source_root/package-lock.json" "$source_root/agentarts/seccomp-bwrap.json" > "$output/inputs-sha256.txt"
printf '{"schemaVersion":1,"mode":"container-source-harness","imageId":"%s","sourceCommit":"%s","sourceDirty":false,"modelEvidence":"deterministic-fixture","realModelCalled":false,"cloudCalled":false,"githubPublished":false,"limits":{"timeoutSeconds":%s,"memoryBytes":2147483648,"cpus":2,"pids":256},"network":"supervisor bridge for approved npm registry; worker namespace and egress policy remain enforced"}\n' "$image_id" "$source_commit" "$timeout_seconds" > "$output/binding.json"
# Ignore inherited contexts, endpoints, registry credentials and credential helpers.
[[ -S /var/run/docker.sock ]]
docker_binary="$(PATH=/usr/local/bin:/usr/bin:/bin command -v docker)"
private_root="$(mktemp -d /tmp/agentarts-image-check.XXXXXXXX)"
mkdir -- "$private_root/docker-config"
run_id="$(basename -- "$private_root")"
binary_name="$run_id-binary"
fixtures_name="$run_id-fixtures"
docker_command=(env -i PATH=/usr/local/bin:/usr/bin:/bin
  "DOCKER_CONFIG=$private_root/docker-config" DOCKER_HOST=unix:///var/run/docker.sock
  "$docker_binary" --host unix:///var/run/docker.sock --config "$private_root/docker-config")
active_pipeline=""
run_logged() {
  local seconds="$1" log_path="$2" result
  shift 2
  (set -o pipefail; timeout --signal=TERM --kill-after=5s "${seconds}s" "$@" 2>&1 | tee "$log_path") &
  active_pipeline=$!
  if wait "$active_pipeline"; then result=0; else result=$?; fi
  active_pipeline=""
  return "$result"
}
cleanup() {
  local original_status=$? cleanup_status=passed observed_label
  trap - EXIT INT TERM
  for name in "$binary_name" "$fixtures_name"; do
    if observed_label="$(timeout 10s "${docker_command[@]}" container inspect --format '{{ index .Config.Labels "agentarts.image-proof-run" }}' "$name" 2>/dev/null)"; then
      if [[ "$observed_label" != "$run_id" ]] || ! timeout 10s "${docker_command[@]}" container rm -f "$name" >/dev/null 2>&1; then
        cleanup_status=failed
      fi
    elif ! timeout 10s "${docker_command[@]}" version --format '{{.Server.Version}}' >/dev/null 2>&1; then
      cleanup_status=failed
    fi
  done
  if [[ -n "$active_pipeline" ]]; then kill -TERM "$active_pipeline" 2>/dev/null || true; fi
  printf '{"schemaVersion":1,"status":"%s","originalExitCode":%s,"containerNames":["%s","%s"]}\n' "$cleanup_status" "$original_status" "$binary_name" "$fixtures_name" > "$output/cleanup.json"
  [[ "$private_root" == /tmp/agentarts-image-check.* && "$(realpath -- "$private_root")" == "$private_root" ]] && rm -rf -- "$private_root"
  if [[ "$original_status" == 0 && "$cleanup_status" != passed ]]; then original_status=1; fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout 15s "${docker_command[@]}" image inspect "$image_id" --format '{"id":{{json .Id}},"architecture":{{json .Architecture}},"os":{{json .Os}}}' > "$output/image.json"
apparmor_args=()
if [[ -n "${AGENTARTS_APPARMOR_PROFILE:-}" ]]; then
  [[ "$AGENTARTS_APPARMOR_PROFILE" == agentarts-runtime-bwrap-v1 ]]
  apparmor_args+=(--security-opt "apparmor=$AGENTARTS_APPARMOR_PROFILE")
fi
common_args=(--pull never --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges
  --label "agentarts.image-proof-run=$run_id"
  --mount "type=bind,source=$helper,target=/check/check-image-extensions-session.mjs,readonly"
  --entrypoint node)
set +e
run_logged 15 "$output/binary-hardening.log" "${docker_command[@]}" run "${common_args[@]}" \
  --name "$binary_name" --network none "$image_id" \
  /check/check-image-extensions-session.mjs hardening
binary_status=$?
set -e
if [[ "$binary_status" != 0 ]]; then
  printf '{"schemaVersion":1,"phase":"binary-hardening","exitCode":%s,"realModelCalled":false,"cloudCalled":false,"githubPublished":false}\n' "$binary_status" > "$output/outcome.json"
  exit "$binary_status"
fi
mounts=()
for name in src assets test package.json package-lock.json; do
  [[ -e "$source_root/$name" ]]
  mounts+=(--mount "type=bind,source=$source_root/$name,target=/opt/fixture/$name,readonly")
done
mounts+=(--mount "type=bind,source=$dependencies_root/node_modules,target=/opt/fixture/node_modules,readonly")
set +e
run_logged "$timeout_seconds" "$output/fixtures.log" "${docker_command[@]}" run "${common_args[@]}" \
  --name "$fixtures_name" --network bridge "${apparmor_args[@]}" \
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add KILL \
  --security-opt "seccomp=$source_root/agentarts/seccomp-bwrap.json" \
  --pids-limit 256 --memory 2g --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1073741824 \
  "${mounts[@]}" --workdir /opt/fixture "$image_id" \
  /check/check-image-extensions-session.mjs test
result=$?
set -e
printf '{"schemaVersion":1,"exitCode":%s,"realModelCalled":false,"cloudCalled":false,"githubPublished":false}\n' "$result" > "$output/outcome.json"
printf 'Fixed image evidence: %s\n' "$output"
exit "$result"
