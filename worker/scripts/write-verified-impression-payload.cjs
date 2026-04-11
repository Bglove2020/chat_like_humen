#!/usr/bin/env node

const path = require('path');
const { ConfigService } = require('@nestjs/config');

function loadEnvFile(filePath) {
  const fs = require('fs');
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

class LocalDashscopeStub {
  constructor(dim) {
    this.dim = dim;
  }

  async getEmbedding(text) {
    const vector = new Array(this.dim).fill(0);
    let seed = 0;

    for (let i = 0; i < text.length; i += 1) {
      seed = (seed + text.charCodeAt(i) * (i + 1)) % 104729;
    }

    for (let i = 0; i < this.dim; i += 1) {
      vector[i] = ((seed + i * 31) % 1000) / 1000;
    }

    return vector;
  }
}

async function main() {
  loadEnvFile(path.join(__dirname, '..', '.env.development'));

  const configuration = require(path.join(__dirname, '..', 'dist', 'config', 'configuration')).default;
  const { QdrantService } = require(path.join(__dirname, '..', 'dist', 'services', 'qdrant.service'));

  const configService = new ConfigService(configuration());
  const dim = Number(configService.get('dashscope.embeddingDim') || 1024);
  const qdrantService = new QdrantService(configService, new LocalDashscopeStub(dim));

  await qdrantService.ensureCollection();

  const result = await qdrantService.upsertImpression({
    userId: 990001,
    sessionId: 'verified-payload-session',
    date: '2026-04-07',
    scene: '聊电影《挽救计划》',
    points: [
      '我说自己了解电影细节，用户纠正我：作为 AI 没法真正看电影，只能从资料里知道情节。',
      '我把主角和外星人的关系说成 CP，用户不认可，觉得这种战友羁绊不该直接叫 CP。',
      '我又说自己能脑补那些感人的氛围，用户还是不买账。'
    ],
    retrievalText: '聊电影《挽救计划》时，我先被用户纠正不能把自己说成真的看过电影，后来又在 CP 和脑补氛围这两个点上继续被用户反驳。',
    action: 'create',
    originType: 'standalone',
    sourceImpressionId: null,
    rootImpressionId: null,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
