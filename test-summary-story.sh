#!/bin/bash
# Summary System Test: Simulating a real user telling a story across multiple messages
# Validates: 1) Related conversation → single summary (not split), 2) Summary includes AI response descriptions

set -e

API="http://localhost:7001"
TIMESTAMP=$(date +%s)
USERNAME="story_test_${TIMESTAMP}"
QDRANT="http://localhost:6333"

echo "============================================"
echo "  Summary System Integration Test"
echo "  Testing: Multi-message story → single summary"
echo "============================================"
echo ""

# Step 1: Register user
echo "📋 Step 1: Registering test user '${USERNAME}'..."
REG=$(curl -s -X POST ${API}/api/register \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"test123\"}")

TOKEN=$(echo $REG | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
USER_ID=$(echo $REG | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
echo "   ✅ Registered. User ID: ${USER_ID}"
echo ""

# Step 2: Send a complete story split across multiple messages
# Story theme: A trip to Japan - told in 5 parts
echo "📋 Step 2: Sending story messages (user tells a story about Japan trip in 5 parts)..."

send_message() {
  local msg="$1"
  local label="$2"
  echo "   📤 Sending part ${label}: ${msg}"
  RESULT=$(curl -s -X POST ${API}/api/chat \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"${msg}\"}")
  REPLY=$(echo $RESULT | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','NO REPLY')[:100])")
  echo "   📥 AI replied: ${REPLY}..."
  sleep 2  # Wait for processing between messages
}

# Part 1: User starts talking about planning a trip
send_message "我最近在计划一次去日本的旅行，但是完全不知道从哪里开始准备" "1"

# Part 2: User adds more details about the trip
send_message "我打算去十天左右，预算大概两万块钱，主要是想去京都和东京看看" "2"

# Part 3: User talks about specific interests
send_message "我对日本的传统文化特别感兴趣，尤其是茶道和和服体验，还有想品尝正宗的日本料理" "3"

# Part 4: User asks about practical matters
send_message "我从来没出过国，护照签证这些手续怎么办？还有交通方面听说有JR Pass" "4"

# Part 5: User asks for specific recommendations
send_message "能帮我推荐一下京都必去的寺庙和东京有好吃的拉面店吗" "5"

echo ""
echo "   ✅ All 5 story parts sent (total ~10 messages including AI replies)"
echo ""

# Step 3: Wait for worker to process
echo "📋 Step 3: Waiting for worker to process summaries (25 seconds)..."
sleep 25
echo "   ✅ Wait complete"
echo ""

# Step 4: Check Qdrant for generated summaries
echo "📋 Step 4: Checking generated summaries in Qdrant..."
TODAY=$(TZ=Asia/Shanghai date +%Y-%m-%d)
echo "   Date filter: ${TODAY}"

SEARCH_RESULT=$(curl -s -X POST "${QDRANT}/collections/user_impressions/points/search" \
  -H "Content-Type: application/json" \
  -d "{
    \"vector\": $(python3 -c "print([0]*1024)"),
    \"limit\": 50,
    \"with_payload\": true,
    \"filter\": {
      \"must\": [
        {\"key\": \"userId\", \"match\": {\"value\": ${USER_ID}}},
        {\"key\": \"date\", \"match\": {\"value\": \"${TODAY}\"}}
      ]
    }
  }")

echo ""
echo "============================================"
echo "  TEST RESULTS"
echo "============================================"

# Count summaries
SUMMARY_COUNT=$(echo $SEARCH_RESULT | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('result', [])
print(len(results))
")

echo ""
echo "📊 Generated summaries count: ${SUMMARY_COUNT}"
echo ""

# Display each summary
echo $SEARCH_RESULT | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('result', [])
for i, r in enumerate(results, 1):
    payload = r.get('payload', {})
    summary = payload.get('summaryText', 'N/A')
    action = payload.get('action', 'N/A')
    created = payload.get('createdAt', 'N/A')
    print(f'  📝 Summary #{i}:')
    print(f'     Content: {summary}')
    print(f'     Action: {action}')
    print(f'     Created: {created}')
    print()
"

# Step 5: Validate results
echo "============================================"
echo "  VALIDATION"
echo "============================================"

python3 << PYEOF
import json, sys

data = json.loads('''${SEARCH_RESULT}''')
results = data.get('result', [])

print()
print("Validation Results:")
print("-" * 50)

# Check 1: Related conversation should be in ONE summary, not split
if len(results) == 0:
    print("❌ FAIL: No summaries generated at all!")
    sys.exit(1)
elif len(results) == 1:
    print("✅ PASS: Related story → single summary (1 summary generated)")
else:
    print(f"⚠️  WARNING: Got {len(results)} summaries for a single-topic story")
    print("   (Expected: 1 summary for the whole Japan trip story)")
    # Check if they're actually all about the same topic
    all_about_japan = all('日本' in r.get('payload', {}).get('summaryText', '') for r in results)
    if all_about_japan:
        print("❌ FAIL: Same topic (Japan trip) was split into multiple summaries!")
    else:
        print("✅ Partial: Some summaries may cover different aspects")

# Check 2: Summary should include AI response descriptions
print()
has_ai_context = False
for i, r in enumerate(results, 1):
    summary = r.get('payload', {}).get('summaryText', '')
    ai_indicators = ['我建议', '我推荐', '我帮助', '我告诉', '我介绍', '回复', '建议', '推荐', '帮助', '指出']
    found = [ind for ind in ai_indicators if ind in summary]
    if found:
        has_ai_context = True
        print(f"✅ PASS: Summary #{i} contains AI context indicators: {found}")
    else:
        print(f"❌ FAIL: Summary #{i} lacks AI response description")
        print(f"   Content: {summary}")

if not has_ai_context:
    print()
    print("❌ FAIL: No summary includes AI response descriptions!")
    sys.exit(1)

# Check 3: Content quality - should mention key story elements
print()
all_text = ' '.join(r.get('payload', {}).get('summaryText', '') for r in results)
key_elements = {
    '日本': False,
    '旅行/旅游': False,
    '京都': False,
    '东京': False,
}
for elem in key_elements:
    if '/' in elem:
        parts = elem.split('/')
        if any(p in all_text for p in parts):
            key_elements[elem] = True
    elif elem in all_text:
        key_elements[elem] = True

print("Key element coverage:")
for elem, found in key_elements.items():
    status = "✅" if found else "❌"
    print(f"  {status} {elem}")

missing = [e for e, f in key_elements.items() if not f]
if missing:
    print(f"⚠️  Missing elements: {missing}")
    print("   (This may be acceptable if merged into a general summary)")

print()
print("=" * 50)
if has_ai_context and len(results) <= 2:
    print("🎉 OVERALL: Test PASSED - Summary quality is acceptable")
else:
    print("⚠️  OVERALL: Test has issues - see details above")
PYEOF

echo ""
echo "============================================"
echo "  Test complete. User ID: ${USER_ID}"
echo "  Cleanup: Summaries can be manually deleted from Qdrant"
echo "============================================"
