import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { QdrantService } from './qdrant.service';
import {
  CandidateImpressionDraft,
  ChatMessageInput,
  FinalImpressionDraft,
  Impression,
  RetrievalDrafts,
} from './dashscope.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

interface CaseMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface CaseBatch {
  name: string;
  memoryDate: string;
  windowMessageIds: number[];
  newMessageIds: number[];
  node1: RetrievalDrafts;
  node2: {
    impressions: Array<{
      sourceScene: string | null;
      scene: string;
      points: string[];
      retrievalText: string;
    }>;
  };
  retrievalExpectation?: {
    top1Scene?: string;
  };
}

interface ReplayCase {
  name: string;
  description: string;
  userId: number;
  sessionId: string;
  messages: CaseMessage[];
  batches: CaseBatch[];
  golden_final: any;
}

interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, any>;
}

function normalizeText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function buildMessages(caseData: ReplayCase, batch: CaseBatch): ChatMessageInput[] {
  const byId = new Map(caseData.messages.map((message) => [message.id, message]));
  const newMessageIds = new Set(batch.newMessageIds);

  return batch.windowMessageIds.map((messageId) => {
    const message = byId.get(messageId);
    if (!message) {
      throw new Error(`Unknown message id ${messageId}`);
    }

    return {
      messageId: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
      isNew: newMessageIds.has(messageId),
    };
  });
}

class InMemoryQdrantBackend {
  collectionExists = false;
  points = new Map<string, StoredPoint>();
  edges: Array<Record<string, any>> = [];
  links: Array<Record<string, any>> = [];

  private matchesFilter(payload: Record<string, any>, filter?: any): boolean {
    const must = filter?.must || [];
    return must.every((condition: any) => payload?.[condition.key] === condition?.match?.value);
  }

  private cosineSimilarity(left: number[], right: number[]): number {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const l = left[index] || 0;
      const r = right[index] || 0;
      dot += l * r;
      leftNorm += l * l;
      rightNorm += r * r;
    }

