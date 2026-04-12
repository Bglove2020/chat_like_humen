#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '../..');

function requireFromWorkspace(modulePath) {
  const candidates = [
    path.join(rootDir, 'worker', 'node_modules', modulePath),
    path.join(rootDir, 'backend', 'node_modules', modulePath),
    path.join(rootDir, 'node_modules', modulePath),
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_error) {
      // Try next location.
    }
  }

  return require(modulePath);
}

const mysql = requireFromWorkspace('mysql2/promise');
const axios = requireFromWorkspace('axios');
const { Queue, QueueEvents } = requireFromWorkspace('bullmq');
const { NestFactory } = requireFromWorkspace('@nestjs/core');
const FLUSH_THRESHOLD = 10;
const FLUSH_TIMEOUT_MS = 2 * 60 * 1000;
const HISTORY_LIMIT = 15;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    return env;
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
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function mergeEnv(...items) {
  return Object.assign({}, ...items);
}

function parseArgs(argv) {
  const args = {
    username: 'zhangxurui',
    timeoutMs: 10 * 60 * 1000,
    mode: 'direct',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--username' && next) {
      args.username = next;
      index += 1;
    } else if (arg === '--timeout-ms' && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--mode' && next) {
      args.mode = next;
      index += 1;
    }
  }

  return args;
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(`Missing required value: ${name}`);
  }
  return value;
}

function buildMysqlConfig(env) {
  return {
    host: requireValue(env.DB_HOST, 'DB_HOST'),
    port: Number.parseInt(requireValue(env.DB_PORT, 'DB_PORT'), 10),
    user: requireValue(env.DB_USER, 'DB_USER'),
    password: env.DB_PASSWORD || '',
    database: requireValue(env.DB_NAME, 'DB_NAME'),
    charset: 'utf8mb4',
  };
}

function getTimeZoneParts(date, timeZone = 'Asia/Shanghai') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
}

function computeMemoryDate(reference) {
  const date = reference instanceof Date ? reference : new Date(reference);
  const parts = getTimeZoneParts(date, 'Asia/Shanghai');
  const shifted = new Date(Date.UTC(
    Number.parseInt(parts.year, 10),
    Number.parseInt(parts.month, 10) - 1,
    Number.parseInt(parts.day, 10),
    Number.parseInt(parts.hour, 10),
    Number.parseInt(parts.minute, 10),
    Number.parseInt(parts.second, 10),
  ));
  shifted.setUTCHours(shifted.getUTCHours() - 5);
  return shifted.toISOString().slice(0, 10);
}

function buildRedisConnection(env) {
  return {
    host: requireValue(env.REDIS_HOST, 'REDIS_HOST'),
    port: Number.parseInt(requireValue(env.REDIS_PORT, 'REDIS_PORT'), 10),
    password: env.REDIS_PASSWORD || '',
  };
}

async function waitWithTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadProdConversation(connection, username) {
  const [[user]] = await connection.execute(
    'select id, username, password, createdAt from users where username = ? limit 1',
    [username],
  );

  if (!user) {
    throw new Error(`Production user not found: ${username}`);
  }

  const [sessions] = await connection.execute(
    `select id, title, difyConversationId, createdAt, updatedAt
     from chat_sessions
     where userId = ?
     order by createdAt asc, id asc`,
    [user.id],
  );

  const [messages] = await connection.execute(
    `select id, role, chatSessionId, content, createdAt
     from chat_messages
     where userId = ?
     order by createdAt asc, id asc`,
    [user.id],
  );

  return {
    user,
    sessions,
    messages,
  };
}

async function ensureDevUser(connection, prodUser) {
  const [[existing]] = await connection.execute(
    'select id from users where username = ? limit 1',
    [prodUser.username],
  );

  if (existing) {
    await connection.execute(
      'update users set password = ? where id = ?',
      [prodUser.password, existing.id],
    );
    return existing.id;
  }

  const [result] = await connection.execute(
    'insert into users (username, password, createdAt) values (?, ?, ?)',
    [prodUser.username, prodUser.password, prodUser.createdAt],
  );
  return result.insertId;
}

async function clearDevUserData(connection, devUserId) {
  await connection.execute(
    `delete pml
     from point_message_links pml
     inner join memory_points mp on mp.id = pml.point_id
     where mp.user_id = ?`,
    [devUserId],
  ).catch(() => null);

  await connection.execute(
    `delete prl
     from point_revision_logs prl
     inner join memory_points mp on mp.id = prl.point_id
     where mp.user_id = ?`,
    [devUserId],
  ).catch(() => null);

  await connection.execute('delete from memory_points where user_id = ?', [devUserId]).catch(() => null);
  await connection.execute('delete from memory_lines where user_id = ?', [devUserId]).catch(() => null);
  await connection.execute('delete from impression_message_links where impressionId like ?', [`user-${devUserId}-%`]).catch(() => null);
  await connection.execute('delete from impression_edges where userId = ?', [devUserId]).catch(() => null);
  await connection.execute('delete from user_profiles where user_id = ?', [devUserId]).catch(() => null);
  await connection.execute('delete from chat_messages where userId = ?', [devUserId]);
  await connection.execute('delete from chat_sessions where userId = ?', [devUserId]);
}

