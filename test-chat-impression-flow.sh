#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${API:-http://localhost:7101}"
QDRANT_URL="${QDRANT_URL:-http://localhost:6335}"
REDIS_CONTAINER="${REDIS_CONTAINER:-chat-like-human-redis-dev}"
REDIS_PASSWORD="${REDIS_PASSWORD:-zxr120713.}"
QUEUE_KEY_PREFIX="bull:chat-summary-queue"
PASSWORD="${PASSWORD:-test123}"
TIMESTAMP="$(date +%s)"
USERNAME="impression_flow_${TIMESTAMP}"
POLL_INTERVAL=3
POLL_TIMEOUT=180

json_value() {
  local path="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); cur=data
for part in '${path}'.split('.'):
    cur = cur[int(part)] if part.isdigit() else cur[part]
print(cur)"
}

redis_cmd() {
  docker exec "${REDIS_CONTAINER}" redis-cli -a "${REDIS_PASSWORD}" --raw "$@" 2>/dev/null
}

get_latest_job_id() {
  redis_cmd GET "${QUEUE_KEY_PREFIX}:id" | tr -d '\r'
}

get_job_data() {
  local job_id="$1"
  redis_cmd HGET "${QUEUE_KEY_PREFIX}:${job_id}" data
}

register_user() {
  local payload
  payload="$(python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}))' "${USERNAME}" "${PASSWORD}")"
  curl -s -X POST "${API}/api/register" \
    -H "Content-Type: application/json" \
    -d "${payload}"
}

send_message() {
  local token="$1"
  local message="$2"
  local session_id="${3:-}"
  local payload

  if [[ -n "${session_id}" ]]; then
    payload="$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "sessionId": sys.argv[2]}))' "${message}" "${session_id}")"
  else
    payload="$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1]}))' "${message}")"
  fi

  curl -s -X POST "${API}/api/chat" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "${payload}"
}

wait_for_job_after() {
  local previous_job_id="$1"
  local elapsed=0
  local latest=""

  while (( elapsed <= POLL_TIMEOUT )); do
    latest="$(get_latest_job_id || true)"
    if [[ -n "${latest}" && "${latest}" =~ ^[0-9]+$ && "${latest}" -gt "${previous_job_id}" ]]; then
      echo "${latest}"
      return 0
    fi

    sleep "${POLL_INTERVAL}"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  return 1
}

wait_for_impressions() {
  local user_id="$1"
  local min_count="$2"
  local elapsed=0
  local result=""

  while (( elapsed <= POLL_TIMEOUT )); do
    result="$(curl -s "${API}/api/impressions/${user_id}")"
    if RESULT_JSON="${result}" MIN_COUNT="${min_count}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
impressions = data.get('impressions', [])

if len(impressions) < int(os.environ['MIN_COUNT']):
    raise SystemExit(1)

for item in impressions:
    if not item.get('content'):
        raise SystemExit(1)
    if not item.get('memoryDate'):
        raise SystemExit(1)
    if item.get('salienceScore') is None:
        raise SystemExit(1)
    if not item.get('lastActivatedAt'):
        raise SystemExit(1)
PY
    then
      printf '%s' "${result}"
      return 0
    fi

    sleep "${POLL_INTERVAL}"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  return 1
}

wait_for_impression_update() {
  local user_id="$1"
  local impression_id="$2"
  local previous_salience="$3"
  local expected_count="$4"
  local elapsed=0
  local result=""

  while (( elapsed <= POLL_TIMEOUT )); do
    result="$(curl -s "${API}/api/impressions/${user_id}")"
    if RESULT_JSON="${result}" IMPRESSION_ID="${impression_id}" PREV_SALIENCE="${previous_salience}" EXPECTED_COUNT="${expected_count}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
impressions = data.get('impressions', [])

if len(impressions) != int(os.environ['EXPECTED_COUNT']):
    raise SystemExit(1)

target = next((item for item in impressions if item.get('id') == os.environ['IMPRESSION_ID']), None)
if not target:
    raise SystemExit(1)

if float(target.get('salienceScore', 0)) <= float(os.environ['PREV_SALIENCE']):
    raise SystemExit(1)
PY
    then
      printf '%s' "${result}"
      return 0
    fi

    sleep "${POLL_INTERVAL}"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  return 1
}

