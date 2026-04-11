#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');

const rootDir = path.resolve(__dirname, '../..');
const appEnv = process.env.NODE_ENV || 'development';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }

    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(rootDir, 'backend', `.env.${appEnv}`));
loadEnvFile(path.join(rootDir, 'backend', '.env'));
loadEnvFile(path.join(rootDir, 'worker', `.env.${appEnv}`));
loadEnvFile(path.join(rootDir, 'worker', '.env'));

function parseArgs(argv) {
  const args = {
    userId: null,
    batchSize: 10,
    limit: 6,
    queries: ['用户最近在聊什么', '用户明确提到的事实和偏好', '最近对话中的关键变化'],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--user-id' && next) {
      args.userId = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--batch-size' && next) {
      args.batchSize = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--limit' && next) {
      args.limit = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--queries' && next) {
      args.queries = next.split('|').map((item) => item.trim()).filter(Boolean);
      index += 1;
    }
  }

  return args;
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }

  return value;
}

function mem0Headers() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.MEM0_API_KEY) {
    headers['X-API-Key'] = process.env.MEM0_API_KEY;
  }
  return headers;
}

function mem0Url(pathname) {
  return `${(process.env.MEM0_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')}${pathname}`;
}

async function loadChatMessages(userId) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agent_db',
  });

  try {
    try {
      const [rows] = await connection.execute(
        `select id, userId, chatSessionId, role, content, createdAt
         from chat_messages
         where userId = ?
         order by createdAt asc, id asc`,
        [userId],
      );
      return rows;
    } catch (camelError) {
      const [rows] = await connection.execute(
        `select id, user_id as userId, chat_session_id as chatSessionId, role, content, created_at as createdAt
         from chat_messages
         where user_id = ?
         order by created_at asc, id asc`,
        [userId],
      );
      return rows;
    }
  } finally {
    await connection.end();
  }
}

async function deleteMem0UserMemories(userId) {
  await axios.delete(mem0Url('/memories'), {
    headers: mem0Headers(),
    params: { user_id: String(userId) },
    data: { user_id: String(userId) },
    timeout: 30000,
  });
}

async function addMem0Batch(userId, batchId, messages) {
  const messageIds = messages.map((message) => message.id);
  await axios.post(
    mem0Url('/memories'),
    {
      user_id: String(userId),
      messages: messages.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
      })),
      metadata: {
        userId,
        sessionId: messages[messages.length - 1]?.chatSessionId || null,
        batchId,
        messageIds,
      },
    },
    {
      headers: mem0Headers(),
      timeout: 120000,
    },
  );
}

function normalizeMem0List(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.memories)
        ? payload.memories
        : [];

  return raw.map((item) => ({
    id: item.id || null,
    memory: item.memory || item.text || item.content || '',
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
    metadata: item.metadata || {},
    createdAt: item.created_at || item.createdAt || null,
    updatedAt: item.updated_at || item.updatedAt || null,
  })).filter((item) => item.memory);
}

async function getMem0Memories(userId) {
  const response = await axios.get(mem0Url('/memories'), {
    headers: mem0Headers(),
    params: { user_id: String(userId) },
    timeout: 30000,
  });
  return normalizeMem0List(response.data);
}

async function searchMem0(userId, query, limit) {
  const response = await axios.post(
    mem0Url('/search'),
    {
      user_id: String(userId),
      query,
      limit,
    },
    {
      headers: mem0Headers(),
      timeout: 30000,
    },
  );
  return normalizeMem0List(response.data);
}

