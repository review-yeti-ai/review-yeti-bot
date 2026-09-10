#!/usr/bin/env bash
# Real helper/resolver/jq; only external binaries are fake. API applies patches.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
helper="${WORKER_HELPER_UNDER_TEST:-$script_dir/advance-review-worker.sh}"
root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/bin"
source_sha=9999999999999999999999999999999999999999
old="ghcr.io/review-yeti-ai/review-yeti-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
target="ghcr.io/review-yeti-ai/review-yeti-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
dispatcher="ghcr.io/review-yeti-ai/review-yeti-bot@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export FAKE_SOURCE="$source_sha" FAKE_TARGET="$target" FAKE_OLD="$old"
cat >"$root/bin/crane" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CASE_DIR/crane.log"
[[ $# == 2 ]] || exit 90
case "$1" in
  digest)
    [[ "$2" == "${FAKE_TARGET%@*}:$FAKE_SOURCE" ]] || exit 91
    [[ "$FAULT" != provenance ]] || exit 1
    printf '%s\n' "${FAKE_TARGET##*@}"
    ;;
  manifest)
    [[ "$2" == "$FAKE_TARGET" ]] || exit 92
    case "$FAULT" in
      single) printf '%s\n' '{"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{}}' ;;
      arch) printf '%s\n' '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"windows","architecture":"arm64"}}]}' ;;
      malformed) printf '{}{}' ;;
      *) printf '%s\n' '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}' ;;
    esac
    ;;
  *) exit 93 ;;
esac
FAKE
cat >"$root/bin/kubectl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3 $4 $5" == '--context fixture-context --namespace ct-review-system --request-timeout=30s' ]] || exit 90
shift 5
printf '%s\n' "$*" >>"$CASE_DIR/calls"
change() {
  jq "$2" "$CASE_DIR/$1.json" >"$CASE_DIR/change"
  mv "$CASE_DIR/change" "$CASE_DIR/$1.json"
}
case "$1 $2" in
  'get configmap'|'get deployment')
    [[ "$3 $4 $5" == 'ct-review-job-dispatcher -o json' ]] || exit 91
    if [[ -e "$CASE_DIR/patched-configmap" ]]; then
      case "$FAULT" in
        readback) exit 1 ;;
        cm-drift) change configmap '.data.GATEWAY="changed" | .metadata.resourceVersion="99"' ;;
        dep-drift) change deployment '.spec.replicas=2 | .metadata.resourceVersion="99"' ;;
      esac
    fi
    cat "$CASE_DIR/$2.json"
    ;;
  'patch configmap'|'patch deployment')
    kind="$2"
    [[ "$3 $4 $5 $6" == 'ct-review-job-dispatcher --type=json --field-manager=review-yeti-worker-upgrade --patch' && "$8 $9" == '-o json' ]] || exit 92
    [[ -f "$INTENT" ]] || exit 93
    jq -e '.status == "intent" and .after == null' "$INTENT" >/dev/null || exit 94
    [[ "$(ls -l "$INTENT" | cut -c1-10)" == '-rw-------' ]] || exit 95
    printf '%s\n' "$7" >"$CASE_DIR/patch-$kind.json"
    case "$kind:$FAULT" in configmap:reject|deployment:restart-reject) exit 1 ;; esac
    case "$kind:$FAULT" in
      configmap:cas-race) change configmap '.metadata.resourceVersion="999" | .data.GATEWAY="concurrent"' ;;
      configmap:uid-race) change configmap '.metadata.uid="replaced"' ;;
      configmap:image-race) change configmap '.data.REVIEW_JOB_WORKER_IMAGE="foreign"' ;;
      deployment:restart-race) change deployment '.metadata.resourceVersion="999" | .spec.replicas=2' ;;
    esac
    jq --argjson patch "$7" '
      def pointer: split("/")[1:] | map(gsub("~1";"/") | gsub("~0";"~") | if test("^[0-9]+$") then tonumber else . end);
      reduce $patch[] as $p (.;
        ($p.path | pointer) as $path |
        if $p.op == "test" then
          if getpath($path) == $p.value then . else error("CAS rejected") end
        elif $p.op == "replace" then
          if getpath($path) == null then error("missing replace path") else setpath($path; $p.value) end
        elif $p.op == "add" then setpath($path; $p.value)
        else error("unsupported patch") end)
      | .metadata.resourceVersion = ((.metadata.resourceVersion|tonumber)+1|tostring)
      | if .kind == "Deployment" then .metadata.generation += 1 else . end
    ' "$CASE_DIR/$kind.json" >"$CASE_DIR/patched" || exit 1
    mv "$CASE_DIR/patched" "$CASE_DIR/$kind.json"
    touch "$CASE_DIR/patched-$kind"
    case "$kind:$FAULT" in configmap:lost-ack|deployment:restart-lost-ack) exit 1 ;; esac
    cat "$CASE_DIR/$kind.json"
    ;;
  'rollout status')
    [[ "$3 $4" == 'deployment/ct-review-job-dispatcher --timeout=180s' ]] || exit 96
    [[ "$FAULT" != rollout ]] || exit 1
    cp "$CASE_DIR/configmap.json" "$CASE_DIR/pod-config.json"
    cp "$CASE_DIR/deployment.json" "$CASE_DIR/pod-deployment.json"
    if [[ "$FAULT" == post-drift ]]; then change configmap '.data.GATEWAY="post-rollout" | .metadata.resourceVersion="99"'; fi
    if [[ "$FAULT" == receipt-race ]]; then printf occupied >"$CASE_DIR/receipt"; fi
    ;;
  'get replicasets')
    [[ "$3 $4 $5 $6" == '-l app.kubernetes.io/name=ct-review-job-dispatcher -o json' ]] || exit 97
    jq --arg fault "$FAULT" '{items:[{metadata:{uid:"rs-uid",ownerReferences:[{uid:(if $fault=="foreign-owner" then "foreign-deployment" else .metadata.uid end),kind:"Deployment",controller:true}]},spec:{template:.spec.template}}]}' "$CASE_DIR/pod-deployment.json"
    ;;
  'get pods')
    [[ "$3 $4 $5 $6" == '-l app.kubernetes.io/name=ct-review-job-dispatcher -o json' ]] || exit 97
    jq '{items:[{metadata:{name:"dispatcher-pod",uid:"pod-uid",annotations:.spec.template.metadata.annotations,ownerReferences:[{uid:"rs-uid",kind:"ReplicaSet",controller:true}]},spec:.spec.template.spec,status:{phase:"Running",conditions:[{type:"Ready",status:"True"}],containerStatuses:[{name:"review-job-dispatcher",ready:true}]}}]}' "$CASE_DIR/pod-deployment.json"
    ;;
  'exec dispatcher-pod')
    [[ "$3 $4 $5 $6 $7 $8" == '--container review-job-dispatcher -- sh -c printf "%s" "$REVIEW_JOB_WORKER_IMAGE"' ]] || exit 98
    [[ "$FAULT" != exec-failure ]] || exit 1
    if [[ "$FAULT" == verify-drift ]]; then change deployment '.spec.template.spec.serviceAccountName="drift" | .metadata.resourceVersion="99"'; fi
    if [[ "$FAULT" == stale ]]; then printf '%s' "$FAKE_OLD"; else jq -jr '.data.REVIEW_JOB_WORKER_IMAGE' "$CASE_DIR/pod-config.json"; fi
    ;;
  *) exit 99 ;;
