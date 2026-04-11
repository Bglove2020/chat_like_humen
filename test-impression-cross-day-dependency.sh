#!/bin/bash
# Cross-day impression lineage test:
# 1) create a historical impression on yesterday's date
# 2) continue the same story today
# 3) verify the old impression is kept, a new today's impression is created,
#    and the new impression records its source lineage

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${API:-http://localhost:7101}"
PASSWORD="test123"
TIMESTAMP="$(date +%s)"
USERNAME="cross_day_impression_${TIMESTAMP}"
TODAY="$(date -u +%Y-%m-%d)"
YESTERDAY="$(date -u -d 'yesterday' +%Y-%m-%d)"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6380}"
REDIS_PASSWORD="${REDIS_PASSWORD:-zxr120713.}"
POLL_INTERVAL=5
POLL_TIMEOUT=360

json_value() {
  local path="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); parts='${path}'.split('.'); cur=data
for p in parts:
    cur = cur[p] if not p.isdigit() else cur[int(p)]
print(cur)"
}

build_yesterday_messages() {
  python3 - "$1" <<'PY'
import json
import sys

date = sys.argv[1]
messages = [
    {
        "role": "user",
        "content": "我最近在认真考虑离职去苏州开一家小面包店，现在主要在工业园区和老城区两个铺面之间犹豫。",
        "timestamp": f"{date}T09:00:00.000Z",
        "isNew": True,
    },
    {
        "role": "assistant",
        "content": "我建议先把两个铺面的客流结构和租金压力拆开看，别只看房租表面高低。",
        "timestamp": f"{date}T09:00:20.000Z",
        "isNew": True,
    },
    {
        "role": "user",
        "content": "我和合伙人初步估算过，启动资金大概二十五万，想先做可颂和酸种。",
        "timestamp": f"{date}T09:00:40.000Z",
        "isNew": True,
    },
    {
        "role": "assistant",
        "content": "我提醒他先把预算拆成租金、设备和现金流缓冲，再去比较两个铺面的回本节奏。",
        "timestamp": f"{date}T09:01:00.000Z",
        "isNew": True,
    },
]
print(json.dumps(messages, ensure_ascii=False))
PY
}

build_today_messages() {
  python3 - "$1" <<'PY'
import json
import sys

date = sys.argv[1]
messages = [
    {
        "role": "user",
        "content": "我今天又回到之前说的开面包店这件事上了，爸妈愿意借我一部分启动资金。",
        "timestamp": f"{date}T10:00:00.000Z",
        "isNew": True,
    },
    {
        "role": "assistant",
        "content": "我觉得这会明显减轻前期现金流压力，但还是建议把家庭借款和经营资金分开记账。",
        "timestamp": f"{date}T10:00:20.000Z",
        "isNew": True,
    },
    {
        "role": "user",
        "content": "所以我更偏向工业园区那家店，准备先做早餐和下午茶客群，再继续主打可颂和酸种。",
        "timestamp": f"{date}T10:00:40.000Z",
        "isNew": True,
    },
    {
        "role": "assistant",
        "content": "我认同先抓写字楼客流更稳，也提醒他把产品结构和高峰时段人手一起规划进去。",
        "timestamp": f"{date}T10:01:00.000Z",
        "isNew": True,
    },
]
print(json.dumps(messages, ensure_ascii=False))
PY
}

enqueue_job() {
  local job_date="$1"
  local label="$2"
  local messages_json="$3"

  (
    cd "${ROOT_DIR}/backend"
    USER_ID="${USER_ID}" \
    JOB_DATE="${job_date}" \
    JOB_LABEL="${label}" \
    REDIS_HOST="${REDIS_HOST}" \
    REDIS_PORT="${REDIS_PORT}" \
    REDIS_PASSWORD="${REDIS_PASSWORD}" \
    MESSAGES_JSON="${messages_json}" \
    node - <<'NODE'
const { Queue } = require('bullmq');

async function main() {
  const queue = new Queue('chat-summary-queue', {
    connection: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD,
    },
    prefix: 'bull',
  });

  const userId = Number(process.env.USER_ID);
  const date = process.env.JOB_DATE;
  const label = process.env.JOB_LABEL;
  const messages = JSON.parse(process.env.MESSAGES_JSON);

  const job = await queue.add('summary', {
    userId,
    date,
    batchId: `${userId}_${date}_${label}_${Date.now()}`,
    messages,
  });

  console.log(job.id);
  await queue.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
  )
}

query_impressions() {
  curl -s "${API}/api/impressions/${USER_ID}"
}

print_impressions() {
  local result="$1"
  RESULT_JSON="$result" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
impressions = data.get('impressions', [])

if not impressions:
    print("  (no impressions)")
    raise SystemExit(0)

for idx, impression in enumerate(impressions, start=1):
    print(f"  Impression #{idx}")
    print(f"    id: {impression.get('id')}")
    print(f"    date: {impression.get('date')}")
    print(f"    originType: {impression.get('originType')}")
    print(f"    sourceImpressionId: {impression.get('sourceImpressionId')}")
    print(f"    rootImpressionId: {impression.get('rootImpressionId')}")
    print(f"    content: {impression.get('content', '')}")
PY
}