    if (!leftNorm || !rightNorm) {
      return 0;
    }

    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  }

  async get(url: string) {
    if (url.includes('/collections/')) {
      if (!this.collectionExists) {
        throw new Error('not found');
      }
      return { data: { result: { status: 'ok' } } };
    }

    throw new Error(`Unsupported GET ${url}`);
  }

  async put(url: string, body: any) {
    if (/\/collections\/[^/]+$/.test(url)) {
      this.collectionExists = true;
      return { data: { result: true } };
    }

    if (url.includes('/points')) {
      for (const point of body.points || []) {
        this.points.set(String(point.id), {
          id: String(point.id),
          vector: point.vector || [],
          payload: point.payload || {},
        });
      }
      return { data: { result: { operation_id: 1 } } };
    }

    throw new Error(`Unsupported PUT ${url}`);
  }

  async post(url: string, body: any) {
    if (url.includes('/api/internal/impression-edges')) {
      this.edges.push(body);
      return { data: { created: true } };
    }

    if (url.includes('/api/internal/impression-message-links')) {
      this.links.push(body);
      return { data: { created: body.messageIds?.length || 0 } };
    }

    if (url.includes('/points/search')) {
      const filter = body.filter;
      const limit = body.limit || 10;
      const results = Array.from(this.points.values())
        .filter((point) => this.matchesFilter(point.payload, filter))
        .map((point) => ({
          id: point.id,
          payload: point.payload,
          score: this.cosineSimilarity(body.vector || [], point.vector || []),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

      return { data: { result: results } };
    }

    if (url.includes('/points/scroll')) {
      const filter = body.filter;
      const limit = body.limit || 20;
      const withPayload = body.with_payload !== false;
      const points = Array.from(this.points.values())
        .filter((point) => this.matchesFilter(point.payload, filter))
        .sort((left, right) => new Date(
          right.payload.lastActivatedAt || right.payload.updatedAt || right.payload.createdAt,
        ).getTime() - new Date(
          left.payload.lastActivatedAt || left.payload.updatedAt || left.payload.createdAt,
        ).getTime())
        .slice(0, limit)
        .map((point) => ({
          id: point.id,
          payload: withPayload ? point.payload : undefined,
        }));

      return { data: { result: { points } } };
    }

    if (/\/collections\/[^/]+\/points$/.test(url) && Array.isArray(body.ids)) {
      return {
        data: {
          result: {
            points: body.ids
              .map((id: string) => this.points.get(String(id)))
              .filter((point): point is StoredPoint => Boolean(point))
              .map((point) => ({
                id: point.id,
                payload: point.payload,
              })),
          },
        },
      };
    }

    throw new Error(`Unsupported POST ${url}`);
  }

  listImpressions(): Array<Record<string, any>> {
    return Array.from(this.points.values())
      .map((point) => ({
        id: point.id,
        ...point.payload,
      }))
      .sort((left, right) => new Date(
        right.lastActivatedAt || right.updatedAt || right.createdAt,
      ).getTime() - new Date(
        left.lastActivatedAt || left.updatedAt || left.createdAt,
      ).getTime());
  }
}

class FixtureDashscopeService {
  constructor(private caseData: ReplayCase) {}

  private findBatch(messages: ChatMessageInput[]): CaseBatch {
    const key = messages
      .filter((message) => message.isNew !== false)
      .map((message) => message.messageId)
      .join(',');

    const batch = this.caseData.batches.find((item) => item.newMessageIds.join(',') === key);
    if (!batch) {
      throw new Error(`No fixture batch for new message ids ${key}`);
    }

    return batch;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const normalized = normalizeText(text);
    const count = (patterns: RegExp[]) => patterns.reduce(
      (total, pattern) => total + (pattern.test(normalized) ? 1 : 0),
      0,
    );

    return [
      count([/挽救计划/, /电影/, /CP/i, /脑补/, /镜头/]),
      count([/面包店/, /社区店/, /商场店/, /早餐/, /下午茶/]),
      count([/预算/, /设备/, /现金流/, /人手/, /借款/, /辞职/]),
      count([/马拉松/, /跑步/, /训练/, /配速/, /备赛/]),
      count([/膝盖/, /提速/, /不舒服/, /顶不住/]),
      count([/AI/, /资料/, /真正看/, /电影细节/, /镜头画面/]),
    ];
  }

  async generateRetrievalDrafts(params: {
    messages: ChatMessageInput[];
    recentActivatedImpressions?: Impression[];
  }): Promise<RetrievalDrafts> {
    return this.findBatch(params.messages).node1;
  }

  async generateFinalImpressions(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldImpressions: Impression[];
    candidateImpressions: CandidateImpressionDraft[];
  }): Promise<FinalImpressionDraft[]> {
    const batch = this.findBatch([...params.historyMessages, ...params.newMessages]);
    return batch.node2.impressions.map((item) => ({
      sourceImpressionId: item.sourceScene
        ? (params.oldImpressions.find((impression) => impression.scene === item.sourceScene)?.id || null)
        : null,
      scene: item.scene,
      points: item.points,
      entities: [],
      retrievalText: item.retrievalText,
    }));
  }

  async generateCandidateImpressions(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldImpressions: Impression[];
  }): Promise<CandidateImpressionDraft[]> {
    const batch = this.findBatch([...params.historyMessages, ...params.newMessages]);
    const evidenceMessageIds = batch.newMessageIds.slice(0, 4);

    return batch.node2.impressions.map((item) => ({
      scene: item.scene,
      points: item.points,
      entities: [],
      retrievalText: item.retrievalText,
      evidenceMessageIds,
    }));
  }
}

function loadCase(fileName: string): ReplayCase {
  const filePath = path.join(__dirname, '..', '..', 'testing', 'cases', fileName);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReplayCase;
}

function createService(caseData: ReplayCase, backend: InMemoryQdrantBackend): QdrantService {
  const configService = {
    get(key: string) {
      const values: Record<string, any> = {
        'qdrant.collectionName': 'user_impressions',
        'qdrant.url': 'http://qdrant.test:6333',
        'backend.internalUrl': 'http://backend.test:7001',
        'dashscope.embeddingDim': 6,
      };
      return values[key];
    },
  } as any;

  mockedAxios.get.mockImplementation((url: string) => backend.get(url));
  mockedAxios.put.mockImplementation((url: string, body?: any) => backend.put(url, body));
  mockedAxios.post.mockImplementation((url: string, body?: any) => backend.post(url, body));

  return new QdrantService(configService, new FixtureDashscopeService(caseData) as any);
}

