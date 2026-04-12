#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ConfigService } = require('@nestjs/config');

function requireLocalOrBackend(moduleName) {
  try {
    return require(moduleName);
  } catch {
    return require(path.join(__dirname, '..', '..', 'backend', 'node_modules', moduleName));
  }
}

const mysql = requireLocalOrBackend('mysql2/promise');

function parseEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf8');

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    env[key] = value;
  }

  return env;
}

function loadIntoProcessEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}

function requireBuiltModule(relativePath) {
  return require(path.join(__dirname, '..', 'dist', relativePath));
}

async function queryRows(connectionConfig, sql, params = []) {
  const connection = await mysql.createConnection(connectionConfig);
  try {
    const [rows] = await connection.execute(sql, params);
    return rows;
  } finally {
    await connection.end();
  }
}

async function listQdrantImpressions(qdrantUrl, collection, userId) {
  const response = await axios.post(`${qdrantUrl}/collections/${collection}/points/scroll`, {
    limit: 100,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [
        {
          key: 'userId',
          match: { value: userId },
        },
      ],
    },
  });

  return (response.data.result?.points || [])
    .map((point) => ({
      id: String(point.id),
      scene: point.payload?.scene || '',
      points: point.payload?.points || [],
      entities: point.payload?.entities || [],
      retrievalText: point.payload?.retrievalText || '',
      sessionId: point.payload?.sessionId || null,
      sourceImpressionId: point.payload?.sourceImpressionId || null,
      rootImpressionId: point.payload?.rootImpressionId || String(point.id),
      originType: point.payload?.originType || 'standalone',
      memoryDate: point.payload?.memoryDate || point.payload?.date || '',
      createdAt: point.payload?.createdAt || '',
      updatedAt: point.payload?.updatedAt || point.payload?.createdAt || '',
      lastActivatedAt: point.payload?.lastActivatedAt || point.payload?.updatedAt || '',
      salienceScore: point.payload?.salienceScore || 1,
    }))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

async function seedReplayImpressions(qdrantUrl, collection, replayUserId, impressions, dashscopeService) {
  for (const impression of impressions) {
    const vector = await dashscopeService.getEmbedding(impression.retrievalText);
    await axios.put(`${qdrantUrl}/collections/${collection}/points`, {
      points: [
        {
          id: impression.id,
          vector,
          payload: {
            userId: replayUserId,
            sessionId: impression.sessionId || null,
            memoryDate: impression.memoryDate || '',
            date: impression.memoryDate || '',
            scene: impression.scene,
            points: impression.points,
            entities: impression.entities || [],
            retrievalText: impression.retrievalText,
            content: [impression.scene, ...(impression.points || []).map((item) => `- ${item}`)].join('\n'),
            createdAt: impression.createdAt || impression.updatedAt || new Date().toISOString(),
            updatedAt: impression.updatedAt || impression.createdAt || new Date().toISOString(),
            salienceScore: impression.salienceScore || 1,
            lastActivatedAt: impression.lastActivatedAt || impression.updatedAt || impression.createdAt || new Date().toISOString(),
            originType: impression.originType || 'standalone',
            sourceImpressionId: impression.sourceImpressionId || null,
            rootImpressionId: impression.rootImpressionId || impression.id,
          },
        },
      ],
    });
  }
}

async function clearReplayUser(qdrantUrl, collection, userId) {
  await axios.post(`${qdrantUrl}/collections/${collection}/points/delete?wait=true`, {
    filter: {
      must: [
        {
          key: 'userId',
          match: { value: userId },
        },
      ],
    },
  });
}

function buildBatchWindow(allMessages, newMessageIds) {
  const newSet = new Set(newMessageIds);
  const maxId = Math.max(...newMessageIds);
  const window = allMessages.filter((message) => message.id <= maxId).slice(-15);

  return window.map((message) => ({
    messageId: message.id,
    role: message.role,
    content: message.content,
    timestamp: new Date(message.createdAt).toISOString(),
    isNew: newSet.has(message.id),
  }));
}

