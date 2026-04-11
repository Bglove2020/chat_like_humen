# AI 聊天会话摘要自动生成设计文档

**日期:** 2026-04-02
**状态:** 设计完成

---

## 1. 背景与目标

当前项目前后端可以正常进行 AI 聊天，但无法自动生成 AI 聊天的会话摘要。本设计实现：

- 每当用户发送消息或接收到 Dify 返回的消息时，凑够15条消息（包含 AI 和用户消息）作为任务进入消息队列
- Worker 从队列取出任务后，调用 LLM 判断当前消息与当天已有摘要的相关性
- 相关则增量生成新摘要并覆盖原有摘要，存入 Qdrant 向量数据库

---

## 2. 技术栈

| 模块 | 技术 |
|------|------|
| 前端 | Vite + React |
| 后端 | MidwayJS |
| 数据库 | MySQL |
| 向量库 | Qdrant |
| 消息队列 | Redis + BullMQ |
| AI 对话 | Dify Workflow API |
| 摘要生成 | Qwen via DashScope API |

---

## 3. 系统架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Frontend  │────▶│  MidwayJS    │────▶│    Dify     │
│  (React)    │◀────│  (API)       │◀────│  (Workflow) │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                           │ 消息入库
                           ▼
                    ┌─────────────┐
                    │   MySQL     │
                    │ (chat_messages)│
                    └──────┬──────┘
                           │ 查询最近15条
                           ▼
                    ┌─────────────┐
                    │  BullMQ     │
                    │  (Redis)    │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐     ┌─────────────┐
                    │  Worker      │────▶│   Qdrant    │
                    │ (并发LLM调用)│     │  (摘要存储) │
                    └──────┬──────┘     └─────────────┘
                           │ Upsert
                           ▼
                    ┌─────────────┐
                    │  DashScope  │
                    │ (Qwen/Embedding)│
                    └─────────────┘
```

---

## 4. 数据模型

### 4.1 MySQL - chat_messages 表

```sql
CREATE TABLE chat_messages (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  role ENUM('user', 'assistant') NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_created (user_id, created_at)
);
```

- `user_id`: 用户 ID
- `session_id`: 会话 ID（用于标识一次独立对话）
- `role`: 角色（user/assistant）
- `content`: 消息内容
- `created_at`: 创建时间（北京时间）

### 4.2 Qdrant - 摘要存储

**集合名称:** `user_impressions`（沿用现有）

**向量结构:**
- id: UUID（格式: `{userId}_{date}_{uuid}`）
- vector: float[1536]（Qwen embedding 向量）
- payload: `{userId, date, summaryText, createdAt}`

---

## 5. 消息队列设计

### 5.1 队列名称

`chat-summary-queue`

### 5.2 入队时机

**触发条件（无防抖）：**
- 用户发送消息（前端发请求到后端）
- Dify 返回完整消息（流式结束后）

满足条件后立即：
1. 消息入库（MySQL）
2. 查询该用户最近15条消息（按 `created_at` 倒序取前15条，不区分 session）
3. 入队列

### 5.3 批次消息结构

```json
{
  "userId": 123,
  "date": "2026-04-02",
  "batchId": "uuid-xxx",
  "messages": [
    {"role": "user", "content": "我想开始健身", "timestamp": "2026-04-02T09:30:15"},
    {"role": "assistant", "content": "好的，想减脂还是增肌？", "timestamp": "2026-04-02T09:30:16"},
    {"role": "user", "content": "减脂", "timestamp": "2026-04-02T09:30:20"}
    // 按时间顺序，最多15条
  ]
}
```

---

## 6. Worker 处理流程

### 6.1 整体流程

```
1. 从 BullMQ 取出 batch（15条消息）
2. 查询 Qdrant：该用户当天已有摘要列表
3. 对每个已有摘要并发调用 LLM：
   a. 组装提示词（15条消息 + 该摘要 + 固定指令）
   b. LLM 判断是否相关，输出决策 + 新摘要
4. 汇总所有 LLM 决策结果
5. 根据决策执行 upsert：
   - update → 重新 embedding → upsert 覆盖（相同 ID）
   - create → embedding → 新增
   - skip → 不动
6. ack 队列消息
```

### 6.2 LLM 调用提示词模板

```
你是会话摘要生成助手。

## 已有摘要
"{existing_summary}"
（此摘要创建于: {created_at}）

## 最近15条消息
{messages}
格式：
  [{role}] {timestamp}: {content}

## 判断标准
1. 如果新消息与已有摘要讨论的是**同一主题或相关话题**，标记为"相关"
2. 如果新消息是**全新话题**，标记为"不相关"
3. "好的/对/嗯"等短回复需结合上下文判断