function assertNode1Drafts(batch: CaseBatch): void {
  expect(batch.node1).toHaveProperty('historyRetrievalDraft');
  expect(batch.node1).toHaveProperty('deltaRetrievalDraft');
  expect(batch.node1).toHaveProperty('mergedRetrievalDraft');
  expect(batch.node1.mergedRetrievalDraft).toMatch(/原来|这轮|新增/);

  const banned = ['认知偏差', '确立边界', '达成一致', '调整策略', '完成校准', '行为偏好'];
  for (const value of Object.values(batch.node1)) {
    for (const word of banned) {
      expect(value).not.toContain(word);
    }
  }
}

describe('chat impression replay cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replays movie-plan-boundary with single-scene anti-drift', async () => {
    const caseData = loadCase('movie-plan-boundary.json');
    const backend = new InMemoryQdrantBackend();
    const service = createService(caseData, backend);

    for (const batch of caseData.batches) {
      assertNode1Drafts(batch);

      if (batch.retrievalExpectation) {
        const recalled = await (service as any).recallImpressionsForDrafts(caseData.userId, batch.node1);
        expect(recalled[0]?.scene).toBe(batch.retrievalExpectation.top1Scene);
      }

      await service.processSummaryJob({
        userId: caseData.userId,
        sessionId: caseData.sessionId,
        date: batch.memoryDate,
        batchId: `${caseData.name}-${batch.name}`,
        messages: buildMessages(caseData, batch),
      });
    }

    const stored = backend.listImpressions();
    expect(stored).toHaveLength(1);
    expect(stored[0].scene).toBe(caseData.golden_final.impressions[0].scene);
    expect(stored[0].points).toEqual(caseData.golden_final.impressions[0].points);
    expect(stored[0].retrievalText).toBe(caseData.golden_final.impressions[0].retrievalText);
    expect(backend.links.length).toBeGreaterThan(0);
  });

  it('replays bakery-cross-day-growth with same-day update and cross-day continued', async () => {
    const caseData = loadCase('bakery-cross-day-growth.json');
    const backend = new InMemoryQdrantBackend();
    const service = createService(caseData, backend);

    for (const batch of caseData.batches) {
      assertNode1Drafts(batch);

      if (batch.retrievalExpectation) {
        const recalled = await (service as any).recallImpressionsForDrafts(caseData.userId, batch.node1);
        expect(recalled[0]?.scene).toBe(batch.retrievalExpectation.top1Scene);
      }

      await service.processSummaryJob({
        userId: caseData.userId,
        sessionId: caseData.sessionId,
        date: batch.memoryDate,
        batchId: `${caseData.name}-${batch.name}`,
        messages: buildMessages(caseData, batch),
      });
    }

    const stored = backend.listImpressions();
    expect(stored).toHaveLength(caseData.golden_final.totalImpressions);
    expect(stored[0].scene).toBe(caseData.golden_final.latestScene);
    expect(stored[0].points).toEqual(caseData.golden_final.latestPoints);
    expect(stored[0].originType).toBe(caseData.golden_final.latestOriginType);
    expect(stored[0].sourceImpressionId).toBe(stored[1].id);
    expect(stored[0].rootImpressionId).toBe(stored[1].rootImpressionId || stored[1].id);
    expect(backend.edges).toHaveLength(1);
  });

  it('replays bakery-running-interleaved without cross-scene bleed', async () => {
    const caseData = loadCase('bakery-running-interleaved.json');
    const backend = new InMemoryQdrantBackend();
    const service = createService(caseData, backend);

    for (const batch of caseData.batches) {
      assertNode1Drafts(batch);

      if (batch.retrievalExpectation) {
        const recalled = await (service as any).recallImpressionsForDrafts(caseData.userId, batch.node1);
        expect(recalled[0]?.scene).toBe(batch.retrievalExpectation.top1Scene);
      }

      await service.processSummaryJob({
        userId: caseData.userId,
        sessionId: caseData.sessionId,
        date: batch.memoryDate,
        batchId: `${caseData.name}-${batch.name}`,
        messages: buildMessages(caseData, batch),
      });
    }

    const stored = backend.listImpressions();
    expect(stored).toHaveLength(caseData.golden_final.totalImpressions);
    expect(stored.map((item) => item.scene).sort()).toEqual([...caseData.golden_final.scenes].sort());
    expect(stored.find((item) => item.scene === '聊开面包店计划')?.sourceImpressionId).toBeNull();
    expect(stored.find((item) => item.scene === '聊马拉松训练和膝盖问题')?.sourceImpressionId).toBeNull();
  });
});