esac
FAKE
chmod +x "$root/bin/"*
export PATH="$root/bin:$PATH"
passed=0
fail() { echo "FAIL: $*" >&2; [[ ! -f "$CASE_DIR/err" ]] || tail -8 "$CASE_DIR/err" >&2; exit 1; }
ok() { passed=$((passed+1)); echo "ok - $*"; }
fresh() {
  CASE_DIR="$(mktemp -d "$root/case.XXXXXX")"; export CASE_DIR
  export FAULT="" FAKE_TARGET="$target" INTENT="$CASE_DIR/receipt.intent"
  jq -n --arg worker "$old" '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"ct-review-job-dispatcher",namespace:"ct-review-system",uid:"cm-uid",resourceVersion:"23",labels:{keep:"yes"}},data:{REVIEW_JOB_WORKER_IMAGE:$worker,REVIEW_JOB_RUNNER_MODE:"prebaked",REVIEW_JOB_DISPATCH_ENABLED:"true",GATEWAY:"SECRET_SENTINEL",ENABLED:"true",AUTH:"SECRET_SENTINEL"}}' >"$CASE_DIR/configmap.json"
  jq -n --arg image "$dispatcher" '{apiVersion:"apps/v1",kind:"Deployment",metadata:{name:"ct-review-job-dispatcher",namespace:"ct-review-system",uid:"dep-uid",resourceVersion:"17",generation:4},spec:{replicas:1,selector:{matchLabels:{"app.kubernetes.io/name":"ct-review-job-dispatcher"}},template:{metadata:{annotations:{"keep":"yes"}},spec:{serviceAccountName:"keep",containers:[{name:"review-job-dispatcher",image:$image,envFrom:[{configMapRef:{name:"ct-review-job-dispatcher"}}],env:[{name:"AUTH",valueFrom:{secretKeyRef:{name:"keep",key:"auth"}}}]}]}}},status:{observedGeneration:4,readyReplicas:1}}' >"$CASE_DIR/deployment.json"
  cp "$CASE_DIR/configmap.json" "$CASE_DIR/pod-config.json"
  cp "$CASE_DIR/deployment.json" "$CASE_DIR/pod-deployment.json"
}
edit() { jq "$2" "$CASE_DIR/$1.json" >"$CASE_DIR/change"; mv "$CASE_DIR/change" "$CASE_DIR/$1.json"; }
run() { bash "$helper" --context fixture-context --source-sha "$source_sha" --target-image "$FAKE_TARGET" "$@" >"$CASE_DIR/out" 2>"$CASE_DIR/err"; }
plan() { run "$@" || fail plan; cp "$CASE_DIR/out" "$CASE_DIR/plan"; }
apply() { run --expected-state "$CASE_DIR/plan" --apply --receipt "$CASE_DIR/receipt"; }
no_write() { [[ ! -e "$CASE_DIR/patch-configmap.json" && ! -e "$CASE_DIR/patch-deployment.json" && ! -e "$INTENT" ]] || fail 'unexpected write/intent'; }
refuse() { if apply; then fail 'unexpected success'; fi; }
status_is() { jq -e --arg s "$1" '.status==$s' "$CASE_DIR/receipt" >/dev/null || fail "status $1"; }
fresh; plan
jq -e '.schema=="review-yeti-worker-plan.v1" and .before.configmap.uid=="cm-uid" and .before.deployment.resourceVersion=="17" and .action=="update-and-restart"' "$CASE_DIR/plan" >/dev/null
no_write
! grep -q SECRET_SENTINEL "$CASE_DIR/out" || fail 'plan leaked configuration'
ok 'default plan binds exact objects and protected hashes without writes'
fresh
if bash "$helper" "$source_sha" >"$CASE_DIR/out" 2>"$CASE_DIR/err"; then fail 'missing context/target accepted'; fi
no_write; ok 'legacy positional invocation never implicitly applies'
fresh; edit configmap '.data.REVIEW_JOB_DISPATCH_ENABLED="false"'
if run; then fail 'disabled dispatcher accepted'; fi
no_write; ok 'disabled dispatch mode cannot be activated by a worker change'
fresh; edit deployment '.spec.template.spec.containers[0].env += [{name:"REVIEW_JOB_WORKER_IMAGE",value:"override"}]'
if run; then fail 'shadowed worker configuration accepted'; fi
no_write; ok 'dispatcher must actually consume the owned worker ConfigMap'
fresh; edit deployment '.spec.template.spec.containers[0].envFrom += [{secretRef:{name:"shadow"}}]'
if run; then fail 'additional potentially shadowing envFrom accepted'; fi
no_write; ok 'unknown envFrom override cannot falsify prebaked admission'
fresh; plan; apply || fail apply; status_is applied
jq -e --arg image "$target" '.data.REVIEW_JOB_WORKER_IMAGE==$image and .data.GATEWAY=="SECRET_SENTINEL" and .data.AUTH=="SECRET_SENTINEL" and .data.ENABLED=="true" and .metadata.resourceVersion=="24"' "$CASE_DIR/configmap.json" >/dev/null
jq -e --arg image "$dispatcher" '.spec.replicas==1 and .spec.template.spec.containers[0].image==$image and .spec.template.spec.serviceAccountName=="keep" and .metadata.generation==5 and .spec.template.metadata.annotations.keep=="yes"' "$CASE_DIR/deployment.json" >/dev/null
jq -e '[.[]|select(.op!="test")]|length==1 and .[0].op=="replace" and .[0].path=="/data/REVIEW_JOB_WORKER_IMAGE"' "$CASE_DIR/patch-configmap.json" >/dev/null
jq -e '[.[]|select(.op!="test")]|length==1 and .[0].path=="/spec/template/metadata/annotations"' "$CASE_DIR/patch-deployment.json" >/dev/null
[[ "$(grep -c '^patch ' "$CASE_DIR/calls")" == 2 ]] || fail 'extra write'
! grep -q SECRET_SENTINEL "$CASE_DIR/receipt" || fail 'receipt leaked configuration'
if [[ -n "${WORKER_TEST_EVIDENCE_DIR:-}" ]]; then
  mkdir "$WORKER_TEST_EVIDENCE_DIR"
  cp "$CASE_DIR/plan" "$CASE_DIR/receipt" "$INTENT" "$CASE_DIR/patch-configmap.json" "$CASE_DIR/patch-deployment.json" "$WORKER_TEST_EVIDENCE_DIR/"
