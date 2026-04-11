#!/bin/bash
# Regression test:
# 1) first Qwen call returns 502
# 2) the failed summary job is retried automatically
# 3) during retry, later jobs for the same user are delayed and cannot overtake

set -euo pipefail

ROOT="/home/zxr/chat_like_human"
API="${API:-http://localhost:7101}"
QDRANT="${QDRANT:-http://localhost:6335}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6380}"
REDIS_PASSWORD="${REDIS_PASSWORD:-zxr120713.}"
MOCK_PORT="${MOCK_PORT:-19090}"
PASSWORD="test123"
TIMESTAMP="$(date +%s)"
USERNAME="summary_retry_test_${TIMESTAMP}"
POLL_INTERVAL=3
POLL_TIMEOUT=120
WORKER_LOG="$(mktemp)"
MOCK_LOG="$(mktemp)"
TEMP_WORKER_PID=""
MOCK_PID=""
DEV_WORKER_STOPPED=0
USER_ID=""
SESSION_ID=""

cleanup() {
  set +e

  if [[ -n "${TEMP_WORKER_PID}" ]]; then
    kill "${TEMP_WORKER_PID}" >/dev/null 2>&1 || true
    wait "${TEMP_WORKER_PID}" >/dev/null 2>&1 || true
  fi

  if [[ -n "${MOCK_PID}" ]]; then
    kill "${MOCK_PID}" >/dev/null 2>&1 || true
    wait "${MOCK_PID}" >/dev/null 2>&1 || true
  fi

  if [[ "${DEV_WORKER_STOPPED}" -eq 1 ]]; then
    pm2 start chat-worker-dev >/dev/null 2>&1 || true
  fi

  rm -f "${WORKER_LOG}" "${MOCK_LOG}"
}

trap cleanup EXIT

json_value() {
  local path="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); cur=data
for p in '${path}'.split('.'):
    cur = cur[int(p)] if p.isdigit() else cur[p]
print(cur)"
}

send_message() {
  local message="$1"
  local payload

  payload="$(python3 -c 'import json,sys; message=sys.argv[1]; session_id=sys.argv[2]; data={"message": message}; 
if session_id:
    data["sessionId"]=session_id
print(json.dumps(data, ensure_ascii=False))' "${message}" "${SESSION_ID}")"

  local result
  result="$(curl -s -X POST "${API}/api/chat" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${payload}")"

  if [[ -z "${SESSION_ID}" ]]; then
    SESSION_ID="$(printf '%s' "${result}" | json_value sessionId)"
  fi

  local reply
  reply="$(printf '%s' "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reply','')[:90])")"
  echo "USER: ${message}"
  echo "AI:   ${reply}"
  echo
}

wait_for_log() {
  local pattern="$1"
  local timeout="${2:-30}"
  local elapsed=0
  while (( elapsed <= timeout )); do
    if grep -q "${pattern}" "${WORKER_LOG}"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

poll_user_points() {
  curl -s -X POST "${QDRANT}/collections/user_impressions/points/scroll" \
    -H "Content-Type: application/json" \
    -d "{
      \"limit\": 20,
      \"with_payload\": true,
      \"filter\": {
        \"must\": [
          {\"key\": \"userId\", \"match\": {\"value\": ${USER_ID}}}
        ]
      }
    }"
}

echo "============================================"
echo "  Summary Retry / Lock Ordering Test"
echo "============================================"
echo "API:        ${API}"
echo "Qdrant:     ${QDRANT}"
echo "Redis:      ${REDIS_HOST}:${REDIS_PORT}"
echo "Mock port:  ${MOCK_PORT}"
echo

echo "Step 1: Restart dev backend with latest build"
pm2 restart chat-backend-dev >/dev/null

echo "Step 2: Stop dev worker and clear dev queue/collection"
if pm2 pid chat-worker-dev >/dev/null 2>&1; then
  pm2 stop chat-worker-dev >/dev/null
  DEV_WORKER_STOPPED=1
fi

curl -s -X DELETE "${QDRANT}/collections/user_impressions" >/dev/null || true

