#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ConfigService } = require('@nestjs/config');

function loadEnvFile(filePath) {
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
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function requireBuiltModule(relativePath) {
  return require(path.join(__dirname, '..', 'dist', relativePath));
}

async function clearUserPoints(qdrantUrl, collection, userId) {
  await axios.post(
    `${qdrantUrl}/collections/${collection}/points/delete?wait=true`,
    {
      filter: {
        must: [
          {
            key: 'userId',
            match: { value: userId },
          },
        ],
      },
    },
  );
}

async function listUserPoints(qdrantUrl, collection, userId) {
  const response = await axios.post(
    `${qdrantUrl}/collections/${collection}/points/scroll`,
    {
      limit: 50,
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
    },
  );

  const points = response.data.result?.points || [];
  return points
    .map((point) => ({
      id: String(point.id),
      scene: point.payload?.scene || '',
      points: point.payload?.points || [],
      retrievalText: point.payload?.retrievalText || '',
      originType: point.payload?.originType || 'standalone',
      sourceImpressionId: point.payload?.sourceImpressionId || null,
      rootImpressionId: point.payload?.rootImpressionId || String(point.id),
      updatedAt: point.payload?.updatedAt || point.payload?.createdAt || '',
    }))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function buildBatchMessages(caseData, batch) {
  const byId = new Map(caseData.messages.map((message) => [message.id, message]));
  const newIds = new Set(batch.newMessageIds);

  return batch.windowMessageIds.map((id) => {
    const message = byId.get(id);
    if (!message) {
      throw new Error(`Unknown message id ${id} in batch ${batch.name}`);
    }

    return {
      messageId: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
      isNew: newIds.has(id),
    };
  });
}

function buildGoldenSummary(caseData) {
  if (caseData.golden_final?.impressions) {
    return caseData.golden_final.impressions;
  }

  if (caseData.golden_final?.latestScene) {
    return [{
      scene: caseData.golden_final.latestScene,
      points: caseData.golden_final.latestPoints || [],
    }];
  }

  return caseData.golden_final || null;
}

async function main() {
  const envPath = path.join(__dirname, '..', '.env.development');
  loadEnvFile(envPath);
  process.env.DASHSCOPE_ENABLE_THINKING = process.env.DASHSCOPE_ENABLE_THINKING || 'false';
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';

  const caseFile = process.argv[2] || 'cases/movie-plan-boundary.json';
  const casePath = path.isAbsolute(caseFile)
    ? caseFile
    : path.join(__dirname, '..', 'testing', caseFile);
  const caseData = JSON.parse(fs.readFileSync(casePath, 'utf8'));

  const configuration = requireBuiltModule(path.join('config', 'configuration')).default;
  const { DashscopeService } = requireBuiltModule(path.join('services', 'dashscope.service'));
  const { QdrantService } = requireBuiltModule(path.join('services', 'qdrant.service'));

  const configService = new ConfigService(configuration());
  const dashscopeService = new DashscopeService(configService);
  const qdrantService = new QdrantService(configService, dashscopeService);

  qdrantService.recordImpressionEdge = async () => {};
  qdrantService.recordImpressionMessageLinks = async () => {};

  const qdrantUrl = configService.get('qdrant.url');
  const collection = configService.get('qdrant.collectionName');
  const userId = Number(process.env.REPLAY_USER_ID || caseData.userId);
  const sessionId = `${caseData.sessionId}-${Date.now()}`;

  await qdrantService.ensureCollection();
  await clearUserPoints(qdrantUrl, collection, userId);

  const result = {
    case: caseData.name,
    description: caseData.description,
    userId,
    sessionId,
    golden: buildGoldenSummary(caseData),
    batches: [],
  };

  for (const [batchIndex, batch] of caseData.batches.entries()) {
    const messages = buildBatchMessages(caseData, batch);
    const drafts = await dashscopeService.generateRetrievalDrafts(messages);
    const recalled = await qdrantService.__proto__.recallImpressionsForDrafts.call(
      qdrantService,
      userId,
      drafts,
    );
    const finalImpressions = await dashscopeService.generateFinalImpressions({
      messages,
      retrievedImpressions: recalled,
    });

    await qdrantService.processSummaryJob({
      userId,
      sessionId,
      date: batch.memoryDate,
      batchId: `${userId}_${batch.memoryDate}_replay_${batchIndex + 1}`,
      messages,
    });

    result.batches.push({
      batch: batch.name,
      memoryDate: batch.memoryDate,
      drafts,
      recalled: recalled.map((item) => ({
        id: item.id,
        scene: item.scene,
        points: item.points,
        effectiveScore: item.effectiveScore || 0,
        relevanceScore: item.relevanceScore || 0,
      })),
      finalImpressions,
      currentImpressions: await listUserPoints(qdrantUrl, collection, userId),
    });
  }

  result.final = {
    allImpressions: await listUserPoints(qdrantUrl, collection, userId),
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
