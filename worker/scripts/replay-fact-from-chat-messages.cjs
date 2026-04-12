#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { Queue, QueueEvents } = require('bullmq');

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
    timeoutMs: 10 * 60 * 1000,
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
    } else if (arg === '--timeout-ms' && next) {
      args.timeoutMs = Number.parseInt(next, 10);
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
    } catch {
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

function buildRedisConnection() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || '',
  };
}

function chunkMessages(messages, batchSize) {
  const batches = [];
  for (let index = 0; index < messages.length; index += batchSize) {
    batches.push(messages.slice(index, index + batchSize));
  }
  return batches;
}

function mapFactMessages(batch) {
  return batch
    .filter((message) => message.role === 'user')
    .filter((message) => String(message.content || '').trim())
    .map((message) => ({
      messageId: Number(message.id),
      role: 'user',
      content: String(message.content || ''),
      timestamp: new Date(message.createdAt).toISOString(),
    }));
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.userId) || args.userId <= 0) {
    throw new Error('Usage: node scripts/replay-fact-from-chat-messages.cjs --user-id <id> [--batch-size 10] [--timeout-ms 600000]');
  }

  requireValue(process.env.REDIS_HOST || 'localhost', 'REDIS_HOST');

  const allMessages = await loadChatMessages(args.userId);
  if (!allMessages.length) {
    console.log(`[ReplayFact] No chat messages found for user ${args.userId}`);
    return;
  }

  const batches = chunkMessages(allMessages, args.batchSize);
  const connection = buildRedisConnection();
  const queue = new Queue('chat-fact-queue', {
    connection,
    prefix: 'bull',
  });
  const queueEvents = new QueueEvents('chat-fact-queue', {
    connection,
    prefix: 'bull',
  });

  await queueEvents.waitUntilReady();

  try {
    console.log(`[ReplayFact] Loaded ${allMessages.length} messages for user ${args.userId}; replaying ${batches.length} chronological batches`);

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const factMessages = mapFactMessages(batch);

      if (!factMessages.length) {
        console.log(`[ReplayFact] Skip batch ${index + 1}/${batches.length}: no user messages`);
        continue;
      }

      const batchId = `${args.userId}_fact_replay_${index + 1}`;
      const job = await queue.add(
        'fact',
        {
          userId: args.userId,
          batchId,
          messages: factMessages,
        },
        {
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: false,
        },
      );

      await waitWithTimeout(
        job.waitUntilFinished(queueEvents),
        args.timeoutMs,
        `fact replay batch ${batchId}`,
      );

      console.log(
        `[ReplayFact] Finished ${batchId}: totalMessages=${batch.length}, userMessages=${factMessages.length}`,
      );
    }
  } finally {
    await queueEvents.close();
    await queue.close();
  }
}

main().catch((error) => {
  console.error('[ReplayFact] Failed:', error?.message || error);
  process.exitCode = 1;
});
