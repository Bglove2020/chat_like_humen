#!/bin/bash
# Summary integration test:
# two complete stories are told in an interleaved way across two flushes.
# Validates:
# 1) phase 1 creates exactly 2 topic summaries
# 2) phase 2 updates the same 2 summaries instead of creating new ones
# 3) final summaries still retain key facts for both stories

set -euo pipefail

API="${API:-http://localhost:7101}"
QDRANT="${QDRANT:-http://localhost:6335}"
PASSWORD="test123"
TIMESTAMP="$(date +%s)"
USERNAME="story_mix_test_${TIMESTAMP}"
TODAY="$(date -u +%Y-%m-%d)"
POLL_INTERVAL=5
POLL_TIMEOUT=180

echo "============================================"
echo "  Interleaved Story Summary Test"
echo "============================================"
echo "API:    ${API}"
echo "Qdrant: ${QDRANT}"
echo "Date:   ${TODAY}"
echo

json_value() {
  local path="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); parts='${path}'.split('.'); cur=data
for p in parts:
    cur = cur[p] if not p.isdigit() else cur[int(p)]
print(cur)"
}

build_json_payload() {
  local message="$1"
  python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1]}, ensure_ascii=False))' "$message"
}

send_message() {
  local label="$1"
  local message="$2"
  local payload
  local result
  local reply

  payload="$(build_json_payload "$message")"
  result="$(curl -s -X POST "${API}/api/chat" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${payload}")"
  reply="$(printf '%s' "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reply','NO REPLY')[:100])")"

  echo "[${label}] USER: ${message}"
  echo "      AI: ${reply}"
  echo
}

query_points() {
  curl -s -X POST "${QDRANT}/collections/user_impressions/points/scroll" \
    -H "Content-Type: application/json" \
    -d "{
      \"limit\": 50,
      \"with_payload\": true,
      \"filter\": {
        \"must\": [
          {\"key\": \"userId\", \"match\": {\"value\": ${USER_ID}}},
          {\"key\": \"date\", \"match\": {\"value\": \"${TODAY}\"}}
        ]
      }
    }"
}

print_points() {
  local result="$1"
  RESULT_JSON="$result" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
points = data.get('result', {}).get('points', [])
points.sort(key=lambda p: p.get('payload', {}).get('createdAt', ''))

if not points:
    print("  (no summaries)")
    raise SystemExit(0)

for idx, point in enumerate(points, start=1):
    payload = point.get('payload', {})
    print(f"  Summary #{idx}")
    print(f"    id: {point.get('id')}")
    print(f"    action: {payload.get('action', 'N/A')}")
    print(f"    originType: {payload.get('originType', 'N/A')}")
    print(f"    sourceImpressionId: {payload.get('sourceImpressionId', 'N/A')}")
    print(f"    createdAt: {payload.get('createdAt', 'N/A')}")
    print(f"    content: {payload.get('summaryText', '')}")
PY
}

wait_for_phase() {
  local phase="$1"
  local expected_count="$2"
  local expected_action="$3"
  local expected_ids="${4:-}"
  local elapsed=0
  local result
  local status

  echo "Waiting for ${phase} (timeout: ${POLL_TIMEOUT}s)..."

  while (( elapsed <= POLL_TIMEOUT )); do
    result="$(query_points)"
    status="$(RESULT_JSON="$result" python3 - "$expected_count" "$expected_action" "$expected_ids" <<'PY'
import json
import os
import sys

expected_count = int(sys.argv[1])
expected_action = sys.argv[2]
expected_ids = [x for x in sys.argv[3].split(',') if x]

data = json.loads(os.environ['RESULT_JSON'])
points = data.get('result', {}).get('points', [])
points.sort(key=lambda p: str(p.get('id')))

if len(points) != expected_count:
    print(f"count={len(points)}")
    raise SystemExit(1)

actions = [p.get('payload', {}).get('action', '') for p in points]
if expected_action and any(action != expected_action for action in actions):
    print("actions=" + ",".join(actions))
    raise SystemExit(1)

if expected_ids:
    ids = [str(p.get('id')) for p in points]
    if ids != sorted(expected_ids):
        print("ids=" + ",".join(ids))
        raise SystemExit(1)

print("ready")
PY
)" && {
      echo "  ${phase} is ready after ${elapsed}s"
      LAST_QUERY_RESULT="$result"
      return 0
    }

    echo "  ${phase} not ready yet (${status}), retrying in ${POLL_INTERVAL}s..."
    sleep "${POLL_INTERVAL}"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "Timed out waiting for ${phase}"
  LAST_QUERY_RESULT="$result"
  return 1
}

