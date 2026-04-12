import axios from 'axios';
import { QdrantService } from './qdrant.service';
import { ChatMessageInput, Node2PointDraft, RetrievalDrafts } from './dashscope.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

interface StoredVectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, any>;
}

interface StoredLine {
  id: string;
  userId: number;
  sessionId: string | null;
  anchorLabel: string;
  impressionLabel: string;
  impressionAbstract: string;
  impressionVersion: number;
  salienceScore: number;
  lastActivatedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredPoint {
  id: string;
  userId: number;
  sessionId: string | null;
  lineId: string;
  op: 'new' | 'supplement' | 'revise' | 'conflict';
  sourcePointId: string | null;
  text: string;
  memoryDate: string;
  salienceScore: number;
  createdAt: string;
  updatedAt: string;
}

class InMemoryBackend {
  collectionExists = false;
  qdrantPoints = new Map<string, StoredVectorPoint>();
  lines = new Map<string, StoredLine>();
  points = new Map<string, StoredPoint>();
  revisionLogs: Array<Record<string, any>> = [];
  pointLinks: Array<Record<string, any>> = [];
  private lineSeq = 1;
  private pointSeq = 1;
  private tick = 1;

  private nextIso(): string {
    const value = new Date(Date.UTC(2026, 3, 11, 12, 0, this.tick)).toISOString();
    this.tick += 1;
    return value;
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

  private matchesFilter(payload: Record<string, any>, filter?: any): boolean {
    const must = filter?.must || [];
    return must.every((condition: any) => payload?.[condition.key] === condition?.match?.value);
  }

  private buildLeafPointsByLineIds(lineIds: string[]): Record<string, StoredPoint[]> {
    const children = new Set(
      Array.from(this.points.values())
        .map((point) => point.sourcePointId)
        .filter((pointId): pointId is string => Boolean(pointId)),
    );

    const grouped: Record<string, StoredPoint[]> = {};
    for (const lineId of lineIds) {
      grouped[lineId] = [];
    }

    for (const point of this.points.values()) {
      if (!lineIds.includes(point.lineId)) {
        continue;
      }
      if (children.has(point.id)) {
        continue;
      }
      grouped[point.lineId].push(point);
    }

    for (const lineId of lineIds) {
      grouped[lineId].sort((left, right) => (
        new Date(right.updatedAt || right.createdAt).getTime()
        - new Date(left.updatedAt || left.createdAt).getTime()
      ));
    }

    return grouped;
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
        this.qdrantPoints.set(String(point.id), {
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
    if (url.includes('/points/search')) {
      const results = Array.from(this.qdrantPoints.values())
        .filter((point) => this.matchesFilter(point.payload, body.filter))
        .map((point) => ({
          id: point.id,
          payload: point.payload,
          score: this.cosineSimilarity(body.vector || [], point.vector || []),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, body.limit || 10);

      return { data: { result: results } };
    }

    if (url.includes('/points/scroll')) {
      const points = Array.from(this.qdrantPoints.values())
        .filter((point) => this.matchesFilter(point.payload, body.filter))
        .sort((left, right) => new Date(
          right.payload.lineLastActivatedAt || right.payload.updatedAt || right.payload.createdAt,
        ).getTime() - new Date(
          left.payload.lineLastActivatedAt || left.payload.updatedAt || left.payload.createdAt,
        ).getTime())
        .slice(0, body.limit || 20)
        .map((point) => ({
          id: point.id,
          payload: body.with_payload === false ? undefined : point.payload,
        }));

      return { data: { result: { points } } };
    }

    if (/\/collections\/[^/]+\/points$/.test(url) && Array.isArray(body.ids)) {
      return {
        data: {
          result: {
            points: body.ids
              .map((id: string) => this.qdrantPoints.get(String(id)))
              .filter((point): point is StoredVectorPoint => Boolean(point))
              .map((point) => ({
                id: point.id,
                payload: point.payload,
              })),
          },
        },
      };
    }

    if (url.includes('/points/payload')) {
      for (const pointId of body.points || []) {
        const point = this.qdrantPoints.get(String(pointId));
        if (point) {
          point.payload = {
            ...point.payload,
            ...(body.payload || {}),
          };
        }
      }
      return { data: { result: true } };
    }

    if (url.includes('/points/delete')) {
      for (const pointId of body.points || []) {
        this.qdrantPoints.delete(String(pointId));
      }
      return { data: { result: true } };
    }

    if (url.includes('/api/internal/memory/lines/recent')) {
      const lines = Array.from(this.lines.values())
        .filter((line) => line.userId === body.userId)
        .sort((left, right) => (
          new Date(right.lastActivatedAt).getTime() - new Date(left.lastActivatedAt).getTime()
        ))
        .slice(0, body.limit || 10);
      return { data: lines };
    }

    if (url.includes('/api/internal/memory/lines/keyword-search')) {
      const query = String(body.query || '');
      const lines = Array.from(this.lines.values())
        .filter((line) => line.userId === body.userId)
        .filter((line) => (
          `${line.anchorLabel} ${line.impressionLabel} ${line.impressionAbstract}`.includes(query.slice(0, 4))
          || `${line.anchorLabel} ${line.impressionLabel} ${line.impressionAbstract}`.includes(query)
        ))
        .slice(0, body.limit || 10);
      return { data: lines };
    }

    if (url.includes('/api/internal/memory/lines/by-ids')) {
      const lines = (body.lineIds || [])
        .map((id: string) => this.lines.get(String(id)))
        .filter((line: StoredLine | undefined): line is StoredLine => Boolean(line));
      return { data: lines };
    }

    if (url.includes('/api/internal/memory/lines/leaf-points')) {
      return { data: this.buildLeafPointsByLineIds(body.lineIds || []) };
    }

    if (url.endsWith('/api/internal/memory/lines')) {
      const now = this.nextIso();
      const line: StoredLine = {
        id: `line-${this.lineSeq++}`,
        userId: body.userId,
        sessionId: body.sessionId ?? null,
        anchorLabel: body.anchorLabel,
        impressionLabel: body.impressionLabel || body.anchorLabel,
        impressionAbstract: body.impressionAbstract || '',
        impressionVersion: 1,
        salienceScore: body.salienceScore || 1,
        lastActivatedAt: body.lastActivatedAt || now,
        createdAt: now,
        updatedAt: now,
      };
      this.lines.set(line.id, line);
      return { data: line };
    }

    if (url.endsWith('/api/internal/memory/points')) {
      const now = this.nextIso();
      const point: StoredPoint = {
        id: `point-${this.pointSeq++}`,
        userId: body.userId,
        sessionId: body.sessionId ?? null,
        lineId: body.lineId,
        op: body.op,
        sourcePointId: body.sourcePointId ?? null,
        text: body.text,
        memoryDate: body.memoryDate,
        salienceScore: body.salienceScore || 1,
        createdAt: now,
        updatedAt: now,
      };
      this.points.set(point.id, point);
      return { data: point };
    }

    if (url.includes('/api/internal/memory/point-message-links')) {
      for (const messageId of body.messageIds || []) {
        this.pointLinks.push({
          pointId: body.pointId,
          messageId,
          batchId: body.batchId,
        });
      }
      return { data: { created: (body.messageIds || []).length } };
    }

    throw new Error(`Unsupported POST ${url}`);
  }

  async patch(url: string, body: any) {
    if (url.includes('/api/internal/memory/lines/') && url.endsWith('/impression')) {
      const lineId = url.split('/').slice(-2, -1)[0];
      const line = this.lines.get(lineId);
      if (!line) {
        return { data: null };
      }

      const now = this.nextIso();
      line.impressionLabel = body.impressionLabel;
      line.impressionAbstract = body.impressionAbstract;
      line.impressionVersion += 1;
      line.salienceScore = body.salienceScore ?? line.salienceScore;
      line.lastActivatedAt = body.lastActivatedAt || now;
      line.updatedAt = now;
      return { data: line };
    }

    if (url.includes('/api/internal/memory/points/')) {
      const pointId = url.split('/').slice(-1)[0];
      const point = this.points.get(pointId);
      if (!point) {
        return { data: null };
      }

      if (point.text !== body.text) {
        this.revisionLogs.push({
          pointId,
          beforeText: point.text,
          afterText: body.text,
          batchId: body.batchId,
        });
        point.text = body.text;
      }
      point.salienceScore = body.salienceScore ?? point.salienceScore;
      point.updatedAt = this.nextIso();
      return { data: point };
    }

    throw new Error(`Unsupported PATCH ${url}`);
  }
}

function createMessages(pairs: Array<{ id: number; role: 'user' | 'assistant'; content: string; isNew?: boolean }>): ChatMessageInput[] {
  return pairs.map((item, index) => ({
    messageId: item.id,
    role: item.role,
    content: item.content,
    timestamp: new Date(Date.UTC(2026, 3, 11, 10, 0, index)).toISOString(),
    isNew: item.isNew,
  }));
}

function buildDrafts(messages: ChatMessageInput[]): RetrievalDrafts {
  const text = messages.map((message) => message.content).join('；');
  return {
    historyRetrievalDraft: text,
    deltaRetrievalDraft: text,
    mergedRetrievalDraft: text,
  };
}

function createEmbedding(text: string): number[] {
  const normalized = String(text || '');
  const count = (patterns: RegExp[]) => patterns.reduce(
    (total, pattern) => total + (pattern.test(normalized) ? 1 : 0),
    0,
  );

  return [
    count([/电影/, /挽救计划/, /资料/, /看过/]),
    count([/面包店/, /预算/, /设备/, /现金流/]),
    count([/跑步/, /配速/, /马拉松/]),
    count([/咖啡/, /豆子/, /拿铁/]),
  ];
}

function createService(backend: InMemoryBackend, dashscopeService: any): QdrantService {
  const configService = {
    get(key: string) {
      const values: Record<string, any> = {
        'qdrant.collectionName': 'user_impressions',
        'qdrant.url': 'http://qdrant.test:6333',
        'backend.internalUrl': 'http://backend.test:7001',
        'dashscope.embeddingDim': 4,
      };
      return values[key];
    },
  } as any;

  mockedAxios.get.mockImplementation((url: string) => backend.get(url));
  mockedAxios.put.mockImplementation((url: string, body?: any) => backend.put(url, body));
  mockedAxios.post.mockImplementation((url: string, body?: any) => backend.post(url, body));
  mockedAxios.patch.mockImplementation((url: string, body?: any) => backend.patch(url, body));

  return new QdrantService(configService, dashscopeService);
}

describe('memory architecture replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates same-day source points in place and writes revision logs', async () => {
    const backend = new InMemoryBackend();
    const dashscopeService = {
      getEmbedding: jest.fn(async (text: string) => createEmbedding(text)),
      generateRetrievalDrafts: jest.fn(async ({ messages }: { messages: ChatMessageInput[] }) => buildDrafts(messages)),
      generateNode2Points: jest
        .fn()
        .mockResolvedValueOnce([
          {
            op: 'new',
            sourcePointId: null,
            text: '我先装得像知道《挽救计划》细节，用户纠正我只能基于资料理解，不能假装看过。',
          } satisfies Node2PointDraft,
        ])
        .mockImplementationOnce(async ({ oldPoints }: { oldPoints: Array<{ id: string }> }) => ([
          {
            op: 'revise',
            sourcePointId: oldPoints[0]?.id || null,
            text: '我先装得像知道《挽救计划》细节，用户继续强调我只能基于资料理解，不能假装看过。',
          } satisfies Node2PointDraft,
        ])),
      attachPointToExistingLine: jest.fn(async () => ({ targetLineId: null })),
      planNewLines: jest.fn(async () => ({
        newLines: [{ anchorLabel: '聊电影《挽救计划》', pointIndexes: [0] }],
      })),
      rebuildLineImpression: jest.fn(async ({ anchorLabel, leafPoints }: { anchorLabel: string; leafPoints: string[] }) => ({
        impressionLabel: anchorLabel,
        impressionAbstract: leafPoints.join('；'),
      })),
    } as any;
    const service = createService(backend, dashscopeService);

    await service.processSummaryJob({
      userId: 1,
      sessionId: 'session-1',
      date: '2026-04-11',
      batchId: 'same-day-1',
      messages: createMessages([
        { id: 1, role: 'user', content: '你别装得像真的看过《挽救计划》', isNew: true },
        { id: 2, role: 'assistant', content: '我主要是基于资料在说', isNew: true },
      ]),
    });

    await service.processSummaryJob({
      userId: 1,
      sessionId: 'session-1',
      date: '2026-04-11',
      batchId: 'same-day-2',
      messages: createMessages([
        { id: 3, role: 'user', content: '对，你不能假装看过，只能基于资料', isNew: true },
        { id: 4, role: 'assistant', content: '明白，我会按这个边界来讲', isNew: true },
      ]),
    });

    expect(backend.lines.size).toBe(1);
    expect(backend.points.size).toBe(1);
    expect(backend.revisionLogs).toHaveLength(1);
    expect(Array.from(backend.qdrantPoints.values())).toHaveLength(1);
    expect(Array.from(backend.points.values())[0].text).toContain('继续强调');
  });

  it('creates cross-day child points while keeping only the latest leaf in qdrant', async () => {
    const backend = new InMemoryBackend();
    const dashscopeService = {
      getEmbedding: jest.fn(async (text: string) => createEmbedding(text)),
      generateRetrievalDrafts: jest.fn(async ({ messages }: { messages: ChatMessageInput[] }) => buildDrafts(messages)),
      generateNode2Points: jest
        .fn()
        .mockResolvedValueOnce([
          {
            op: 'new',
            sourcePointId: null,
            text: '用户在筹备开面包店，我先帮他把预算、设备和现金流主线搭起来。',
          } satisfies Node2PointDraft,
        ])
        .mockImplementationOnce(async ({ oldPoints }: { oldPoints: Array<{ id: string }> }) => ([
          {
            op: 'supplement',
            sourcePointId: oldPoints[0]?.id || null,
            text: '用户继续筹备开面包店，我帮他把预算、设备和现金流细化得更具体。',
          } satisfies Node2PointDraft,
        ])),
      attachPointToExistingLine: jest.fn(async () => ({ targetLineId: null })),
      planNewLines: jest.fn(async () => ({
        newLines: [{ anchorLabel: '聊开面包店计划', pointIndexes: [0] }],
      })),
      rebuildLineImpression: jest.fn(async ({ anchorLabel, leafPoints }: { anchorLabel: string; leafPoints: string[] }) => ({
        impressionLabel: anchorLabel,
        impressionAbstract: leafPoints.join('；'),
      })),
    } as any;
    const service = createService(backend, dashscopeService);

    await service.processSummaryJob({
      userId: 2,
      sessionId: 'session-2',
      date: '2026-04-10',
      batchId: 'cross-day-1',
      messages: createMessages([
        { id: 10, role: 'user', content: '我最近在筹备开面包店', isNew: true },
        { id: 11, role: 'assistant', content: '可以先把预算和设备列清楚', isNew: true },
      ]),
    });

    await service.processSummaryJob({
      userId: 2,
      sessionId: 'session-2',
      date: '2026-04-11',
      batchId: 'cross-day-2',
      messages: createMessages([
        { id: 12, role: 'user', content: '今天继续聊面包店的预算和现金流', isNew: true },
        { id: 13, role: 'assistant', content: '我再帮你细化一次', isNew: true },
      ]),
    });

    const points = Array.from(backend.points.values());
    expect(backend.lines.size).toBe(1);
    expect(points).toHaveLength(2);
    expect(points[1].sourcePointId).toBe(points[0].id);
    expect(Array.from(backend.qdrantPoints.values())).toHaveLength(1);
    expect(Array.from(backend.qdrantPoints.values())[0].id).toBe(points[1].id);
  });

  it('attaches independent new points to an existing line when the attach node matches', async () => {
    const backend = new InMemoryBackend();
    const dashscopeService = {
      getEmbedding: jest.fn(async (text: string) => createEmbedding(text)),
      generateRetrievalDrafts: jest.fn(async ({ messages }: { messages: ChatMessageInput[] }) => buildDrafts(messages)),
      generateNode2Points: jest
        .fn()
        .mockResolvedValueOnce([
          {
            op: 'new',
            sourcePointId: null,
            text: '用户在准备马拉松训练，我先陪他聊配速和训练安排。',
          } satisfies Node2PointDraft,
        ])
        .mockResolvedValueOnce([
          {
            op: 'new',
            sourcePointId: null,
            text: '用户继续聊马拉松训练，这次重点放在配速调整。',
          } satisfies Node2PointDraft,
        ]),
      attachPointToExistingLine: jest
        .fn()
        .mockResolvedValueOnce({ targetLineId: null })
        .mockImplementationOnce(async ({ candidateLines }: { candidateLines: Array<{ id: string }> }) => ({
          targetLineId: candidateLines[0]?.id || null,
        })),
      planNewLines: jest.fn(async ({ pointTexts }: { pointTexts: string[] }) => ({
        newLines: pointTexts.map((text, index) => ({
          anchorLabel: index === 0 ? '聊马拉松训练' : text.slice(0, 10),
          pointIndexes: [index],
        })),
      })),
      rebuildLineImpression: jest.fn(async ({ anchorLabel, leafPoints }: { anchorLabel: string; leafPoints: string[] }) => ({
        impressionLabel: anchorLabel,
        impressionAbstract: leafPoints.join('；'),
      })),
    } as any;
    const service = createService(backend, dashscopeService);

    await service.processSummaryJob({
      userId: 3,
      sessionId: 'session-3',
      date: '2026-04-11',
      batchId: 'attach-1',
      messages: createMessages([
        { id: 20, role: 'user', content: '我最近在准备马拉松', isNew: true },
        { id: 21, role: 'assistant', content: '可以先从配速和训练安排聊起', isNew: true },
      ]),
    });

    await service.processSummaryJob({
      userId: 3,
      sessionId: 'session-3',
      date: '2026-04-11',
      batchId: 'attach-2',
      messages: createMessages([
        { id: 22, role: 'user', content: '今天继续聊马拉松配速', isNew: true },
        { id: 23, role: 'assistant', content: '那我们把配速调整细一点', isNew: true },
      ]),
    });

    const lines = Array.from(backend.lines.values());
    const points = Array.from(backend.points.values());
    expect(lines).toHaveLength(1);
    expect(points).toHaveLength(2);
    expect(points[0].lineId).toBe(points[1].lineId);
  });

  it('creates multiple new lines for unrelated new points in the same batch', async () => {
    const backend = new InMemoryBackend();
    const dashscopeService = {
      getEmbedding: jest.fn(async (text: string) => createEmbedding(text)),
      generateRetrievalDrafts: jest.fn(async ({ messages }: { messages: ChatMessageInput[] }) => buildDrafts(messages)),
      generateNode2Points: jest.fn(async () => ([
        {
          op: 'new',
          sourcePointId: null,
          text: '用户在聊跑步训练和配速安排，我跟着补充训练节奏。',
        },
        {
          op: 'new',
          sourcePointId: null,
          text: '用户也在聊咖啡豆和手冲风味，我跟着补充豆子选择。',
        },
      ] satisfies Node2PointDraft[])),
      attachPointToExistingLine: jest.fn(async () => ({ targetLineId: null })),
      planNewLines: jest.fn(async () => ({
        newLines: [
          { anchorLabel: '聊跑步训练', pointIndexes: [0] },
          { anchorLabel: '聊咖啡豆选择', pointIndexes: [1] },
        ],
      })),
      rebuildLineImpression: jest.fn(async ({ anchorLabel, leafPoints }: { anchorLabel: string; leafPoints: string[] }) => ({
        impressionLabel: anchorLabel,
        impressionAbstract: leafPoints.join('；'),
      })),
    } as any;
    const service = createService(backend, dashscopeService);

    await service.processSummaryJob({
      userId: 4,
      sessionId: 'session-4',
      date: '2026-04-11',
      batchId: 'multi-line-1',
      messages: createMessages([
        { id: 30, role: 'user', content: '我最近在跑步训练', isNew: true },
        { id: 31, role: 'assistant', content: '可以先看配速和训练安排', isNew: true },
        { id: 32, role: 'user', content: '我也在看咖啡豆和手冲风味', isNew: true },
        { id: 33, role: 'assistant', content: '那再聊聊豆子选择', isNew: true },
      ]),
    });

    expect(Array.from(backend.lines.values()).map((line) => line.anchorLabel).sort()).toEqual([
      '聊咖啡豆选择',
      '聊跑步训练',
    ]);
    expect(Array.from(backend.qdrantPoints.values())).toHaveLength(2);
  });
});
