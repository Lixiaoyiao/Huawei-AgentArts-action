#!/usr/bin/env bash
# Test the unchanged production entrypoint; no external network or real key.
set -euo pipefail
image_id="${1:?Pass the already-tested local image ID}"
output="${2:?Pass a local evidence directory}"
mkdir -p -- "$output"
secret_root="$(mktemp -d /var/tmp/agentarts-negative-XXXXXX)"
cleanup() { rm -f -- "$secret_root/key"; rmdir -- "$secret_root"; }
trap cleanup EXIT
printf '%s' 'only-a-local-fixture-key' > "$secret_root/key"
chmod 0600 "$secret_root/key"
base_args=(--rm --read-only --network none --security-opt no-new-privileges --pids-limit 128 --memory 1g --tmpfs /tmp:rw,noexec,nosuid,nodev,size=536870912)
secret_args=(--mount "type=bind,source=$secret_root/key,target=/run/secrets/key,readonly" --env DEEPSEEK_API_KEY_FILE=/run/secrets/key)
if timeout 15s docker run "${base_args[@]}" --cap-drop ALL "${secret_args[@]}" "$image_id" > "$output/missing-capabilities.log" 2>&1; then
  printf 'Missing capabilities unexpectedly passed startup.\n' >&2; exit 1
fi
grep -q 'Runtime startup refused' "$output/missing-capabilities.log"
! grep -q 'runtime.ready' "$output/missing-capabilities.log"
chmod 0644 "$secret_root/key"
if timeout 15s docker run "${base_args[@]}" --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add KILL "${secret_args[@]}" "$image_id" > "$output/readable-key-file.log" 2>&1; then
  printf 'Group-readable key unexpectedly passed startup.\n' >&2; exit 1
fi
grep -q 'Runtime startup refused' "$output/readable-key-file.log"
! grep -q 'runtime.ready' "$output/readable-key-file.log"
printf '{"schemaVersion":1,"mode":"container","status":"passed","modelEvidence":"deterministic-fixture","realModelCalled":false,"cloudCalled":false,"cases":["missing-capabilities-refused-before-health","readable-key-file-refused-before-health"]}\n' > "$output/startup-negative.json"
cat "$output/startup-negative.json"