fi
ok 'only worker key and guarded restart marker change; private intent precedes CAS'
for fault in provenance single arch malformed; do
  fresh; export FAULT="$fault"; if run; then fail "$fault accepted"; fi; no_write
  ok "$fault fails closed before cluster mutation"
done
for mutation in 'configmap|.metadata.uid="other"' 'configmap|.metadata.resourceVersion="25"' 'configmap|.data.REVIEW_JOB_WORKER_IMAGE="bad"' 'configmap|.data.GATEWAY="changed"' 'configmap|.data.REVIEW_JOB_RUNNER_MODE="source"' 'deployment|.metadata.uid="other"' 'deployment|.metadata.resourceVersion="19"' 'deployment|.metadata.generation=5' 'deployment|.spec.template.spec.containers[0].image="bad"' 'deployment|.spec.replicas=0' 'deployment|.spec.template.spec.containers[0].env=[]'; do
  fresh; plan; edit "${mutation%%|*}" "${mutation#*|}"; refuse; no_write
  ok "stale expected state rejected: $mutation"
done
for fault in reject lost-ack cas-race uid-race image-race restart-reject restart-lost-ack restart-race readback cm-drift dep-drift rollout post-drift stale foreign-owner verify-drift exec-failure; do
  fresh; plan; export FAULT="$fault"; refuse
  [[ -f "$INTENT" ]] || fail "$fault lost intent"
  jq -e '.status!="applied" and .status!="noop"' "$CASE_DIR/receipt" >/dev/null
  calls="$(grep -c '^patch ' "$CASE_DIR/calls")"
  [[ "$calls" -le 2 ]] || fail "$fault retried"
  case "$fault" in
    reject|cas-race|uid-race|image-race) [[ ! -e "$CASE_DIR/patched-configmap" ]] || fail 'rejected CAS changed bytes' ;;
    readback|cm-drift|dep-drift) [[ "$calls" == 1 ]] || fail 'restarted after known drift/unreadable state' ;;
    restart-race) [[ ! -e "$CASE_DIR/patched-deployment" ]] || fail 'rejected restart CAS changed bytes' ;;
    lost-ack) [[ -e "$CASE_DIR/patched-configmap" && "$calls" == 1 ]] || fail 'lost ack retried' ;;
    restart-lost-ack) [[ -e "$CASE_DIR/patched-deployment" ]] || fail 'restart lost ack had no effect' ;;
    foreign-owner) ! grep -q '^exec ' "$CASE_DIR/calls" || fail 'executed against foreign dispatcher' ;;
  esac
  ok "$fault retains truthful failure/intent without retry/rollback"
