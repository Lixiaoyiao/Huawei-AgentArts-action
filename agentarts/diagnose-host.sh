#!/usr/bin/env bash
# Fixed-code, network-none namespace diagnosis. No Runtime/model/repository execution.
# Usage: bash agentarts/diagnose-host.sh IMAGE_SHA256 NEW_OUTPUT [--kernel-trace]
# Optional AGENTARTS_APPARMOR_PROFILE=agentarts-runtime-bwrap-v1 must already be loaded.
set -euo pipefail
classify_registration_error() {
  [[ "$1" =~ ^agentarts_[a-zA-Z0-9]{8}$ && "$2" =~ ^(mount_too_revealing|security_sb_kern_mount|security_sb_mount|admission)$ ]]
  # Read but never export the global error log. Match only our exact command
  # and reduce the preceding error message to a closed, non-sensitive enum.
  awk -v group="$1" -v event="$2" '
    /error:/ { message=$0 }
    index($0,"Command: r:" group "/" event " ") {
      if (message ~ /BTF|btf/) kind="btf-unavailable";
      else if (message ~ /[Ll]ockdown|[Pp]ermission|[Dd]enied|permitted/) kind="policy-denied";
      else if (message ~ /[Ss]ymbol|[Pp]robe point|blacklist/) kind="symbol-unavailable";
      else if (message ~ /[Aa]rgument|[Vv]ariable|[Tt]ype|[Ff]etch|[Nn]ame|[Ii]dentifier/) kind="syntax-unsupported";
      else kind="unclassified";
    }
    END { print kind == "" ? "not-recorded" : kind }
  '
}
if [[ $# == 3 && "$1" == --classify-registration-error ]]; then
  classify_registration_error "$2" "$3"
  exit 0
fi
[[ $# == 2 || ( $# == 3 && "$3" == --kernel-trace ) ]]
image_id="$1"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ && -S /var/run/docker.sock ]]
[[ ! -e "$2" ]] || { printf 'Choose a new evidence directory.\n' >&2; exit 2; }
mkdir -p -- "$2"
output="$(cd -- "$2" && pwd)"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
docker_binary="$(PATH=/usr/local/bin:/usr/bin:/bin command -v docker)"
private_root="$(mktemp -d /tmp/agentarts-hostdiag.XXXXXXXX)"
mkdir -- "$private_root/docker-config"
run_id="$(basename -- "$private_root")"
container_name="$run_id-probe"
docker_command=(env -i PATH=/usr/local/bin:/usr/bin:/bin
  "DOCKER_CONFIG=$private_root/docker-config" DOCKER_HOST=unix:///var/run/docker.sock
  "$docker_binary" --host unix:///var/run/docker.sock --config "$private_root/docker-config")
trace_group="agentarts_${run_id##*.}"
diagnostic_comm="aadg${run_id##*.}"
trace_root=""
trace_instance=""
trace_mounted=false
trace_events=()
armed_events=()
trace_status=not-requested
pid_filter_applied=false
active_pipeline=""
record_registration() {
  local event="$1" function_name="$2" accepted="$3" kind symbol_present=false function_tracer_listed=false
  kind=not-applicable
  if [[ "$accepted" != true ]]; then
    kind="$(sudo --non-interactive cat "$trace_root/error_log" 2>/dev/null | classify_registration_error "$trace_group" "$event")" || kind=not-recorded
  fi
  if sudo --non-interactive awk -v name="$function_name" '$3==name { found=1 } END { exit !found }' /proc/kallsyms; then symbol_present=true; fi
  if sudo --non-interactive awk -v name="$function_name" '$1==name { found=1 } END { exit !found }' "$trace_root/available_filter_functions"; then function_tracer_listed=true; fi
  printf 'function=%s accepted=%s errorKind=%s symbolPresent=%s functionTracerListed=%s\n' "$function_name" "$accepted" "$kind" "$symbol_present" "$function_tracer_listed" >> "$output/kernel-registration.txt"
}
cleanup() {
  local original_status=$? cleanup_status=passed observed_label
  trap - EXIT INT TERM
  if [[ -n "$trace_instance" ]]; then
    for event in "${trace_events[@]}"; do
      printf '0\n' | sudo --non-interactive tee "$trace_instance/events/$trace_group/$event/enable" >/dev/null || cleanup_status=failed
    done
    # Export only function/return values, never kernel addresses, arguments or stacks.
    sudo --non-interactive cat "$trace_instance/trace" | awk '
      /mount_too_revealing:/ { name="mount_too_revealing" }
      /security_sb_kern_mount:/ { name="security_sb_kern_mount" }
      /security_sb_mount:/ { name="security_sb_mount" }
      { for (i=1; i<=NF; i++) if ($i ~ /^return_value=-?[0-9]+$/ && name != "") print "function=" name " " $i; name="" }
    ' > "$output/kernel-trace.txt" || cleanup_status=failed
    sudo --non-interactive rmdir -- "$trace_instance" || cleanup_status=failed
  fi
  for event in "${trace_events[@]}"; do
    printf -- '-:%s/%s\n' "$trace_group" "$event" | sudo --non-interactive tee -a "$trace_root/kprobe_events" >/dev/null || cleanup_status=failed
  done
  if [[ "$trace_mounted" == true ]]; then
    sudo --non-interactive umount -- "$trace_root" || cleanup_status=failed
  fi
  if observed_label="$(timeout 10s "${docker_command[@]}" container inspect --format '{{ index .Config.Labels "agentarts.host-diagnostic-run" }}' "$container_name" 2>/dev/null)"; then
    if [[ "$observed_label" != "$run_id" ]] || ! timeout 10s "${docker_command[@]}" container rm -f "$container_name" >/dev/null 2>&1; then cleanup_status=failed; fi
  elif ! timeout 10s "${docker_command[@]}" version --format '{{.Server.Version}}' >/dev/null 2>&1; then cleanup_status=failed; fi
  if [[ -n "$active_pipeline" ]]; then kill -TERM "$active_pipeline" 2>/dev/null || true; fi
  printf '{"schemaVersion":1,"status":"%s","originalExitCode":%s,"traceStatus":"%s","ownedContainer":"%s"}\n' "$cleanup_status" "$original_status" "$trace_status" "$container_name" > "$output/cleanup.json"
  if [[ "$cleanup_status" == passed && "$private_root" == /tmp/agentarts-hostdiag.* && "$(realpath -- "$private_root")" == "$private_root" ]]; then rm -rf -- "$private_root"; fi
  [[ "$original_status" != 0 || "$cleanup_status" == passed ]] || original_status=1
  printf '{"schemaVersion":1,"status":"%s","matches":"comm=bwrap and this container PID descendants","pidFilterApplied":%s,"functions":["mount_too_revealing","security_sb_kern_mount","security_sb_mount"],"limitation":"EPERM without an observed kernel return does not identify the exact rejection branch"}\n' "$trace_status" "$pid_filter_applied" > "$output/kernel-trace.json"
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sha256sum "$repo_root/agentarts/diagnose-host.sh" "$repo_root/agentarts/host-diagnostic.mjs" \
  "$repo_root/agentarts/namespace-probe.mjs" "$repo_root/agentarts/seccomp-bwrap.json" \
  "$repo_root/assets/agentarts/namespace-launcher.mjs" \
  "$repo_root/assets/agentarts/worker-seccomp-x64.bpf" "$repo_root/assets/agentarts/worker-seccomp-arm64.bpf" > "$output/inputs-sha256.txt"
source_commit="$(git -C "$repo_root" rev-parse HEAD)"
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]]
source_dirty=false
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || source_dirty=true
printf '{"schemaVersion":1,"imageId":"%s","collectorSource":"%s","collectorSourceDirty":%s,"realModelCalled":false,"cloudCalled":false,"githubCalled":false}\n' "$image_id" "$source_commit" "$source_dirty" > "$output/binding.json"
uname -srvm > "$output/host-kernel.txt"
timeout 15s "${docker_command[@]}" version --format '{{json .Server}}' > "$output/docker-server.json"
timeout 15s "${docker_command[@]}" info --format '{"kernel":{{json .KernelVersion}},"os":{{json .OperatingSystem}},"architecture":{{json .Architecture}},"securityOptions":{{json .SecurityOptions}},"defaultRuntime":{{json .DefaultRuntime}},"cgroupVersion":{{json .CgroupVersion}}}' > "$output/docker-policy.json"
timeout 15s "${docker_command[@]}" image inspect "$image_id" --format '{"id":{{json .Id}},"architecture":{{json .Architecture}},"os":{{json .Os}}}' > "$output/image.json"
apparmor_args=()
if [[ -n "${AGENTARTS_APPARMOR_PROFILE:-}" ]]; then
  [[ "$AGENTARTS_APPARMOR_PROFILE" == agentarts-runtime-bwrap-v1 ]]
  apparmor_args+=(--security-opt "apparmor=$AGENTARTS_APPARMOR_PROFILE")
fi
if [[ "${3:-}" == --kernel-trace ]]; then
  trace_status=unavailable
  # Optional host instrumentation. It changes no LSM/sysctl/container permission.
  # Use an isolated trace instance and remove only this run's event definitions.
  if sudo --non-interactive test -e /sys/kernel/tracing/kprobe_events; then
    trace_root=/sys/kernel/tracing
  elif sudo --non-interactive true; then
    mkdir -- "$private_root/tracefs"
    if sudo --non-interactive mount -t tracefs tracefs "$private_root/tracefs"; then
      trace_root="$private_root/tracefs"
      trace_mounted=true
    fi
  fi
  if [[ -n "$trace_root" ]] && sudo --non-interactive mkdir "$trace_root/instances/$trace_group"; then
    trace_instance="$trace_root/instances/$trace_group"
    btf_present=false
    if sudo --non-interactive test -r /sys/kernel/btf/vmlinux; then btf_present=true; fi
    printf 'btfPresent=%s\n' "$btf_present" > "$output/kernel-registration.txt"
    printf '0\n' | sudo --non-interactive tee "$trace_instance/tracing_on" >/dev/null
    printf '64\n' | sudo --non-interactive tee "$trace_instance/buffer_size_kb" >/dev/null
    for function_name in mount_too_revealing security_sb_kern_mount security_sb_mount; do
      if printf 'r:%s/%s %s return_value=$retval:s64 task_comm=$comm:string\n' "$trace_group" "$function_name" "$function_name" | sudo --non-interactive tee -a "$trace_root/kprobe_events" >/dev/null; then
        trace_events+=("$function_name")
        record_registration "$function_name" "$function_name" true
        if printf 'task_comm == "bwrap"\n' | sudo --non-interactive tee "$trace_instance/events/$trace_group/$function_name/filter" >/dev/null; then
          armed_events+=("$function_name")
        fi
      else
        record_registration "$function_name" "$function_name" false
      fi
    done
    if [[ " ${armed_events[*]} " == *' mount_too_revealing '* ]]; then trace_status=armed; else trace_status=partial; fi
    if printf 'r:%s/admission security_file_permission return_value=$retval:s64 task_comm=$comm:string\n' "$trace_group" | sudo --non-interactive tee -a "$trace_root/kprobe_events" >/dev/null; then
      trace_events+=(admission)
      record_registration admission security_file_permission true
      printf 'task_comm == "%s"\n' "$diagnostic_comm" | sudo --non-interactive tee "$trace_instance/events/$trace_group/admission/filter" >/dev/null
      printf '1\n' | sudo --non-interactive tee "$trace_instance/events/$trace_group/admission/enable" >/dev/null
      printf '1\n' | sudo --non-interactive tee "$trace_instance/tracing_on" >/dev/null
    else
      record_registration admission security_file_permission false
    fi
  fi
fi
timeout 15s "${docker_command[@]}" create --pull never --init --read-only --network none \
  --name "$container_name" --label "agentarts.host-diagnostic-run=$run_id" \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add KILL \
  --security-opt no-new-privileges --security-opt "seccomp=$repo_root/agentarts/seccomp-bwrap.json" \
  "${apparmor_args[@]}" --pids-limit 64 --memory 256m --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=67108864 \
  --mount "type=bind,source=$repo_root/agentarts/host-diagnostic.mjs,target=/check/host-diagnostic.mjs,readonly" \
  --mount "type=bind,source=$repo_root/agentarts/namespace-probe.mjs,target=/check/namespace-probe.mjs,readonly" \
  --entrypoint node "$image_id" /check/host-diagnostic.mjs --wait-for-tracer "$diagnostic_comm" > "$output/container-id.txt"
timeout 10s "${docker_command[@]}" container inspect "$container_name" --format '{"apparmorProfile":{{json .AppArmorProfile}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"maskedPaths":{{json .HostConfig.MaskedPaths}},"readonlyPaths":{{json .HostConfig.ReadonlyPaths}},"securityOptions":{{json .HostConfig.SecurityOpt}},"readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"networkMode":{{json .HostConfig.NetworkMode}},"usernsMode":{{json .HostConfig.UsernsMode}},"pidMode":{{json .HostConfig.PidMode}}}' > "$output/container-policy.json"
set +e
(set -o pipefail; timeout --signal=TERM --kill-after=3s 30s "${docker_command[@]}" start --attach "$container_name" 2>&1 | tee "$output/probe.jsonl") &
active_pipeline=$!
set -e
# The fixed helper waits before spawning the original probe. Scope tracing to
# its unique comm's initial kernel PID, then follow only future descendants.
# Docker top PID numbers can belong to a different daemon PID namespace.
admission_deadline=$((SECONDS + 8))
while [[ "$SECONDS" -lt "$admission_deadline" ]]; do
  if [[ -n "$trace_instance" && " ${trace_events[*]} " == *' admission '* ]]; then
    sudo --non-interactive cat "$trace_instance/trace" | awk -v comm="$diagnostic_comm" '
      index($0,"task_comm=\"" comm "\"") && /admission:/ { sub(/^.*-/,"",$1); if ($1 ~ /^[0-9]+$/) print $1 }
    ' | sort -u > "$output/trace-pids.txt"
    if [[ "$(wc -l < "$output/trace-pids.txt")" == 1 ]]; then break; fi
  else
    break
  fi
  sleep 0.1
done
if [[ -n "$trace_instance" ]]; then
  printf '0\n' | sudo --non-interactive tee "$trace_instance/tracing_on" >/dev/null
  if [[ " ${trace_events[*]} " == *' admission '* ]]; then
    printf '0\n' | sudo --non-interactive tee "$trace_instance/events/$trace_group/admission/enable" >/dev/null
  fi
fi
if [[ ${#armed_events[@]} -gt 0 && -s "$output/trace-pids.txt" && "$(wc -l < "$output/trace-pids.txt")" == 1 ]]; then
  if sudo --non-interactive tee "$trace_instance/set_event_pid" < "$output/trace-pids.txt" >/dev/null && \
    printf '1\n' | sudo --non-interactive tee "$trace_instance/options/event-fork" >/dev/null; then
    pid_filter_applied=true
    for event in "${armed_events[@]}"; do
      printf '1\n' | sudo --non-interactive tee "$trace_instance/events/$trace_group/$event/enable" >/dev/null
    done
    printf '1\n' | sudo --non-interactive tee "$trace_instance/tracing_on" >/dev/null
  else
    trace_status=unavailable
  fi
elif [[ "${3:-}" == --kernel-trace ]]; then
  trace_status=unavailable
fi
timeout 5s "${docker_command[@]}" exec --user 0:0 "$container_name" node -e "require('node:fs').writeFileSync('/tmp/agentarts-diagnostic-go','fixed-bootstrap')" >/dev/null
set +e
wait "$active_pipeline"
result=$?
active_pipeline=""
set -e
printf '{"schemaVersion":1,"exitCode":%s,"realModelCalled":false,"cloudCalled":false,"githubCalled":false}\n' "$result" > "$output/outcome.json"
exit "$result"