validate_final_content() {
  local result="$1"
  RESULT_JSON="$result" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
points = data.get('result', {}).get('points', [])
texts = [p.get('payload', {}).get('summaryText', '') for p in points]

if len(texts) != 2:
    print(f"FAIL: expected 2 final summaries, got {len(texts)}")
    raise SystemExit(1)

joined = "\n".join(texts)

bakery_markers = ['面包', '可颂', '酸种', '工业园区', '创业', '铺面']
running_markers = ['马拉松', '膝', '康复', '半马', '配速', '训练']

bakery_hits = [marker for marker in bakery_markers if marker in joined]
running_hits = [marker for marker in running_markers if marker in joined]

if len(bakery_hits) < 2:
    print("FAIL: bakery story lost too much detail")
    print("bakery_hits=", bakery_hits)
    raise SystemExit(1)

if len(running_hits) < 2:
    print("FAIL: running story lost too much detail")
    print("running_hits=", running_hits)
    raise SystemExit(1)

print("PASS: final summaries retain both story lines")
print("bakery_hits=", bakery_hits)
print("running_hits=", running_hits)
PY
}

echo "Step 1: Register test user ${USERNAME}"
REGISTER_PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}))' "${USERNAME}" "${PASSWORD}")"
REGISTER_RESULT="$(curl -s -X POST "${API}/api/register" \
  -H "Content-Type: application/json" \
  -d "${REGISTER_PAYLOAD}")"
TOKEN="$(printf '%s' "$REGISTER_RESULT" | json_value token)"
USER_ID="$(printf '%s' "$REGISTER_RESULT" | json_value user.id)"
echo "  user_id = ${USER_ID}"
echo

echo "Step 2: Send first five user turns (flush #1)"
send_message "A1" "我最近在认真考虑离职，因为想在苏州自己开一家小面包店。"
send_message "B1" "另外我也在准备今年十月的成都马拉松，从二月开始每周跑四次。"
send_message "A2" "离职不是一时冲动，我已经看了两个铺面，一个在工业园区一个在老城区。"
send_message "B2" "跑步这边我最长已经跑到18公里了，不过右膝外侧最近总是有点疼。"
send_message "A3" "我和合伙人把预算也算了，启动资金大概要二十五万，主打可颂和酸种。"

wait_for_phase "phase 1" 2 "create"
PHASE1_RESULT="${LAST_QUERY_RESULT}"
echo
echo "Phase 1 summaries:"
print_points "$PHASE1_RESULT"
PHASE1_IDS="$(RESULT_JSON="$PHASE1_RESULT" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
points = data.get('result', {}).get('points', [])
ids = sorted(str(p.get('id')) for p in points)
print(",".join(ids))
PY
)"
echo

echo "Step 3: Send next five user turns (flush #2)"
send_message "B3" "为了比赛我最近把长距离配速从七分提到了六分二十，还加了力量训练。"
send_message "A4" "我更倾向工业园区那家店，因为附近写字楼多，早餐和下午茶客流会更稳定。"
send_message "B4" "但是上周雨跑以后膝盖更明显了，所以我在纠结要不要先去做运动康复。"
send_message "A5" "我已经跟爸妈谈过，他们担心我辞职创业太冒险，但愿意借我一部分启动资金。"
send_message "B5" "如果恢复得不好，我可能把目标从全马完赛改成半马，至少别把伤拖严重。"

wait_for_phase "phase 2" 2 "update" "${PHASE1_IDS}"
PHASE2_RESULT="${LAST_QUERY_RESULT}"
echo
echo "Phase 2 summaries:"
print_points "$PHASE2_RESULT"
echo

echo "Step 4: Validate final summary content"
validate_final_content "$PHASE2_RESULT"
echo
echo "PASS: interleaved stories were merged into the same 2 summaries and updated in place"
echo "User ID: ${USER_ID}"
