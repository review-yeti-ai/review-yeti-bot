#!/usr/bin/env bash
# Flux-aware worker-key guard and dispatcher restart. No installation or activation.
set +x
set -euo pipefail
shopt -u nocasematch
export LC_ALL=C
namespace=ct-review-system
name=ct-review-job-dispatcher
container=review-job-dispatcher
marker_key=review-yeti.ai/worker-upgrade
# shellcheck source=scripts/lib/review-runtime-image-provenance.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-runtime-image-provenance.sh"

die() { echo "advance-review-worker: $*" >&2; exit 1; }
lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}
usage() {
  echo 'usage: advance-review-worker.sh --context CONTEXT --source-sha SHA --target-image REPO@sha256:DIGEST [--rollback RECORD] [--expected-state PLAN --receipt NEW_PATH --apply]'
  echo 'Default: read-only JSON plan. Apply binds both objects to PLAN.before. See docs/DOKS_REVIEW_OPERATIONS.md.'
}
k() { kubectl --context "$context" --namespace "$namespace" --request-timeout=30s "$@" 2>/dev/null; }
json() { jq -cse 'if length==1 and (.[0]|type)=="object" then .[0] else error("expected one object") end'; }
hash() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi | awk '{print $1}'
}
trusted_worker() {
  [[ "$1" =~ ^(ghcr\.io/review-yeti-ai/review-yeti-worker|registry\.digitalocean\.com/calltelemetry/review-yeti-worker)@sha256:[0-9a-f]{64}$ ]]
}
context="" source_sha="" target="" expected="" receipt="" rollback="" apply=0 dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    --context|--source-sha|--target-image|--expected-state|--receipt|--rollback)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die 'missing argument'
      case "$1" in
        --context) context="$2" ;; --source-sha) source_sha="$2" ;;
        --target-image) target="$2" ;; --expected-state) expected="$2" ;;
        --receipt) receipt="$2" ;; --rollback) rollback="$2" ;;
      esac
      shift 2 ;;
    --*) die 'unknown argument' ;;
    *) [[ -z "$source_sha" ]] || die 'duplicate positional source'; source_sha="$1"; shift ;;
  esac