(
  cd "${ROOT}/backend"
  REDIS_HOST="${REDIS_HOST}" REDIS_PORT="${REDIS_PORT}" REDIS_PASSWORD="${REDIS_PASSWORD}" \
  node - <<'NODE'
  const { Queue } = require('bullmq');
  (async () => {
    const queue = new Queue('chat-summary-queue', {
      connection: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT), password: process.env.REDIS_PASSWORD },
      prefix: 'bull',
    });
    await queue.drain(true);
    await queue.clean(0, 1000, 'completed');
    await queue.clean(0, 1000, 'failed');
    await queue.clean(0, 1000, 'delayed');
    await queue.close();
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
NODE
)

echo "Step 3: Start mock DashScope server"
node "${ROOT}/tests/mock-dashscope-server.js" >"${MOCK_LOG}" 2>&1 &
MOCK_PID=$!
sleep 1
cat "${MOCK_LOG}"

echo "Step 4: Start temporary dev worker with mock DashScope"
(
  cd "${ROOT}/worker"
  NODE_ENV=development \
  REDIS_HOST="${REDIS_HOST}" \
  REDIS_PORT="${REDIS_PORT}" \
  REDIS_PASSWORD="${REDIS_PASSWORD}" \
  QDRANT_URL="${QDRANT}" \
  BACKEND_INTERNAL_URL="http://127.0.0.1:7101" \
  DASHSCOPE_API_KEY="mock-key" \
  DASHSCOPE_EMBEDDING_URL="http://127.0.0.1:${MOCK_PORT}/api/v1/services/embeddings/text-embedding/text-embedding" \
  DASHSCOPE_QWEN_URL="http://127.0.0.1:${MOCK_PORT}/compatible-mode/v1/chat/completions" \
  WORKER_CONCURRENCY=5 \
  node dist/main.js >"${WORKER_LOG}" 2>&1
) &
TEMP_WORKER_PID=$!

if ! wait_for_log "Waiting for jobs" 30; then
  echo "Worker failed to start"
  cat "${WORKER_LOG}"
  exit 1
fi

echo "Step 5: Register test user ${USERNAME}"
REGISTER_PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}))' "${USERNAME}" "${PASSWORD}")"
REGISTER_RESULT="$(curl -s -X POST "${API}/api/register" \
  -H "Content-Type: application/json" \
  -d "${REGISTER_PAYLOAD}")"
TOKEN="$(printf '%s' "${REGISTER_RESULT}" | json_value token)"
USER_ID="$(printf '%s' "${REGISTER_RESULT}" | json_value user.id)"
echo "user_id=${USER_ID}"
echo

echo "Step 6: Send 10 user turns across two topics"
send_message "你好"
send_message "我不知道怎么和我孩子沟通"
send_message "小孩子你是没法共情的，你越共情她她越闹"
send_message "但是这样很容易就给他惯坏了"
send_message "怎么让他平静下来呢"
send_message "好吧 我下次试试"
send_message "还有个问题就是我最近喜欢上了一个女孩子"
send_message "她是我前同事，但是我不知道她对我啥感觉"
send_message "有在这样的聊天，但是感觉共同话题不是很多嘞"
send_message "这种情况我应该怎么自然一点继续聊"

echo "Step 7: Wait for two impressions to be written"
ELAPSED=0
POINTS_JSON=""
while (( ELAPSED <= POLL_TIMEOUT )); do
  POINTS_JSON="$(poll_user_points)"
  COUNT="$(printf '%s' "${POINTS_JSON}" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('result',{}).get('points',[])))")"
  if [[ "${COUNT}" -ge 2 ]]; then
    echo "Impressions ready after ${ELAPSED}s"
    break
  fi
  sleep "${POLL_INTERVAL}"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [[ "${COUNT:-0}" -lt 2 ]]; then
  echo "Timed out waiting for impressions"
  echo "----- worker log -----"
  cat "${WORKER_LOG}"
  echo "----- mock log -----"
  cat "${MOCK_LOG}"
  exit 1
fi

echo "Step 8: Validate retry ordering and final output"
python3 - "${WORKER_LOG}" "${USER_ID}" "${POINTS_JSON}" <<'PY'
import json
import re
import sys

log_path, user_id, points_json = sys.argv[1], sys.argv[2], sys.argv[3]