async function main() {
  const originalConsoleLog = console.log;
  console.log = (...args) => {
    process.stderr.write(`${args.map((item) => String(item)).join(' ')}\n`);
  };

  const username = process.argv[2] || 'zhangxurui';
  const replayUserId = Number(process.argv[3] || '910001');
  const startDate = process.argv[4] || '';

  const backendProdEnv = parseEnvFile(path.join(__dirname, '..', '..', 'backend', '.env.production'));
  const workerDevEnv = parseEnvFile(path.join(__dirname, '..', '.env.development'));

  loadIntoProcessEnv(workerDevEnv);
  process.env.NODE_ENV = 'development';
  process.env.DASHSCOPE_ENABLE_THINKING = process.env.DASHSCOPE_ENABLE_THINKING || 'false';

  const dbConfig = {
    host: backendProdEnv.DB_HOST,
    port: Number(backendProdEnv.DB_PORT || '3306'),
    user: backendProdEnv.DB_USER,
    password: backendProdEnv.DB_PASSWORD,
    database: backendProdEnv.DB_NAME,
    charset: 'utf8mb4',
  };

  const users = await queryRows(
    dbConfig,
    'SELECT id, username FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  if (!users.length) {
    throw new Error(`User not found: ${username}`);
  }

  const prodUserId = Number(users[0].id);
  const allMessages = await queryRows(
    dbConfig,
    'SELECT id, role, chatSessionId, content, createdAt FROM chat_messages WHERE userId = ? ORDER BY id ASC',
    [prodUserId],
  );
  const batches = await queryRows(
    dbConfig,
    `
      SELECT
        l.batchId AS batchId,
        MIN(l.messageId) AS minMessageId,
        MAX(l.messageId) AS maxMessageId,
        GROUP_CONCAT(l.messageId ORDER BY l.messageId ASC) AS messageIds
      FROM impression_message_links l
      INNER JOIN chat_messages m ON m.id = l.messageId
      WHERE m.userId = ?
      GROUP BY l.batchId
      ORDER BY minMessageId ASC
    `,
    [prodUserId],
  );

  const prodQdrantUrl = backendProdEnv.QDRANT_URL;
  const prodCollection = backendProdEnv.QDRANT_COLLECTION_NAME || 'user_impressions';
  const baselineImpressions = await listQdrantImpressions(prodQdrantUrl, prodCollection, prodUserId);

  const configuration = requireBuiltModule(path.join('config', 'configuration')).default;
  const { DashscopeService } = requireBuiltModule(path.join('services', 'dashscope.service'));
  const { QdrantService } = requireBuiltModule(path.join('services', 'qdrant.service'));

  const configService = new ConfigService(configuration());
  const dashscopeService = new DashscopeService(configService);
  const qdrantService = new QdrantService(configService, dashscopeService);
  qdrantService.recordImpressionEdge = async () => {};
  qdrantService.recordImpressionMessageLinks = async () => {};

  const replayQdrantUrl = configService.get('qdrant.url');
  const replayCollection = configService.get('qdrant.collectionName');
  await qdrantService.ensureCollection();
  await clearReplayUser(replayQdrantUrl, replayCollection, replayUserId);

  if (startDate) {
    await seedReplayImpressions(
      replayQdrantUrl,
      replayCollection,
      replayUserId,
      baselineImpressions.filter((item) => item.memoryDate && item.memoryDate < startDate),
      dashscopeService,
    );
  }

  const sessionId = allMessages.find((message) => message.chatSessionId)?.chatSessionId || `replay-${Date.now()}`;
  const replayTrace = [];

  for (const batch of batches) {
    const batchDate = String(batch.batchId).split('_')[1] || '';
    if (startDate && batchDate < startDate) {
      continue;
    }

    const newMessageIds = String(batch.messageIds || '')
      .split(',')
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0);

    if (!newMessageIds.length) {
      continue;
    }

    const messages = buildBatchWindow(allMessages, newMessageIds);
    const date = batchDate || messages[messages.length - 1].timestamp.slice(0, 10);

    await qdrantService.processSummaryJob({
      userId: replayUserId,
      sessionId,
      date,
      batchId: `${batch.batchId}_replay`,
      messages,
    });

    replayTrace.push({
      batchId: batch.batchId,
      date,
      newMessageIds,
      replayImpressions: await listQdrantImpressions(replayQdrantUrl, replayCollection, replayUserId),
    });
  }

  const report = {
    username,
    prodUserId,
    replayUserId,
    startDate: startDate || null,
    messageCount: allMessages.length,
    batchCount: batches.length,
    baselineImpressions,
    replayImpressions: await listQdrantImpressions(replayQdrantUrl, replayCollection, replayUserId),
    replayTrace,
  };

  console.log = originalConsoleLog;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