wait_for_yesterday_impression() {
  local elapsed=0
  local result

  echo "Waiting for yesterday impression..."

  while (( elapsed <= POLL_TIMEOUT )); do
    result="$(query_impressions)"
    if RESULT_JSON="$result" TARGET_DATE="${YESTERDAY}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
impressions = data.get('impressions', [])

if len(impressions) != 1:
    raise SystemExit(1)

first = impressions[0]
if first.get('date') != os.environ['TARGET_DATE']:
    raise SystemExit(1)

if first.get('originType') != 'standalone':
    raise SystemExit(1)
PY
    then
      LAST_QUERY_RESULT="$result"
      echo "  yesterday impression ready after ${elapsed}s"
      return 0
    fi

    echo "  not ready yet, retrying in ${POLL_INTERVAL}s..."
    sleep "${POLL_INTERVAL}"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  LAST_QUERY_RESULT="$result"
  return 1
}

wait_for_cross_day_continuation() {
  local source_id="$1"
  local elapsed=0
  local result

  echo "Waiting for today's continued impression..."

  while (( elapsed <= POLL_TIMEOUT )); do
    result="$(query_impressions)"
    if RESULT_JSON="$result" SOURCE_ID="${source_id}" TODAY_DATE="${TODAY}" YESTERDAY_DATE="${YESTERDAY}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
impressions = data.get('impressions', [])

if len(impressions) != 2:
    raise SystemExit(1)

today = [item for item in impressions if item.get('date') == os.environ['TODAY_DATE']]
yesterday = [item for item in impressions if item.get('date') == os.environ['YESTERDAY_DATE']]

if len(today) != 1 or len(yesterday) != 1:
    raise SystemExit(1)

today_item = today[0]
if today_item.get('originType') != 'continued':
    raise SystemExit(1)

if today_item.get('sourceImpressionId') != os.environ['SOURCE_ID']:
    raise SystemExit(1)
PY
    then
      LAST_QUERY_RESULT="$result"
      echo "  cross-day continuation ready after ${elapsed}s"
      return 0
    fi

    echo "  not ready yet, retrying in ${POLL_INTERVAL}s..."
    sleep "${POLL_INTERVAL}"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  LAST_QUERY_RESULT="$result"
  return 1
}

validate_source_endpoint() {
  local impression_id="$1"
  local source_id="$2"
  local result

  result="$(curl -s "${API}/api/impression-sources/${impression_id}")"
  RESULT_JSON="$result" SOURCE_ID="${source_id}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
sources = data.get('sources', [])

if len(sources) != 1:
    print(f"FAIL: expected exactly 1 source edge, got {len(sources)}")
    raise SystemExit(1)

source = sources[0].get('source') or {}
if source.get('id') != os.environ['SOURCE_ID']:
    print("FAIL: source endpoint returned wrong source impression")
    raise SystemExit(1)

text = source.get('content', '')
markers = ['面包店', '工业园区', '老城区', '可颂', '酸种']
hits = [marker for marker in markers if marker in text]
if len(hits) < 2:
    print("FAIL: source impression content looks wrong")
    print("hits=", hits)
    raise SystemExit(1)

print("PASS: source endpoint returns the historical source impression")
print("source_hits=", hits)
PY
}

echo "============================================"
echo "  Cross-Day Impression Dependency Test"
echo "============================================"
echo "API:       ${API}"
echo "Today:     ${TODAY}"
echo "Yesterday: ${YESTERDAY}"
echo

echo "Step 1: Register test user ${USERNAME}"
REGISTER_PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}))' "${USERNAME}" "${PASSWORD}")"
REGISTER_RESULT="$(curl -s -X POST "${API}/api/register" \
  -H "Content-Type: application/json" \
  -d "${REGISTER_PAYLOAD}")"
USER_ID="$(printf '%s' "$REGISTER_RESULT" | json_value user.id)"
echo "  user_id = ${USER_ID}"
echo

echo "Step 2: Enqueue yesterday job"
YESTERDAY_MESSAGES="$(build_yesterday_messages "${YESTERDAY}")"
YESTERDAY_JOB_ID="$(enqueue_job "${YESTERDAY}" "history" "${YESTERDAY_MESSAGES}")"
echo "  job_id = ${YESTERDAY_JOB_ID}"
wait_for_yesterday_impression
FIRST_RESULT="${LAST_QUERY_RESULT}"
print_impressions "${FIRST_RESULT}"
SOURCE_ID="$(RESULT_JSON="${FIRST_RESULT}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
print(data['impressions'][0]['id'])
PY
)"
echo

echo "Step 3: Enqueue today's continuation job"
TODAY_MESSAGES="$(build_today_messages "${TODAY}")"
TODAY_JOB_ID="$(enqueue_job "${TODAY}" "today" "${TODAY_MESSAGES}")"
echo "  job_id = ${TODAY_JOB_ID}"
wait_for_cross_day_continuation "${SOURCE_ID}"
SECOND_RESULT="${LAST_QUERY_RESULT}"
print_impressions "${SECOND_RESULT}"
TODAY_IMPRESSION_ID="$(RESULT_JSON="${SECOND_RESULT}" TODAY_DATE="${TODAY}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
today = [item for item in data['impressions'] if item.get('date') == os.environ['TODAY_DATE']]
print(today[0]['id'])
PY
)"
echo

echo "Step 4: Validate source lineage endpoint"
validate_source_endpoint "${TODAY_IMPRESSION_ID}" "${SOURCE_ID}"
echo
echo "PASS: cross-day continuation created a new today impression and preserved the historical source"
echo "User ID: ${USER_ID}"