## 输出格式（JSON）
{
  "action": "update" | "skip",
  "reason": "判断理由（20字内）",
  "new_summary": "更新后的摘要内容（50-100字），仅 action 为 update 时填写"
}
```

### 6.3 并发控制

- 使用 Promise.all 并发处理所有已有摘要的 LLM 调用
- 最大并发数限制：避免 Qwen API 限流，建议设置为 5
- 如果当天没有已有摘要，直接生成一个新摘要（action: "create"）

### 6.4 新建摘要提示词（无已有摘要时）

```
你是会话摘要生成助手。

## 最近15条消息
{messages}
格式：
  [{role}] {timestamp}: {content}

## 任务
根据以上对话，生成1-3个核心摘要，涵盖对话的主要话题。

## 输出格式（JSON）
{
  "summaries": [
    {
      "content": "摘要内容（50-100字）"
    }
  ]
}
```

---

## 7. 核心逻辑伪代码

```typescript
async processSummaryJob(data: SummaryJobData) {
  const { userId, date, batchId, messages } = data;

  // 1. 查询当天已有摘要
  const existingImpressions = await qdrantService.getTodayImpressions(userId, date);

  // 2. 并发调用 LLM
  let decisions: ImpressionDecision[];

  if (existingImpressions.length === 0) {
    // 无已有摘要，直接生成新摘要
    decisions = await dashscopeService.generateNewSummaries(messages);
  } else {
    // 并发判断每个已有摘要
    const llmResults = await Promise.all(
      existingImpressions.map(impression =>
        dashscopeService.judgeRelevanceAndGenerate(impression, messages)
      )
    );

    // 3. 汇总结果
    decisions = llmResults
      .filter(r => r.action === 'update')
      .map(r => ({ id: r.id, content: r.new_summary, action: 'update' as const }));

    // 检查是否有需要新建摘要（15条消息中有新话题）
    const hasNewTopic = llmResults.some(r => r.action === 'skip' && r.hasNewTopic);
    if (hasNewTopic) {
      const newSummaries = await dashscopeService.generateNewSummaries(messages);
      decisions.push(...newSummaries.map(s => ({ ...s, action: 'create' as const })));
    }
  }

  // 4. Upsert 到 Qdrant
  for (const decision of decisions) {
    const embedding = await dashscopeService.getEmbedding(decision.content);
    await qdrantService.upsertImpression(decision.id, userId, date, decision.content, embedding);
  }
}
```

---

## 8. 错误处理

| 场景 | 处理方式 |
|------|----------|
| LLM 调用超时 | 重试3次，间隔2s |
| Embedding 调用失败 | 重试3次，间隔1s |
| Qdrant upsert 失败 | 重试3次，间隔1s |
| 消息队列消费失败 | BullMQ 自动重试（最多3次） |
| 部分 LLM 调用失败 | 成功的继续处理，失败的标记跳过 |

---

## 9. 变更清单

### Backend（MidwayJS）

1. **新增 `chat_messages` 表**（用户消息持久化）
2. **修改 `ChatService.sendMessage`**：
   - 消息入库（MySQL）
   - 去掉5秒防抖
   - 直接查询15条消息入队列
3. **新增 `ChatMessage` Entity**
4. **修改 `QueueService.enqueueSummaryBatch`**：直接接收消息列表（已从库查好）

### Worker

1. **修改 `QdrantService`**：
   - 保持 `getTodayImpressions` 方法不变
   - 修改 `processSummaryJob` 逻辑：并发调用 + 决策处理
2. **修改 `DashscopeService`**：
   - 新增 `judgeRelevanceAndGenerate` 方法（判断单个摘要相关性）
   - 新增 `generateNewSummaries` 方法（无已有摘要时生成）
   - 调整 `getEmbedding` 错误处理

---

## 10. 项目结构

```
/root/chat_like_human/
├── backend/src/
│   ├── chat/
│   │   ├── chat.service.ts       # 修改：去掉防抖，加消息入库
│   │   ├── chat.module.ts
│   │   └── chat.controller.ts
│   ├── queue/
│   │   └── queue.service.ts     # 调整入队逻辑
│   ├── entity/
│   │   └── chat_message.entity.ts # 新增
│   └── ...
├── worker/src/
│   ├── processor/
│   │   └── summary.processor.ts # 保持不变
│   ├── services/
│   │   ├── dashscope.service.ts  # 修改：并发调用 + 新提示词
│   │   └── qdrant.service.ts     # 修改：决策落地逻辑
│   └── ...
└── docs/superpowers/specs/
    └── 2026-04-02-chat-summary-design.md
```

---

## 11. 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 入队时机 | 无防抖，立即触发 | 避免长对话时被截断 |
| 消息来源 | 从 MySQL 查最近15条 | 持久化存储，重启不丢失 |
| 相关性判断 | LLM 逐个调用（并发） | 决策更精准，避免单次 prompt 过长 |
| 向量更新 | 覆盖更新（相同 ID upsert） | 保持向量与摘要内容一致 |
| 时区 | 北京时间（UTC+8） | 业务统一使用北京时间 |