print_banner() {
  echo "============================================"
  echo "  Chat Impression Flow Test"
  echo "============================================"
  echo "API: ${API}"
  echo "Qdrant: ${QDRANT_URL}"
  echo "Redis container: ${REDIS_CONTAINER}"
  echo
}

print_banner

echo "Step 1: Register test user ${USERNAME}"
REGISTER_RESULT="$(register_user)"
TOKEN="$(printf '%s' "${REGISTER_RESULT}" | json_value token)"
USER_ID="$(printf '%s' "${REGISTER_RESULT}" | json_value user.id)"
echo "  user_id = ${USER_ID}"
echo

JOB_ID_BEFORE="$(get_latest_job_id || true)"
JOB_ID_BEFORE="${JOB_ID_BEFORE:-0}"

echo "Step 2: Send first storyline batch and verify message persistence"
SESSION_ID=""
FIRST_BATCH_MESSAGES=(
  "我最近在认真准备去苏州开一家小面包店，先想把产品定位定下来。"
  "我现在更想主打可颂和酸种，但还拿不准早餐和下午茶哪个客群更稳。"
  "我看了工业园区和老城区两个铺面，工业园区通勤人流更集中。"
  "启动资金我和合伙人估算大概二十五万，正在拆设备和租金预算。"
  "我想把这件事先做成一个最小可行版本，再决定要不要正式辞职。"
)

for message in "${FIRST_BATCH_MESSAGES[@]}"; do
  RESPONSE="$(send_message "${TOKEN}" "${message}" "${SESSION_ID}")"
  SESSION_ID="$(printf '%s' "${RESPONSE}" | json_value sessionId)"
  sleep 1
done

SESSION_MESSAGES="$(curl -s "${API}/api/chat-sessions/${SESSION_ID}/messages" -H "Authorization: Bearer ${TOKEN}")"
printf '%s' "${SESSION_MESSAGES}" | RESULT_JSON="${SESSION_MESSAGES}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
messages = data.get('messages', [])
if len(messages) < 10:
    raise SystemExit("FAIL: expected at least 10 stored chat messages after 5 rounds")
print(f"  chat_messages via API = {len(messages)}")
PY
echo

echo "Step 3: Verify flush job payload in Redis/BullMQ"
FIRST_JOB_ID="$(wait_for_job_after "${JOB_ID_BEFORE}")"
FIRST_JOB_DATA="$(get_job_data "${FIRST_JOB_ID}")"
RESULT_JSON="${FIRST_JOB_DATA}" USER_ID="${USER_ID}" python3 - <<'PY'
import json
import os

job = json.loads(os.environ['RESULT_JSON'])
if job.get('userId') != int(os.environ['USER_ID']):
    raise SystemExit("FAIL: job userId mismatch")
messages = job.get('messages', [])
if not messages or len(messages) > 15:
    raise SystemExit("FAIL: invalid job message length")
if any('messageId' not in item for item in messages):
    raise SystemExit("FAIL: queue payload missing messageId")
if any('timestamp' not in item for item in messages):
    raise SystemExit("FAIL: queue payload missing timestamp")
if not job.get('date'):
    raise SystemExit("FAIL: queue payload missing memory date")
print(f"  job_id = {job.get('batchId')}")
print(f"  queue messages = {len(messages)}")
print(f"  memoryDate = {job.get('date')}")
PY
echo

echo "Step 4: Verify Qdrant impression payload and message links"
FIRST_IMPRESSIONS="$(wait_for_impressions "${USER_ID}" 1)"
FIRST_IMPRESSION_ID="$(RESULT_JSON="${FIRST_IMPRESSIONS}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
print(data['impressions'][0]['id'])
PY
)"
FIRST_IMPRESSION_COUNT="$(RESULT_JSON="${FIRST_IMPRESSIONS}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
print(len(data['impressions']))
PY
)"
FIRST_SALIENCE="$(RESULT_JSON="${FIRST_IMPRESSIONS}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
print(data['impressions'][0]['salienceScore'])
PY
)"

