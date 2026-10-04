#!/usr/bin/env bash
# Local image verification only: no registry push, cloud API, real model or GitHub call.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_root"
platform="${AGENTARTS_TEST_PLATFORM:-linux/amd64}"
case "$platform" in
  linux/amd64) expected_arch=x64 ;;
  linux/arm64) expected_arch=arm64 ;;
  *) printf 'Choose linux/amd64 or linux/arm64.\n' >&2; exit 2 ;;
esac
test_tag="huawei-agentarts-action:local-${expected_arch}"
output="${AGENTARTS_EVIDENCE_DIR:-$repo_root/work/container-${expected_arch}}"
mkdir -p -- "$output"
output="$(cd -- "$output" && pwd)"
source_commit="$(git rev-parse HEAD)"
source_dirty=false
if ! git diff --quiet HEAD -- . || [ -n "$(git ls-files --others --exclude-standard)" ]; then source_dirty=true; fi
# NUL-separated path lists must stay in a stream, never a shell variable.
source_tree_digest="$(
  { find src assets scripts -type f -print0; printf '%s\0' package.json package-lock.json tsconfig.json agentarts/Dockerfile test/fixtures/messages-sse.mjs test/fixtures/messages-sse.d.mts LICENSE THIRD_PARTY_NOTICES.md BUNDLED_DEPENDENCIES.md; } |
  LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f1
)"
build_args=()
if [ "${AGENTARTS_BUILD_NETWORK:-default}" = host ]; then build_args+=(--network host); fi
docker build --platform "$platform" --file agentarts/Dockerfile \
  --provenance=false --sbom=false --output type=image,oci-mediatypes=false \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  "${build_args[@]}" --tag "$test_tag" .
image_id="$(docker image inspect "$test_tag" --format '{{.Id}}')"
docker image inspect "$test_tag" --format '{{json .Descriptor}}' > "$output/image-descriptor.json"
emulated=false
case "$(uname -m):$platform" in
  x86_64:linux/arm64|aarch64:linux/amd64) emulated=true ;;
esac
timeout --signal=TERM --kill-after=5s 125s \
  docker run --platform "$platform" --rm --init --read-only --network none \
    --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add KILL \
    --security-opt no-new-privileges --pids-limit 256 --memory 1g --cpus 2 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=536870912 \
    --mount "type=bind,source=$repo_root/agentarts/smoke.mjs,target=/smoke/smoke.mjs,readonly" \
    --mount "type=bind,source=$repo_root/test/fixtures/messages-sse.mjs,target=/smoke/messages-sse.mjs,readonly" \
    --env "SMOKE_EXPECTED_ARCH=$expected_arch" --env "SMOKE_EMULATED=$emulated" \
    --env "SMOKE_SOURCE_SHA=$source_commit" --env "SMOKE_SOURCE_DIRTY=$source_dirty" \
    --env "SMOKE_SOURCE_TREE_DIGEST=$source_tree_digest" --env "SMOKE_IMAGE_ID=$image_id" \
    --entrypoint node "$image_id" /smoke/smoke.mjs | tee "$output/smoke.jsonl"
bash agentarts/startup-negative.sh "$image_id" "$output"
printf 'Local container evidence: %s\n' "$output"