async function clearDevQdrantUser(qdrantUrl, collectionName, userId) {
  const response = await axios.post(
    `${qdrantUrl}/collections/${collectionName}/points/scroll`,
    {
      limit: 1000,
      with_payload: false,
      filter: {
        must: [
          {
            key: 'userId',
            match: { value: userId },
          },
        ],
      },
    },
  ).catch(() => ({ data: { result: { points: [] } } }));

  const pointIds = (response.data.result?.points || []).map((point) => point.id);
  if (!pointIds.length) {
    return;
  }

  await axios.post(
    `${qdrantUrl}/collections/${collectionName}/points/delete`,
    {
      points: pointIds,
    },
  );
}

async function importSessions(connection, devUserId, sessions) {
  for (const session of sessions) {
    await connection.execute(
      `insert into chat_sessions (id, userId, title, difyConversationId, createdAt, updatedAt)
       values (?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        devUserId,
        session.title,
        session.difyConversationId,
        session.createdAt,
        session.updatedAt,
      ],
    );
  }
}

async function importMessages(connection, devUserId, messages) {
  const imported = [];

  for (const message of messages) {
    const [result] = await connection.execute(
      `insert into chat_messages (userId, role, chatSessionId, content, createdAt)
       values (?, ?, ?, ?, ?)`,
      [
        devUserId,
        message.role,
        message.chatSessionId,
        message.content,
        message.createdAt,
      ],
    );

    imported.push({
      id: result.insertId,
      role: message.role,
      chatSessionId: message.chatSessionId,
      content: message.content,
      createdAt: new Date(message.createdAt).toISOString(),
    });
  }

  return imported;
}

function buildSummaryPayload(importedMessages, newMessages, latestTimestamp) {
  if (newMessages.length >= HISTORY_LIMIT) {
    return newMessages.slice(-HISTORY_LIMIT).map((message) => ({
      messageId: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
      isNew: true,
    }));
  }

  const sessionId = newMessages[0]?.chatSessionId || null;
  const cutoff = new Date(new Date(latestTimestamp).getTime() - RECENT_WINDOW_MS);
  const historicalMessages = importedMessages
    .filter((message) => message.chatSessionId === sessionId)
    .filter((message) => new Date(message.createdAt) <= new Date(latestTimestamp))
    .filter((message) => new Date(message.createdAt) > cutoff)
    .slice(-HISTORY_LIMIT)
    .map((message) => ({
      messageId: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
      isNew: false,
    }));

  const newMessageIds = new Set(newMessages.map((message) => message.id));
  const historicalContext = historicalMessages.filter((message) => !newMessageIds.has(message.messageId));
  const historyLimit = Math.max(0, HISTORY_LIMIT - newMessages.length);

  return [
    ...historicalContext.slice(-historyLimit),
    ...newMessages.map((message) => ({
      messageId: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
      isNew: true,
    })),
  ].slice(-HISTORY_LIMIT);
}

function buildReplayBatches(importedMessages) {
  const batches = [];
  let pending = [];
  let lastTimestamp = null;

  const flushPending = () => {
    if (!pending.length) {
      return;
    }

    const latestTimestamp = pending[pending.length - 1].createdAt;
    batches.push({
      sessionId: pending[0].chatSessionId,
      memoryDate: computeMemoryDate(latestTimestamp),
      messages: buildSummaryPayload(importedMessages, pending, latestTimestamp),
    });
    pending = [];
  };

  for (const message of importedMessages) {
    if (lastTimestamp) {
      const gapMs = new Date(message.createdAt).getTime() - new Date(lastTimestamp).getTime();
      if (gapMs > FLUSH_TIMEOUT_MS) {
        flushPending();
      }
    }

    pending.push(message);
    lastTimestamp = message.createdAt;

    if (pending.length >= FLUSH_THRESHOLD) {
      flushPending();
    }
  }

  flushPending();
  return batches;
}

async function waitForJobs(queue, queueEvents, devUserId, batches, timeoutMs) {
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchId = `${devUserId}_${batch.memoryDate}_replay_${index + 1}_${Date.now()}`;
    const job = await queue.add(
      'summary',
      {
        userId: devUserId,
        sessionId: batch.sessionId,
        date: batch.memoryDate,
        batchId,
        messages: batch.messages,
      },
      {
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: false,
      },
    );

    await waitWithTimeout(
      job.waitUntilFinished(queueEvents),
      timeoutMs,
      `summary replay batch ${batchId}`,
    );

    console.log(
      `[ReplayMemory] Finished batch ${index + 1}/${batches.length}: memoryDate=${batch.memoryDate} messages=${batch.messages.length}`,
    );
  }
}

async function processBatchesDirectly(devUserId, batches) {
  requireFromWorkspace('reflect-metadata');
  const { AppModule } = require(path.join(rootDir, 'worker', 'dist', 'app.module'));
  const { QdrantService } = require(path.join(rootDir, 'worker', 'dist', 'services', 'qdrant.service'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const qdrantService = app.get(QdrantService);
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchId = `${devUserId}_${batch.memoryDate}_direct_${index + 1}`;
      await qdrantService.processSummaryJob({
        userId: devUserId,
        sessionId: batch.sessionId,
        date: batch.memoryDate,
        batchId,
        messages: batch.messages,
      });
      console.log(
        `[ReplayMemory] Finished batch ${index + 1}/${batches.length}: memoryDate=${batch.memoryDate} messages=${batch.messages.length}`,
      );
    }
  } finally {
    await app.close();
  }
}

async function fetchFinalSummary(connection, qdrantUrl, collectionName, userId) {
  const [lineRows] = await connection.execute(
    `select id, anchor_label as anchorLabel, impression_label as impressionLabel, impression_abstract as impressionAbstract,
            impression_version as impressionVersion, salience_score as salienceScore, last_activated_at as lastActivatedAt
     from memory_lines
     where user_id = ?
     order by last_activated_at desc, updated_at desc`,
    [userId],
  );
  const [pointRows] = await connection.execute(
    `select id, line_id as lineId, op, source_point_id as sourcePointId, text, memory_date as memoryDate,
            salience_score as salienceScore, created_at as createdAt, updated_at as updatedAt
     from memory_points
     where user_id = ?
     order by created_at asc`,
    [userId],
  );

  const qdrantResponse = await axios.post(
    `${qdrantUrl}/collections/${collectionName}/points/scroll`,
    {
      limit: 1000,
      with_payload: true,
      filter: {
        must: [
          {
            key: 'userId',
            match: { value: userId },
          },
        ],
      },
    },
  ).catch(() => ({ data: { result: { points: [] } } }));

  return {
    lines: lineRows,
    points: pointRows,
    qdrantPoints: qdrantResponse.data.result?.points || [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const prodBackendEnv = mergeEnv(
    loadEnvFile(path.join(rootDir, 'backend', '.env.production')),
    loadEnvFile(path.join(rootDir, 'worker', '.env.production')),
  );
  const devBackendEnv = mergeEnv(
    loadEnvFile(path.join(rootDir, 'backend', '.env.development')),
    loadEnvFile(path.join(rootDir, 'worker', '.env.development')),
  );

  const prodDb = await mysql.createConnection(buildMysqlConfig(prodBackendEnv));
  const devDb = await mysql.createConnection(buildMysqlConfig(devBackendEnv));
  const queue = args.mode === 'queue'
    ? new Queue('chat-summary-queue', {
      connection: buildRedisConnection(devBackendEnv),
      prefix: 'bull',
    })
    : null;
  const queueEvents = args.mode === 'queue'
    ? new QueueEvents('chat-summary-queue', {
      connection: buildRedisConnection(devBackendEnv),
      prefix: 'bull',
    })
    : null;

  if (queueEvents) {
    await queueEvents.waitUntilReady();
  }

  try {
    Object.assign(process.env, devBackendEnv);
    const prodConversation = await loadProdConversation(prodDb, args.username);
    const devUserId = await ensureDevUser(devDb, prodConversation.user);

    await clearDevUserData(devDb, devUserId);
    await clearDevQdrantUser(
      requireValue(devBackendEnv.QDRANT_URL, 'QDRANT_URL'),
      requireValue(devBackendEnv.QDRANT_COLLECTION_NAME, 'QDRANT_COLLECTION_NAME'),
      devUserId,
    );

    await importSessions(devDb, devUserId, prodConversation.sessions);
    const importedMessages = await importMessages(devDb, devUserId, prodConversation.messages);
    const batches = buildReplayBatches(importedMessages);

    console.log(
      `[ReplayMemory] Imported ${importedMessages.length} messages for dev user ${devUserId} (${args.username}); replaying ${batches.length} batches in ${args.mode} mode`,
    );

    if (args.mode === 'queue') {
      await waitForJobs(queue, queueEvents, devUserId, batches, args.timeoutMs);
    } else {
      await processBatchesDirectly(devUserId, batches);
    }

    const summary = await fetchFinalSummary(
      devDb,
      requireValue(devBackendEnv.QDRANT_URL, 'QDRANT_URL'),
      requireValue(devBackendEnv.QDRANT_COLLECTION_NAME, 'QDRANT_COLLECTION_NAME'),
      devUserId,
    );

    console.log(`[ReplayMemory] Final lines: ${summary.lines.length}`);
    for (const line of summary.lines) {
      console.log(`- ${line.anchorLabel} | ${line.impressionLabel}`);
      if (line.impressionAbstract) {
        console.log(`  ${line.impressionAbstract}`);
      }
    }
    console.log(`[ReplayMemory] Total points: ${summary.points.length}`);
    console.log(`[ReplayMemory] Qdrant leaf points: ${summary.qdrantPoints.length}`);
    console.log(`[ReplayMemory] Dev user id: ${devUserId}`);
  } finally {
    if (queueEvents) {
      await queueEvents.close();
    }
    if (queue) {
      await queue.close();
    }
    await prodDb.end();
    await devDb.end();
  }
}

main().catch((error) => {
  console.error('[ReplayMemory] Failed:', error?.message || error);
  process.exitCode = 1;
});
