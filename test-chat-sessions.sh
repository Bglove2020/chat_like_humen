#!/bin/bash
# Multi-session integration test:
# 1) create two chat sessions
# 2) send messages into both sessions
# 3) verify each session keeps its own Dify conversationId
# 4) verify a session reuses the same conversationId across turns
# 5) verify message histories do not mix across sessions

set -euo pipefail

API="${API:-http://localhost:7101}"
PASSWORD="test123"
TIMESTAMP="$(date +%s)"
USERNAME="session_test_${TIMESTAMP}"

json_value() {
  local path="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); parts='${path}'.split('.'); cur=data
for p in parts:
    cur = cur[p] if not p.isdigit() else cur[int(p)]
print(cur)"
}

build_json_payload() {
  local payload="$1"
  python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]), ensure_ascii=False))' "$payload"
}

auth_curl() {
  curl -s "$@" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json"
}

send_message() {
  local session_id="$1"
  local message="$2"
  local payload

  payload="$(python3 -c 'import json,sys; print(json.dumps({"sessionId": sys.argv[1], "message": sys.argv[2]}, ensure_ascii=False))' "${session_id}" "${message}")"
  auth_curl -X POST "${API}/api/chat" -d "${payload}"
}

list_sessions() {
  auth_curl "${API}/api/chat-sessions"
}

get_messages() {
  local session_id="$1"
  auth_curl "${API}/api/chat-sessions/${session_id}/messages"
}

echo "============================================"
echo "  Chat Sessions Integration Test"
echo "============================================"
echo "API: ${API}"
echo

echo "Step 1: Register test user ${USERNAME}"
REGISTER_PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}))' "${USERNAME}" "${PASSWORD}")"
REGISTER_RESULT="$(curl -s -X POST "${API}/api/register" -H "Content-Type: application/json" -d "${REGISTER_PAYLOAD}")"
TOKEN="$(printf '%s' "$REGISTER_RESULT" | json_value token)"
USER_ID="$(printf '%s' "$REGISTER_RESULT" | json_value user.id)"
echo "  user_id = ${USER_ID}"
echo

echo "Step 2: Create two chat sessions"
SESSION_A_RESULT="$(auth_curl -X POST "${API}/api/chat-sessions" -d '{}')"
SESSION_B_RESULT="$(auth_curl -X POST "${API}/api/chat-sessions" -d '{}')"
SESSION_A_ID="$(printf '%s' "$SESSION_A_RESULT" | json_value id)"
SESSION_B_ID="$(printf '%s' "$SESSION_B_RESULT" | json_value id)"
echo "  session_a = ${SESSION_A_ID}"
echo "  session_b = ${SESSION_B_ID}"
echo

echo "Step 3: Send first message to session A"
SEND_A1_RESULT="$(send_message "${SESSION_A_ID}" "我们先聊苏州开面包店这件事，我在工业园区和老城区两个铺面之间犹豫。")"
A_REPLY_1="$(printf '%s' "$SEND_A1_RESULT" | json_value reply)"
echo "  reply_a1 = ${A_REPLY_1}"

SESSIONS_AFTER_A1="$(list_sessions)"
A_CONV_ID_1="$(RESULT_JSON="$SESSIONS_AFTER_A1" TARGET_ID="${SESSION_A_ID}" python3 - <<'PY'
import json
import os

sessions = json.loads(os.environ['RESULT_JSON'])
target = next(item for item in sessions if item['id'] == os.environ['TARGET_ID'])
print(target.get('difyConversationId') or '')
PY
)"
A_TITLE_1="$(RESULT_JSON="$SESSIONS_AFTER_A1" TARGET_ID="${SESSION_A_ID}" python3 - <<'PY'
import json
import os

sessions = json.loads(os.environ['RESULT_JSON'])
target = next(item for item in sessions if item['id'] == os.environ['TARGET_ID'])
print(target.get('title') or '')
PY
)"

if [[ -z "${A_CONV_ID_1}" ]]; then
  echo "FAIL: session A did not receive a Dify conversationId after first message"
  exit 1
fi

echo "  session_a conversationId = ${A_CONV_ID_1}"
echo "  session_a title = ${A_TITLE_1}"
echo