with open(log_path, 'r', encoding='utf-8') as f:
    lines = [line.rstrip('\n') for line in f]

received = []
blocked_line = None
failed_line = None
retained_line = None
retry_line = None
failure_log_has_502 = False
request_id_logged = False

for idx, line in enumerate(lines, start=1):
    if f'for user {user_id}' in line and 'Received job' in line:
        received.append((idx, line))
    if f'User {user_id} is blocked by job' in line and blocked_line is None:
        blocked_line = idx
    if 'failed on attempt 1/4' in line and failed_line is None:
        failed_line = idx
    if 'retrying with retained user lock' in line and retained_line is None:
        retained_line = idx
    if 'attempt 2/4' in line and retry_line is None and f'for user {user_id}' in line:
        retry_line = idx
    if 'mock upstream gateway error on first qwen call' in line:
        failure_log_has_502 = True
    if 'mock-qwen-502-first-call' in line:
        request_id_logged = True

if len(received) < 3:
    raise SystemExit('FAIL: expected multiple worker receipts for the retry scenario')
if blocked_line is None:
    raise SystemExit('FAIL: missing blocked-job log, later job may have overtaken')
if failed_line is None:
    raise SystemExit('FAIL: missing first-attempt failure log')
if retained_line is None:
    raise SystemExit('FAIL: missing retained-lock failure policy log')
if retry_line is None:
    raise SystemExit('FAIL: missing retry attempt log')
if not failure_log_has_502:
    raise SystemExit('FAIL: missing detailed 502 error body in worker log')
if not request_id_logged:
    raise SystemExit('FAIL: missing upstream request id in worker log')

batch_order = []
for _, line in received:
    match = re.search(r'batchId: ([^)]*)\)', line)
    if match:
      batch_id = match.group(1)
      if batch_id not in batch_order:
        batch_order.append(batch_id)

if len(batch_order) < 2:
    raise SystemExit(f'FAIL: expected at least 2 batch ids, got {batch_order}')

first_batch = batch_order[0]
second_batch = batch_order[1]
first_completed_line = None
second_completed_line = None

for idx, line in enumerate(lines, start=1):
    if f'Completed job {first_batch}' in line and first_completed_line is None:
        first_completed_line = idx
    if f'Completed job {second_batch}' in line and second_completed_line is None:
        second_completed_line = idx

if first_completed_line is None:
    raise SystemExit(f'FAIL: missing completion log for first batch {first_batch}')
if second_completed_line is None:
    raise SystemExit(f'FAIL: missing completion log for second batch {second_batch}')
if not (failed_line < retry_line < first_completed_line):
    raise SystemExit(
        f'FAIL: unexpected first-batch ordering failed={failed_line}, retry={retry_line}, first_completed={first_completed_line}'
    )
if blocked_line >= first_completed_line:
    raise SystemExit(
        f'FAIL: blocked log appeared after first batch had already completed; blocked={blocked_line}, first_completed={first_completed_line}'
    )
if second_completed_line <= first_completed_line:
    raise SystemExit(
        f'FAIL: second batch completed before or together with first batch; first_completed={first_completed_line}, second_completed={second_completed_line}'
    )

points = json.loads(points_json).get('result', {}).get('points', [])
texts = [point.get('payload', {}).get('summaryText', '') for point in points]
joined = '\n'.join(texts)

if len(points) < 2:
    raise SystemExit(f'FAIL: expected at least 2 impressions, got {len(points)}')
if '孩子' not in joined:
    raise SystemExit('FAIL: missing child-topic impression')
if '前同事' not in joined and '女' not in joined:
    raise SystemExit('FAIL: missing romance-topic impression')

print('PASS: retry ordering and final impressions validated')
print(f'Worker receipt lines: {received[:4]}')
print(
    f'failed_line={failed_line}, retry_line={retry_line}, blocked_line={blocked_line}, '
    f'first_completed_line={first_completed_line}, second_completed_line={second_completed_line}'
)
PY

echo
echo "----- worker log excerpt -----"
grep -E "Received job|blocked by job|failed on attempt|Failure policy|Completed job|mock-qwen-502-first-call" "${WORKER_LOG}" || true
echo
echo "----- mock log -----"
cat "${MOCK_LOG}"
echo
echo "Test passed"