done
[[ "$apply:$dry_run" != 1:1 ]] || die '--dry-run cannot be combined with --apply'
[[ "$context" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] || die 'explicit context required'
[[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'reviewed full source SHA required; release tags are no longer resolved'
source_sha="$(lower "$source_sha")"
trusted_worker "$target" || die 'exact trusted worker index image required'
for command in kubectl jq crane date node; do command -v "$command" >/dev/null || die "missing command: $command"; done
command -v shasum >/dev/null || command -v sha256sum >/dev/null || die 'missing SHA256 utility'

worker_management() {
  jq -ceS '
    ([.metadata.managedFields[]?
      | select((.fieldsV1."f:data"."f:REVIEW_JOB_WORKER_IMAGE" // null) != null)
      | select((.manager // "") == "kustomize-controller" or (.manager // "") == "helm-controller")
      | {manager:.manager,operation:(.operation // null)}] | sort_by(.manager)) as $owners
    | (.metadata.labels["kustomize.toolkit.fluxcd.io/name"] // null) as $name
    | (.metadata.labels["kustomize.toolkit.fluxcd.io/namespace"] // null) as $namespace
    | if (($owners|length)>0 or ($name!=null and $namespace!=null)) then
        {mode:"flux",controller:(if ($owners|length)>0 then $owners[0].manager else "kustomize-controller" end),
         name:$name,namespace:$namespace}
      else {mode:"direct"} end
  ' <<<"$1"
}

# Full objects remain in memory only. Hash every declared field except owned
# worker key / restart marker and Kubernetes-managed volatile metadata.
summarize() {
  local kind="$1" raw="$2" protected
  jq -e --arg kind "$kind" --arg name "$name" --arg ns "$namespace" '
    .kind==$kind and .metadata.name==$name and .metadata.namespace==$ns
    and (.metadata.uid|type)=="string" and (.metadata.uid|length)>0
    and (.metadata.resourceVersion|type)=="string" and (.metadata.resourceVersion|length)>0
    and (.metadata.deletionTimestamp // null)==null
  ' <<<"$raw" >/dev/null || return 1
  protected="$(jq -cS --arg kind "$kind" --arg marker "$marker_key" '
    del(.status,.metadata.uid,.metadata.resourceVersion,.metadata.generation,
        .metadata.creationTimestamp,.metadata.managedFields)
    | if $kind=="ConfigMap" then del(.data.REVIEW_JOB_WORKER_IMAGE)
      else
        .metadata.annotations=((.metadata.annotations // {})|del(.["deployment.kubernetes.io/revision"]))
        | .spec.template.metadata.annotations=((.spec.template.metadata.annotations // {})|del(.[$marker]))
      end' <<<"$raw" | hash)" || return 1
  if [[ "$kind" == ConfigMap ]]; then
    jq -ceS --arg hash "$protected" '
      if .data.REVIEW_JOB_RUNNER_MODE!="prebaked" or .data.REVIEW_JOB_DISPATCH_ENABLED!="true"
      then error("inactive mode") else
      {uid:.metadata.uid,resourceVersion:.metadata.resourceVersion,workerImage:.data.REVIEW_JOB_WORKER_IMAGE,
       protectedHash:$hash} end' <<<"$raw"
  else
    jq -ceS --arg hash "$protected" --arg container "$container" --arg marker "$marker_key" --arg name "$name" '
      [.spec.template.spec.containers[]?|select(.name==$container)] as $c |
      if ($c|length)!=1 or (.spec.replicas|type)!="number" or .spec.replicas<1
         or (.metadata.generation|type)!="number" or .metadata.generation<1
         or ($c[0].envFrom|length)!=1
         or ([ $c[0].envFrom[]? | select(.configMapRef.name==$name and (.prefix // "")=="") ]|length)!=1
         or any($c[0].env[]?; .name=="REVIEW_JOB_WORKER_IMAGE" or .name=="REVIEW_JOB_RUNNER_MODE" or .name=="REVIEW_JOB_DISPATCH_ENABLED")
      then error("inactive or malformed dispatcher") else
      {uid:.metadata.uid,resourceVersion:.metadata.resourceVersion,generation:.metadata.generation,
       replicas:.spec.replicas,image:$c[0].image,protectedHash:$hash,
       marker:(.spec.template.metadata.annotations[$marker] // null)} end' <<<"$raw"
  fi
}
read_state() {
  cm_raw="$(k get configmap "$name" -o json --show-managed-fields=true | json)" || return 1
  dep_raw="$(k get deployment "$name" -o json | json)" || return 1
  cm_management="$(worker_management "$cm_raw")" || return 1
  cm="$(summarize ConfigMap "$cm_raw" 2>/dev/null)" || return 1
  dep="$(summarize Deployment "$dep_raw" 2>/dev/null)" || return 1
  trusted_worker "$(jq -r '.workerImage' <<<"$cm")" || return 1
  [[ "$(jq -r '.image' <<<"$dep")" =~ ^(ghcr\.io/review-yeti-ai/review-yeti-bot|registry\.digitalocean\.com/calltelemetry/ct-review-bot)@sha256:[0-9a-f]{64}$ ]] || return 1
  snapshot="$(jq -cSn --argjson cm "$cm" --argjson dep "$dep" '{configmap:$cm,deployment:$dep}')"
}
same() { jq -en --argjson a "$1" --argjson b "$2" '$a==$b' >/dev/null; }
stable_dep() { jq -cS 'del(.resourceVersion)' <<<"$1"; }
running_matches() {
  local sets pods owners current_owners candidates pod value images_match=0
  sets="$(k get replicasets -l app.kubernetes.io/name=ct-review-job-dispatcher -o json | json)" || die 'cannot read ReplicaSet ownership'
  pods="$(k get pods -l app.kubernetes.io/name=ct-review-job-dispatcher -o json | json)" || die 'cannot read running pods'
  jq -e '(.items|type)=="array"' <<<"$sets" >/dev/null || die 'malformed ReplicaSet response'
  jq -e '(.items|type)=="array"' <<<"$pods" >/dev/null || die 'malformed pod response'
  owners="$(jq -c --argjson d "$dep" --arg container "$container" '
    [.items[] | select(any(.metadata.ownerReferences[]?; .uid==$d.uid and .kind=="Deployment" and .controller==true))
     | select(any(.spec.template.spec.containers[]?; .name==$container and .image==$d.image)) | .metadata.uid]' <<<"$sets")"
  current_owners="$(jq -c --argjson owners "$owners" --argjson d "$dep" --arg marker "$marker_key" '
    [.items[] | select(.metadata.uid as $uid|$owners|index($uid)!=null)
     | select((.spec.template.metadata.annotations[$marker] // null)==$d.marker) | .metadata.uid]' <<<"$sets")"
  candidates="$(jq -c '[.items[]|select(.metadata.deletionTimestamp==null)]' <<<"$pods")"
  jq -e --argjson d "$dep" --argjson owners "$owners" --arg container "$container" '
    length==$d.replicas and all(.[];
      .status.phase=="Running" and any(.status.conditions[]?; .type=="Ready" and .status=="True")
      and any(.status.containerStatuses[]?; .name==$container and .ready==true)
      and any(.metadata.ownerReferences[]?; .kind=="ReplicaSet" and .controller==true and (.uid as $uid|$owners|index($uid)!=null))
      and any(.spec.containers[]?; .name==$container and .image==$d.image)
      and (.metadata.name|test("^[a-z0-9][a-z0-9.-]*$")))
  ' <<<"$candidates" >/dev/null || die 'cannot attest the active owned ready prebaked lane'
  # A lost restart ACK can leave old owned pods running. Attest their mode
  # before recovery, but never count them as a completed current rollout.
  jq -e --argjson owners "$current_owners" '
    all(.[]; any(.metadata.ownerReferences[]?; .uid as $uid|$owners|index($uid)!=null))
  ' <<<"$candidates" >/dev/null || images_match=1
  while IFS= read -r pod; do
    # Same precedence/trim/default as reviewJobDispatcherConfigFromEnv. Print
    # only these two non-secret coordinates; do not import the live entrypoint.
    value="$(k exec "$pod" --container "$container" -- node -e '
      const e = process.env;
      process.stdout.write(JSON.stringify({
        runnerMode: e.REVIEW_JOB_RUNNER_MODE?.trim() || e.RUNNER_MODE?.trim() || "prebaked",
        workerImage: e.REVIEW_JOB_WORKER_IMAGE?.trim() || ""
      }));
    ' | json)" || die 'running worker configuration unreadable'
    jq -e '.runnerMode=="prebaked" and (.workerImage|type)=="string"' <<<"$value" >/dev/null ||
      die 'running dispatcher is not already prebaked; refusing lane activation'
    # A stale image may request a guarded restart, but still attest every pod.
    [[ "$(jq -r '.workerImage' <<<"$value")" == "$target" ]] || images_match=1
  done < <(jq -r '.[].metadata.name' <<<"$candidates")
  return "$images_match"
}
new_path() {
  local path="$1" parent
  [[ -n "$path" && ! -e "$path" && ! -L "$path" ]] || die 'receipt/intent must be a new regular file'
  parent="$(dirname "$path")"
  [[ -d "$parent" && ! -L "$parent" ]] || die 'receipt parent missing or symlink'
}
private_write() {
  # O_EXCL is the publication guard, not new_path: every occupied leaf
  # (including symlinks/FIFOs/directories) must fail without opening it.
  # Node is an explicit operator prerequisite; only built-in fs is used.
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const c = fs.constants;
    const destination = process.argv[1];
    let fd, directory;
    try {
      if (!Number.isInteger(c.O_NOFOLLOW) || !Number.isInteger(c.O_DIRECTORY)) throw new Error();
      const bytes = fs.readFileSync(0);
      fd = fs.openSync(destination, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
      fs.fchmodSync(fd, 0o600);
      if (!fs.fstatSync(fd).isFile()) throw new Error();
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      directory = fs.openSync(path.dirname(destination), c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
      fs.fsyncSync(directory);
      const opened = fs.fstatSync(fd);
      const named = fs.lstatSync(destination);
      if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino
          || named.size !== bytes.length || (named.mode & 0o777) !== 0o600) throw new Error();
    } catch {
      process.stderr.write("advance-review-worker: exclusive regular receipt persistence failed\n");
      process.exitCode = 1;
    } finally {
      for (const handle of [fd, directory]) {
        if (handle !== undefined) {
          try { fs.closeSync(handle); } catch { process.exitCode = 1; }
        }
      }
    }
  ' "$1" <<<"$2"
}
record() {
  jq -n --arg status "$status" --arg op "$operation" --arg context "$context" \
    --arg source "$source_sha" --arg target "$target" --arg marker "$marker" \
    --argjson before "$before" --argjson after "$after" --argjson parent "$rollback_record" '
    {schema:"review-yeti-worker-receipt.v1",context:$context,namespace:"ct-review-system",
     deployment:"ct-review-job-dispatcher",container:"review-job-dispatcher",
     operation:$op,status:$status,reviewedSourceSha:$source,targetImage:$target,marker:$marker,
     before:$before,after:$after,afterObserved:($after!=null),
     rollbackOf: (if $parent==null then null else {source:$parent.reviewedSourceSha,marker:$parent.marker} end)}'
}
finish() {
  local code="$?" outcome_record
  trap - EXIT
  if [[ "$intent_written" == 1 ]]; then
    if ! outcome_record="$(record)"; then
      echo 'advance-review-worker: outcome serialization failed; retain immutable intent; no success claimed' >&2
      exit 1
    fi
    if ! private_write "$receipt" "$outcome_record"; then
      echo 'advance-review-worker: outcome receipt unavailable; retain immutable intent; no success claimed' >&2
      exit 1
    fi
    [[ "$code" == 0 ]] || echo "advance-review-worker: $status; retain receipt and intent for separately planned recovery" >&2
    if [[ "$code" == 0 && "$status" == applied ]]; then
      echo 'advance-review-worker: worker key and owned running dispatcher verified; prior runtime receipts are invalidated'
    fi
  fi
  exit "$code"
}

verify_review_runtime_image_provenance "$target" "$source_sha" || die 'target/source provenance not verified'
crane_path="$(type -P crane)" || die 'installed crane required'
manifest="$("$crane_path" manifest "$target" 2>/dev/null | json)" || die 'index unreadable'
jq -e '
  (.mediaType=="application/vnd.oci.image.index.v1+json" or .mediaType=="application/vnd.docker.distribution.manifest.list.v2+json")
  and any(.manifests[]?; .platform.os=="linux" and .platform.architecture=="amd64")
  and any(.manifests[]?; .platform.os=="linux" and .platform.architecture=="arm64")
' <<<"$manifest" >/dev/null || die 'multi-arch index covering Linux amd64 and arm64 required'
read_state || die 'active prebaked dispatcher/worker identity unreadable or invalid; installation is separate'
before="$snapshot"
operation=upgrade rollback_record=null
if [[ -n "$rollback" ]]; then
  [[ -f "$rollback" && ! -L "$rollback" ]] || die 'rollback requires a retained regular receipt or intent'
  rollback_record="$(json <"$rollback")" || die 'malformed recovery record'
  trusted_worker "$(jq -r '.targetImage' <<<"$rollback_record")" || die 'untrusted recovery target'
  jq -e --arg context "$context" --arg target "$target" --argjson now "$before" '
    .schema=="review-yeti-worker-receipt.v1" and .context==$context and .namespace=="ct-review-system"
    and .deployment=="ct-review-job-dispatcher" and .container=="review-job-dispatcher" and .operation=="upgrade"
    and (.reviewedSourceSha|test("^[0-9a-f]{40}$"))
    and (.marker|test("^[0-9]{8}T[0-9]{6}Z-[0-9]+$"))
    and (.before.configmap.resourceVersion|type)=="string" and (.before.configmap.resourceVersion|length)>0
    and (.before.deployment.resourceVersion|type)=="string" and (.before.deployment.resourceVersion|length)>0
    and (.status as $s | ["intent","noop","applied","configmap_patch_uncertain","restart_guard_failed",
                         "restart_patch_uncertain","rollout_failed","readback_failed"] | index($s)!=null)
    and (if .status=="noop" then .afterObserved==true and .after==.before
         elif .status=="applied" then
           .afterObserved==true and .after.configmap.uid==.before.configmap.uid
           and .after.configmap.workerImage==.targetImage
           and .after.configmap.protectedHash==.before.configmap.protectedHash
           and .after.deployment.uid==.before.deployment.uid
           and .after.deployment.image==.before.deployment.image
           and .after.deployment.protectedHash==.before.deployment.protectedHash
           and .after.deployment.generation==(.before.deployment.generation+1)
           and .after.deployment.marker==.marker
         else .afterObserved==false and .after==null end)
    and .before.configmap.workerImage==$target
    and .before.configmap.uid==$now.configmap.uid and .before.configmap.protectedHash==$now.configmap.protectedHash
    and ($now.configmap.workerImage==.before.configmap.workerImage or $now.configmap.workerImage==.targetImage)
    and .before.deployment.uid==$now.deployment.uid and .before.deployment.protectedHash==$now.deployment.protectedHash
    and .before.deployment.image==$now.deployment.image and .before.deployment.replicas==$now.deployment.replicas
    and (($now.deployment.generation==.before.deployment.generation and $now.deployment.marker==.before.deployment.marker)
         or (.status!="noop" and $now.deployment.generation==(.before.deployment.generation+1) and $now.deployment.marker==.marker))
  ' <<<"$rollback_record" >/dev/null || die 'recovery identity/configuration drift; needs a new independently validated plan'
  operation=rollback
fi
running_image_matches=0
if running_matches; then running_image_matches=1; fi
action=update-and-restart
if [[ "$(jq -r '.workerImage' <<<"$cm")" == "$target" ]]; then
  action=restart
  if [[ "$running_image_matches" == 1 ]]; then action=noop; fi
elif [[ "$(jq -r '.mode' <<<"$cm_management")" == flux ]]; then
  action=gitops-update-required
fi
management="$cm_management"
plan="$(jq -n --arg context "$context" --arg source "$source_sha" --arg target "$target" \
  --arg op "$operation" --arg action "$action" --argjson before "$before" --argjson recovery "$rollback_record" \
  --argjson management "$management" '
  {schema:"review-yeti-worker-plan.v2",context:$context,namespace:"ct-review-system",
   reviewedSourceSha:$source,targetImage:$target,operation:$op,action:$action,management:$management,
   before:$before,recovery:$recovery}')"
if [[ "$apply" != 1 ]]; then printf '%s\n' "$plan"; exit 0; fi
[[ "$action" != gitops-update-required ]] ||
  die 'Flux owns the worker image; update GitOps source and wait for reconciliation before applying a restart-only plan'
[[ -f "$expected" && ! -L "$expected" ]] || die '--expected-state reviewed plan required'
expected_plan="$(json <"$expected")" || die 'expected state malformed'
same "$plan" "$expected_plan" || die 'stale or mismatched expected state; no writes'
expected_management="$management"
new_path "$receipt"; new_path "$receipt.intent"
marker="$(date -u +%Y%m%dT%H%M%SZ)-$$"
after=null status=intent intent_written=0
if [[ "$action" == noop ]]; then
  # Verify object binding again after the read-only pod checks.
  if ! read_state || ! same "$snapshot" "$before" || ! same "$cm_management" "$expected_management"; then die 'noop state drift'; fi
  after="$snapshot" status=noop
  receipt_record="$(record)" || die 'cannot serialize noop receipt'
  private_write "$receipt" "$receipt_record" || die 'cannot persist noop receipt'
  exit 0
fi
receipt_record="$(record)" || die 'cannot serialize intent; no write attempted'
private_write "$receipt.intent" "$receipt_record" || die 'cannot persist intent; no write attempted'
intent_written=1
trap finish EXIT
expected_cm="$cm" expected_dep="$dep"
if [[ "$action" == update-and-restart ]]; then
  status=configmap_patch_uncertain
  patch="$(jq -n --argjson cm "$cm" --arg target "$target" '
    [{op:"test",path:"/metadata/uid",value:$cm.uid},
     {op:"test",path:"/metadata/resourceVersion",value:$cm.resourceVersion},
     {op:"test",path:"/data/REVIEW_JOB_WORKER_IMAGE",value:$cm.workerImage},
     {op:"replace",path:"/data/REVIEW_JOB_WORKER_IMAGE",value:$target}]')"
  ack="$(k patch configmap "$name" --type=json --field-manager=review-yeti-worker-upgrade --patch "$patch" -o json | json)" || die 'worker patch rejected or acknowledgement lost; no retry'
  ack_management="$(worker_management "$ack")" || die 'worker patch acknowledgement ownership invalid'
  expected_cm="$(summarize ConfigMap "$ack" 2>/dev/null)" || die 'worker patch acknowledgement invalid'
  same "$ack_management" "$expected_management" || die 'worker patch acknowledgement ownership drift'
  same "$(jq -cS --arg target "$target" '.workerImage=$target|del(.resourceVersion)' <<<"$cm")" "$(jq -cS 'del(.resourceVersion)' <<<"$expected_cm")" || die 'worker acknowledgement drift'
  [[ "$(jq -r '.resourceVersion' <<<"$cm")" != "$(jq -r '.resourceVersion' <<<"$expected_cm")" ]] || die 'worker acknowledgement version unchanged'
fi
status=restart_guard_failed
if ! read_state || ! same "$cm" "$expected_cm" || ! same "$dep" "$expected_dep" || ! same "$cm_management" "$expected_management"; then die 'object/configuration changed before restart'; fi
# A JSON Patch RV test binds the full protected template; merge only our marker
# into its existing annotations. No rollout restart command can bypass this CAS.
patch="$(jq -n --argjson dep "$dep" --argjson raw "$dep_raw" --arg marker "$marker" --arg key "$marker_key" '
  [{op:"test",path:"/metadata/uid",value:$dep.uid},
   {op:"test",path:"/metadata/resourceVersion",value:$dep.resourceVersion},
   {op:"test",path:"/metadata/generation",value:$dep.generation},
   {op:"add",path:"/spec/template/metadata/annotations",value:(($raw.spec.template.metadata.annotations // {})+{($key):$marker})}]')"
status=restart_patch_uncertain
ack="$(k patch deployment "$name" --type=json --field-manager=review-yeti-worker-upgrade --patch "$patch" -o json | json)" || die 'restart rejected or acknowledgement lost; no retry'
expected_dep="$(summarize Deployment "$ack" 2>/dev/null)" || die 'restart acknowledgement invalid'
same "$(jq -cS --arg marker "$marker" '.generation+=1|.marker=$marker|del(.resourceVersion)' <<<"$dep")" "$(stable_dep "$expected_dep")" || die 'restart acknowledgement drift'
[[ "$(jq -r '.resourceVersion' <<<"$dep")" != "$(jq -r '.resourceVersion' <<<"$expected_dep")" ]] || die 'restart acknowledgement version unchanged'
status=rollout_failed
k rollout status "deployment/$name" --timeout=180s >/dev/null || die 'bounded rollout failed'
status=readback_failed
if ! read_state || ! same "$cm" "$expected_cm" || ! same "$(stable_dep "$dep")" "$(stable_dep "$expected_dep")" || ! same "$cm_management" "$expected_management"; then die 'post-write identity/configuration drift'; fi
running_matches || die 'active owned ready dispatcher configuration does not match'
if ! read_state || ! same "$cm" "$expected_cm" || ! same "$(stable_dep "$dep")" "$(stable_dep "$expected_dep")" || ! same "$cm_management" "$expected_management"; then die 'state changed during pod verification'; fi
after="$snapshot" status=applied