done
fresh; plan; export FAULT=receipt-race; refuse
[[ -f "$INTENT" && "$(cat "$CASE_DIR/receipt")" == occupied ]] || fail 'receipt race overwrote data or lost intent'
! grep -q verified "$CASE_DIR/out" || fail 'announced success before persisting receipt'
ok 'outcome receipt race fails without overwrite or success announcement'
fresh; edit configmap ".data.REVIEW_JOB_WORKER_IMAGE=\"$target\""; cp "$CASE_DIR/configmap.json" "$CASE_DIR/pod-config.json"
plan; apply || fail noop; status_is noop; no_write
ok 'matching key and owned ready pods is a real no-write noop'
fresh; edit configmap ".data.REVIEW_JOB_WORKER_IMAGE=\"$target\""
plan; jq -e '.action=="restart"' "$CASE_DIR/plan" >/dev/null
apply || fail 'stale pod restart'; status_is applied
[[ ! -e "$CASE_DIR/patch-configmap.json" && -e "$CASE_DIR/patch-deployment.json" ]] || fail 'reclaimed ownership'
ok 'matching key but stale pods uses guarded restart only'
fresh; edit deployment 'del(.spec.template.metadata.annotations)'
plan; apply || fail 'initial annotation creation'; status_is applied
ok 'checked-in template without annotations accepts only the new owned marker'
fresh; plan
if run --apply --expected-state "$CASE_DIR/plan" --receipt "$CASE_DIR/receipt" --dry-run; then fail 'conflicting modes accepted'; fi
no_write; ok 'conflicting dry-run/apply flags fail before mutation'
fresh
if run --apply --receipt "$CASE_DIR/receipt"; then fail 'unguarded apply accepted'; fi
no_write; ok 'apply requires caller-provided expected identities and versions'
fresh; plan
if run --apply --expected-state "$CASE_DIR/plan"; then fail 'missing receipt accepted'; fi
no_write; ok 'apply requires a new receipt path'
for bad_plan in empty duplicate context; do
  fresh; plan
  case "$bad_plan" in
    empty) : >"$CASE_DIR/plan" ;;
    duplicate) cp "$CASE_DIR/plan" "$CASE_DIR/extra"; cat "$CASE_DIR/extra" >>"$CASE_DIR/plan" ;;
    context) jq '.context="foreign-context"' "$CASE_DIR/plan" >"$CASE_DIR/extra"; mv "$CASE_DIR/extra" "$CASE_DIR/plan" ;;
  esac
  refuse; no_write; ok "$bad_plan expected state rejected"