echo "Step 4: Send second message to session A and verify conversationId is reused"
SEND_A2_RESULT="$(send_message "${SESSION_A_ID}" "我已经和合伙人把预算算到二十五万了，想先做可颂和酸种。")"
A_REPLY_2="$(printf '%s' "$SEND_A2_RESULT" | json_value reply)"
echo "  reply_a2 = ${A_REPLY_2}"

SESSIONS_AFTER_A2="$(list_sessions)"
A_CONV_ID_2="$(RESULT_JSON="$SESSIONS_AFTER_A2" TARGET_ID="${SESSION_A_ID}" python3 - <<'PY'
import json
import os

sessions = json.loads(os.environ['RESULT_JSON'])
target = next(item for item in sessions if item['id'] == os.environ['TARGET_ID'])
print(target.get('difyConversationId') or '')
PY
)"

if [[ "${A_CONV_ID_1}" != "${A_CONV_ID_2}" ]]; then
  echo "FAIL: session A conversationId changed across turns"
  echo "  before = ${A_CONV_ID_1}"
  echo "  after  = ${A_CONV_ID_2}"
  exit 1
fi

echo "  session_a conversationId reused"
echo

echo "Step 5: Send first message to session B and verify it gets a different conversationId"
SEND_B1_RESULT="$(send_message "${SESSION_B_ID}" "我们换个话题，我最近在准备成都马拉松，但右膝外侧一直有点疼。")"
B_REPLY_1="$(printf '%s' "$SEND_B1_RESULT" | json_value reply)"
echo "  reply_b1 = ${B_REPLY_1}"

SESSIONS_AFTER_B1="$(list_sessions)"
B_CONV_ID_1="$(RESULT_JSON="$SESSIONS_AFTER_B1" TARGET_ID="${SESSION_B_ID}" python3 - <<'PY'
import json
import os

sessions = json.loads(os.environ['RESULT_JSON'])
target = next(item for item in sessions if item['id'] == os.environ['TARGET_ID'])
print(target.get('difyConversationId') or '')
PY
)"

if [[ -z "${B_CONV_ID_1}" ]]; then
  echo "FAIL: session B did not receive a Dify conversationId"
  exit 1
fi

if [[ "${A_CONV_ID_1}" == "${B_CONV_ID_1}" ]]; then
  echo "FAIL: session A and B unexpectedly share the same Dify conversationId"
  exit 1
fi

echo "  session_b conversationId = ${B_CONV_ID_1}"
echo

echo "Step 6: Verify message histories do not mix"
SESSION_A_MESSAGES="$(get_messages "${SESSION_A_ID}")"
SESSION_B_MESSAGES="$(get_messages "${SESSION_B_ID}")"

RESULT_JSON="$SESSION_A_MESSAGES" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
messages = data.get('messages', [])

if len(messages) != 4:
    print(f"FAIL: expected 4 messages in session A, got {len(messages)}")
    raise SystemExit(1)

joined = "\n".join(message["content"] for message in messages)
if "马拉松" in joined:
    print("FAIL: session A unexpectedly contains session B content")
    raise SystemExit(1)

markers = ["面包店", "工业园区", "老城区", "可颂", "酸种", "二十五万"]
hits = [marker for marker in markers if marker in joined]
if len(hits) < 3:
    print("FAIL: session A history missing expected bakery markers")
    print("hits=", hits)
    raise SystemExit(1)

print("PASS: session A history is isolated")
print("session_a_hits=", hits)
PY

RESULT_JSON="$SESSION_B_MESSAGES" python3 - <<'PY'
import json
import os

data = json.loads(os.environ['RESULT_JSON'])
messages = data.get('messages', [])

if len(messages) != 2:
    print(f"FAIL: expected 2 messages in session B, got {len(messages)}")
    raise SystemExit(1)

joined = "\n".join(message["content"] for message in messages)
if "面包店" in joined or "可颂" in joined:
    print("FAIL: session B unexpectedly contains session A content")
    raise SystemExit(1)

markers = ["马拉松", "右膝", "疼"]
hits = [marker for marker in markers if marker in joined]
if len(hits) < 2:
    print("FAIL: session B history missing expected running markers")
    print("hits=", hits)
    raise SystemExit(1)

print("PASS: session B history is isolated")
print("session_b_hits=", hits)
PY

echo
echo "PASS: multi-session chat works and each session keeps its own stable Dify conversationId"
echo "User ID: ${USER_ID}"