QDRANT_SCROLL_PAYLOAD="$(python3 - "${USER_ID}" <<'PY'
import json
import sys

print(json.dumps({
    "limit": 20,
    "with_payload": True,
    "filter": {
        "must": [
            {
                "key": "userId",
                "match": {"value": int(sys.argv[1])},
            },
        ],
    },
}))
PY
)"
QDRANT_RESULT="$(curl -s -X POST "${QDRANT_URL}/collections/user_impressions/points/scroll" \
  -H "Content-Type: application/json" \
  -d "${QDRANT_SCROLL_PAYLOAD}")"
RESULT_JSON="${QDRANT_RESULT}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
points = data.get('result', {}).get('points', [])
if not points:
    raise SystemExit("FAIL: no Qdrant points found")
payload = points[0].get('payload') or {}
required = ['content', 'memoryDate', 'originType', 'salienceScore', 'lastActivatedAt']
missing = [field for field in required if payload.get(field) in (None, '')]
if missing:
    raise SystemExit(f"FAIL: Qdrant payload missing fields: {missing}")
print(f"  qdrant points = {len(points)}")
print(f"  qdrant memoryDate = {payload.get('memoryDate')}")
print(f"  qdrant salienceScore = {payload.get('salienceScore')}")
PY

IMPRESSION_MESSAGES="$(curl -s "${API}/api/impression-messages/${FIRST_IMPRESSION_ID}")"
RESULT_JSON="${IMPRESSION_MESSAGES}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
messages = data.get('messages', [])
if not messages:
    raise SystemExit("FAIL: impression message links not found")
linked = [item.get('message') for item in messages if item.get('message')]
if not linked:
    raise SystemExit("FAIL: linked messages missing content")
print(f"  linked messages = {len(linked)}")
PY
echo

echo "Step 5: Send same-day continuation batch and verify leaf update"
JOB_ID_BEFORE_SECOND="${FIRST_JOB_ID}"
SECOND_BATCH_MESSAGES=(
  "我继续想昨天那个面包店计划，现在更偏向先服务工业园区上班族的早餐需求。"
  "我准备把产品先收敛到可颂、酸种和两款稳定出餐的三明治。"
  "预算里我把设备和首月现金流拆开了，发现最紧的是前两个月的人手安排。"
  "我想先把铺面和成本模型跑通，再决定辞职时间点。"
  "我也在想是不是先试营业两周，根据复购再扩充下午茶产品线。"
)

for message in "${SECOND_BATCH_MESSAGES[@]}"; do
  RESPONSE="$(send_message "${TOKEN}" "${message}" "${SESSION_ID}")"
  SESSION_ID="$(printf '%s' "${RESPONSE}" | json_value sessionId)"
  sleep 1
done

SECOND_JOB_ID="$(wait_for_job_after "${JOB_ID_BEFORE_SECOND}")"
SECOND_JOB_DATA="$(get_job_data "${SECOND_JOB_ID}")"
RESULT_JSON="${SECOND_JOB_DATA}" python3 - <<'PY'
import json
import os

job = json.loads(os.environ['RESULT_JSON'])
print(f"  second batch job = {job.get('batchId')}")
print(f"  second batch messages = {len(job.get('messages', []))}")
PY

UPDATED_IMPRESSIONS="$(wait_for_impression_update "${USER_ID}" "${FIRST_IMPRESSION_ID}" "${FIRST_SALIENCE}" "${FIRST_IMPRESSION_COUNT}")"
RESULT_JSON="${UPDATED_IMPRESSIONS}" IMPRESSION_ID="${FIRST_IMPRESSION_ID}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
target = next(item for item in data['impressions'] if item.get('id') == os.environ['IMPRESSION_ID'])
print(f"  updated salienceScore = {target.get('salienceScore')}")
print(f"  updated lastActivatedAt = {target.get('lastActivatedAt')}")
PY

echo
echo "PASS: chat_messages -> queue -> worker -> Qdrant -> impression_message_links -> same-day update flow verified"
echo "User ID: ${USER_ID}"