done
for invalid in receipt intent symlink missing-parent; do
  fresh; plan
  case "$invalid" in receipt) printf occupied >"$CASE_DIR/receipt" ;; intent) printf occupied >"$INTENT" ;; symlink) ln -s "$CASE_DIR/missing" "$CASE_DIR/receipt" ;; esac
  if [[ "$invalid" == missing-parent ]]; then
    if run --expected-state "$CASE_DIR/plan" --apply --receipt "$CASE_DIR/missing/receipt"; then fail 'missing parent accepted'; fi
  else refuse; fi
  [[ ! -e "$CASE_DIR/patch-configmap.json" ]] || fail 'invalid receipt permitted write'
  ok "$invalid path refused before mutation"
done
for fault in reject lost-ack restart-reject restart-lost-ack none; do
  fresh; plan
  if [[ "$fault" == none ]]; then apply || fail upgrade; else export FAULT="$fault"; refuse; fi
  export FAULT=""
  retained="$INTENT"
  if [[ "$fault" == none ]]; then retained="$CASE_DIR/receipt"; fi
  export FAKE_TARGET="$old"
  plan --rollback "$retained"
  export INTENT="$CASE_DIR/recovery.intent"
  run --rollback "$retained" --expected-state "$CASE_DIR/plan" --apply --receipt "$CASE_DIR/recovery" || fail recovery
  if [[ "$fault" == reject ]]; then
    jq -e '.status=="noop" and .after.deployment.generation==.before.deployment.generation' "$CASE_DIR/recovery" >/dev/null
  else
    jq -e --arg image "$old" '.status=="applied" and .after.configmap.workerImage==$image and .after.deployment.generation > .before.deployment.generation' "$CASE_DIR/recovery" >/dev/null
  fi
  ok "fresh-state rollback recovers $fault without pretending to restore RV/generation"
done
for mutation in 'configmap|.data.AUTH="drift"' 'deployment|.metadata.uid="recreated"' 'deployment|.metadata.generation+=2' 'deployment|.spec.template.metadata.annotations["review-yeti.ai/worker-upgrade"]="foreign"'; do
  fresh; plan; apply || fail upgrade; retained="$INTENT"
  edit "${mutation%%|*}" "${mutation#*|}"; export FAKE_TARGET="$old"
  if run --rollback "$retained"; then fail 'unrelated drift recovered'; fi
  [[ "$(grep -c '^patch ' "$CASE_DIR/calls")" == 2 ]] || fail 'rollback unexpectedly wrote'
  ok "recovery rejects unrelated drift: $mutation"
done
fresh; plan; apply || fail upgrade
printf '{}{}' >"$CASE_DIR/bad-record"; export FAKE_TARGET="$old"
if run --rollback "$CASE_DIR/bad-record"; then fail 'malformed receipt accepted'; fi
[[ "$(grep -c '^patch ' "$CASE_DIR/calls")" == 2 ]] || fail 'malformed recovery wrote'
ok 'malformed or multi-document recovery records rejected'
for mutation in '.status="unknown"' '.reviewedSourceSha="main"' '.afterObserved=false' 'del(.before.configmap.resourceVersion)'; do
  fresh; plan; apply || fail upgrade
  jq "$mutation" "$CASE_DIR/receipt" >"$CASE_DIR/bad-record"; export FAKE_TARGET="$old"
  if run --rollback "$CASE_DIR/bad-record"; then fail "malformed receipt accepted: $mutation"; fi
  [[ "$(grep -c '^patch ' "$CASE_DIR/calls")" == 2 ]] || fail 'malformed record caused write'
  ok "recovery validates receipt contract: $mutation"
done
echo "advance-review-worker focused tests: $passed passed"
