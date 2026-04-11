const http = require('http');

const PORT = parseInt(process.env.MOCK_DASHSCOPE_PORT || '19090', 10);
const EMBEDDING_DIM = parseInt(process.env.MOCK_EMBEDDING_DIM || '1024', 10);

let qwenCallCount = 0;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function buildEmbedding(text) {
  const vector = new Array(EMBEDDING_DIM).fill(0);
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed + text.charCodeAt(i) * (i + 1)) % 9973;
  }
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    vector[i] = ((seed + i * 31) % 1000) / 1000;
  }
  return vector;
}

function buildNode1Payload(prompt) {
  if (prompt.includes('面包店')) {
    return {
      historyRetrievalDraft: '聊开面包店计划，之前在聊铺面、预算和现金流。',
      deltaRetrievalDraft: '聊开面包店计划，这轮新增了早餐下午茶、设备或辞职时间。',
      mergedRetrievalDraft: '聊开面包店计划，原来在聊铺面、预算和现金流，这轮又新增了早餐下午茶、设备或辞职时间。',
    };
  }

  if (prompt.includes('马拉松') || prompt.includes('膝盖')) {
    return {
      historyRetrievalDraft: '聊马拉松训练和膝盖问题，之前已经提过训练量和配速。',
      deltaRetrievalDraft: '聊马拉松训练和膝盖问题，这轮新增了膝盖不舒服和备赛压力。',
      mergedRetrievalDraft: '聊马拉松训练和膝盖问题，原来在聊训练量和配速，这轮又新增了膝盖不舒服和备赛压力。',
    };
  }

  return {
    historyRetrievalDraft: '聊当前对话场景，之前已经有一些上下文。',
    deltaRetrievalDraft: '聊当前对话场景，这轮新增了一些关键信息。',
    mergedRetrievalDraft: '聊当前对话场景，原来已经在聊一些上下文，这轮又新增了一些关键信息。',
  };
}

function buildNode2Payload(prompt) {
  if (prompt.includes('前同事') || prompt.includes('女孩子')) {
    return {
      impressions: [
        {
          sourceImpressionId: null,
          scene: '聊对前同事女生有好感',
          points: [
            '用户喜欢上一位前同事的女生，但还不确定对方态度。',
            '共同话题怎么自然展开，是这条线上的主要顾虑。'
          ],
          retrievalText: '聊对前同事女生有好感时，用户一边不确定对方态度，一边担心共同话题不够自然。'
        }
      ]
    };
  }

  if (prompt.includes('孩子')) {
    return {
      impressions: [
        {
          sourceImpressionId: null,
          scene: '聊和孩子沟通时的共情拿捏',
          points: [
            '用户担心一味共情会让孩子更闹，甚至被惯坏。',
            '共情和迁就的区别，以及怎么先帮孩子平静下来，是这条线上的关键。'
          ],
          retrievalText: '聊和孩子沟通时的共情拿捏时，用户担心一味共情会让孩子更闹，所以重点落在共情和迁就的区别，以及怎么先帮孩子平静下来。'
        }
      ]
    };
  }

  return {
    impressions: [
      {
        sourceImpressionId: null,
        scene: '聊当前对话场景',
        points: [
          '这轮对话里出现了一些可以延续的记忆点。'
        ],
        retrievalText: '聊当前对话场景时，这轮对话里出现了一些可以延续的记忆点。'
      }
    ]
  };
}

function buildDecisionFromPrompt(prompt) {
  if (prompt.includes('historyRetrievalDraft') || prompt.includes('Node1') || prompt.includes('## 历史消息')) {
    return buildNode1Payload(prompt);
  }

  if (prompt.includes('"impressions"') || prompt.includes('聊天印象合并器') || prompt.includes('## 候选旧 impressions')) {
    return buildNode2Payload(prompt);
  }

  return buildNode2Payload(prompt);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const body = await readJsonBody(req);

    if (req.url === '/api/v1/services/embeddings/text-embedding/text-embedding') {
      const text = body?.input?.texts?.[0] || '';
      const embedding = buildEmbedding(text);
      console.log(`[MockDashScope] Embedding request textLength=${text.length}`);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-request-id': `mock-embedding-${Date.now()}`,
      });
      res.end(JSON.stringify({
        output: {
          embeddings: [{ embedding }],
        },
        usage: {
          total_tokens: Math.max(1, Math.ceil(text.length / 4)),
        },
        request_id: `mock-embedding-${Date.now()}`,
      }));
      return;
    }

    if (req.url === '/compatible-mode/v1/chat/completions') {
      qwenCallCount += 1;
      const prompt = body?.messages?.[1]?.content || '';
      console.log(`[MockDashScope] Qwen request #${qwenCallCount} promptLength=${prompt.length}`);

      if (qwenCallCount === 1) {
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'x-request-id': 'mock-qwen-502-first-call',
        });
        res.end(JSON.stringify({
          error: {
            message: 'mock upstream gateway error on first qwen call',
            type: 'mock_upstream_502',
          },
        }));
        return;
      }

      if (qwenCallCount === 2) {
        console.log('[MockDashScope] Simulating slow retry success for request #2');
        await sleep(6000);
      }

      const payload = buildDecisionFromPrompt(prompt);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-request-id': `mock-qwen-ok-${qwenCallCount}`,
      });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              reasoning_content: `mock reasoning for request ${qwenCallCount}`,
              content: JSON.stringify(payload),
            },
          },
        ],
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported_path', path: req.url }));
  } catch (error) {
    console.error('[MockDashScope] Server error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'server_error', message: error.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[MockDashScope] Listening on http://127.0.0.1:${PORT}`);
});