async function getEmbedding(text) {
  const response = await axios.post(
    process.env.DASHSCOPE_EMBEDDING_URL || 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
    {
      model: process.env.DASHSCOPE_EMBEDDING_MODEL || 'text-embedding-v3',
      input: { texts: [text] },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${requireValue(process.env.DASHSCOPE_API_KEY, 'DASHSCOPE_API_KEY')}`,
      },
      timeout: 30000,
    },
  );

  const embedding = response.data?.output?.embeddings?.[0]?.embedding;
  if (!embedding) {
    throw new Error('DashScope embedding response did not contain an embedding');
  }
  return embedding;
}

function mapCustomPoint(point) {
  const payload = point.payload || {};
  return {
    id: String(point.id),
    score: Number.isFinite(Number(point.score)) ? Number(point.score) : null,
    scene: payload.scene || '',
    points: Array.isArray(payload.points) ? payload.points : [],
    entities: Array.isArray(payload.entities) ? payload.entities : [],
    retrievalText: payload.retrievalText || '',
    memoryDate: payload.memoryDate || payload.date || '',
    sourceImpressionId: payload.sourceImpressionId || null,
    rootImpressionId: payload.rootImpressionId || String(point.id),
    createdAt: payload.createdAt || '',
    updatedAt: payload.updatedAt || '',
  };
}

async function exportCustomImpressions(userId) {
  const qdrantUrl = requireValue(process.env.QDRANT_URL, 'QDRANT_URL').replace(/\/+$/, '');
  const collection = process.env.QDRANT_COLLECTION_NAME || 'user_impressions';
  const response = await axios.post(
    `${qdrantUrl}/collections/${collection}/points/scroll`,
    {
      filter: {
        must: [{ key: 'userId', match: { value: userId } }],
      },
      with_payload: true,
      limit: 1000,
    },
    { timeout: 30000 },
  );

  return (response.data?.result?.points || []).map(mapCustomPoint);
}

async function searchCustom(userId, query, limit) {
  const qdrantUrl = requireValue(process.env.QDRANT_URL, 'QDRANT_URL').replace(/\/+$/, '');
  const collection = process.env.QDRANT_COLLECTION_NAME || 'user_impressions';
  const vector = await getEmbedding(query);
  const response = await axios.post(
    `${qdrantUrl}/collections/${collection}/points/search`,
    {
      vector,
      limit,
      with_payload: true,
      filter: {
        must: [{ key: 'userId', match: { value: userId } }],
      },
    },
    { timeout: 30000 },
  );

  return (response.data?.result || []).map(mapCustomPoint);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.userId) || args.userId <= 0) {
    throw new Error('Usage: node scripts/replay-mem0-from-chat-messages.cjs --user-id <id> [--batch-size 10] [--limit 6] [--queries "query1|query2"]');
  }

  const outputDir = path.join(rootDir, 'test-results', 'memory-compare', `user-${args.userId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const messages = await loadChatMessages(args.userId);
  console.log(`[ReplayMem0] Loaded ${messages.length} chat messages for user ${args.userId}`);

  console.log('[ReplayMem0] Clearing Mem0 memories for user');
  await deleteMem0UserMemories(args.userId);

  for (let index = 0; index < messages.length; index += args.batchSize) {
    const batch = messages.slice(index, index + args.batchSize);
    const batchId = `${args.userId}_replay_${index / args.batchSize + 1}`;
    await addMem0Batch(args.userId, batchId, batch);
    console.log(`[ReplayMem0] Replayed ${batchId}: ${batch.length} messages`);
  }

  const [customImpressions, mem0Memories] = await Promise.all([
    exportCustomImpressions(args.userId),
    getMem0Memories(args.userId),
  ]);

  const searchResults = [];
  for (const query of args.queries) {
    const [custom, mem0] = await Promise.all([
      searchCustom(args.userId, query, args.limit),
      searchMem0(args.userId, query, args.limit),
    ]);
    searchResults.push({ query, custom, mem0 });
  }

  fs.writeFileSync(path.join(outputDir, 'custom-impressions.json'), JSON.stringify(customImpressions, null, 2));
  fs.writeFileSync(path.join(outputDir, 'mem0-memories.json'), JSON.stringify(mem0Memories, null, 2));
  fs.writeFileSync(path.join(outputDir, 'search-results.json'), JSON.stringify(searchResults, null, 2));

  console.log(`[ReplayMem0] Wrote comparison files to ${outputDir}`);
}

main().catch((error) => {
  console.error('[ReplayMem0] Failed:', error?.message || error);
  process.exitCode = 1;
});
