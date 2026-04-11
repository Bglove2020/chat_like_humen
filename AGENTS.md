# AGENTS

## 项目

Chat Like Human 是一个带记忆系统的聊天应用。

## 结构

- `frontend`: React 前端
- `backend`: NestJS 后端
- `worker`: 摘要 Worker
- `tests`: E2E 测试

## 主链路

1. 用户消息发送到后端
2. 后端调用 Dify 获取回复
   - Dify 内部负责在生成回复前调用 `POST /api/chat-context` 获取记忆上下文
   - 后端 `/api/chat` 当前不直接拼接记忆上下文给 Dify
3. 用户消息和 AI 回复写入 MySQL
4. 后端按批次把消息送入 BullMQ
5. Worker 调用 Qwen 生成印象摘要
6. 摘要写入 Qdrant

## 不可改约束

- 保留聊天系统
- 保留记忆系统
- flush 条件固定为 `10 条消息` 或 `2 分钟`
- flush 最多携带最近 `15` 条消息
- 必须异步生成摘要
- 必须写入 Qdrant

## 生产环境

- 入口：Nginx
- 前端：Nginx 提供静态文件
- API：Nginx 反代到 `127.0.0.1:7001`
- PM2 进程：
  - `chat-backend`
  - `chat-worker`
- 基础设施：`docker-compose.yml`
  - MySQL `3306`
  - Redis `6379`
  - Qdrant `6333/6334`
- PM2 配置：`ecosystem.config.cjs`
- 标准 Nginx 配置：`deploy/nginx/chat-like-human.conf`

## 开发环境

- 前端：`3000`
- 后端：`7101`
- Worker：无 HTTP 端口
- 基础设施：`docker-compose.dev.yml`
  - MySQL `3307`
  - Redis `6380`
  - Qdrant `6335/6336`
- 前端开发代理指向 `http://localhost:7101`

## 环境边界

- 生产只用 Nginx + PM2
- 开发默认不用 PM2，不走 Nginx
- 不混用生产和开发的 MySQL、Redis、Qdrant

## 数据隔离

- 生产和开发使用两套独立容器
- 生产和开发使用不同端口
- 生产和开发使用不同数据目录
- 不是在同一套 MySQL / Redis / Qdrant 内做逻辑复用
- 生产数据目录：
  - `mysql_data`
  - `redis_data`
  - `qdrant_storage`
- 开发数据目录：
  - `mysql_data_dev`
  - `redis_data_dev`
  - `qdrant_storage_dev`

## 环境文件

- 生产：
  - `backend/.env.production`
  - `worker/.env.production`
  - `frontend/.env.production`
- 开发：
  - `backend/.env.development`
  - `worker/.env.development`
  - `frontend/.env.development`
- 示例文件：
  - `*.example`

## 关键文件

- `backend/src/chat/chat.service.ts`
- `backend/src/chat/chat-context.service.ts`
- `backend/src/queue/queue.service.ts`
- `worker/src/processor/summary.processor.ts`
- `worker/src/processor/fact.processor.ts`
- `worker/src/services/dashscope.service.ts`
- `worker/src/services/qdrant.service.ts`
- `worker/src/services/fact-extraction.service.ts`
- `ecosystem.config.cjs`
- `docker-compose.yml`
- `docker-compose.dev.yml`

## 同步会话上下文接口

### 目标

- 在用户发来新消息后、生成 AI 回复前，同步召回本次回复所需的历史上下文
- 当前由 Dify 工作流/工具调用该接口获取上下文；Chat Like Human 后端只提供接口能力
- 这个接口不走 LLM，不生成 Node1 草稿，不做关键词提取
- 当前方案固定为规则拼接消息 + 向量检索 + 近期 impression 补充

### 接口

- `POST /api/chat-context`
- 不要求鉴权
- 调用方必须显式传 `userId`
- 调用方需要传入当前用户最新消息作为 `message`
- 只按当前用户维度取消息和 impression，不依赖 session 过滤
- 返回体默认只保留 `scene + points + time`
- `time` 为北京时间字符串，格式固定为 `YYYY-MM-DD HH:mm:ss`

### 召回路线

- `近期 impression`
  - 最近 `7` 天内
  - 最多 `5` 条
  - 按 `lastActivatedAt` 倒序；为空则回退 `updatedAt` / `createdAt`
  - 只补近期主线，不主导最终排序
- `历史窗口召回`
  - 取当前用户最近 `20` 条历史消息
  - 每条消息保留原文；如果单条消息超过 `100` 字，直接截断到 `100` 字
  - 按时间顺序拼成一条 `windowQuery`
  - 对这条 query 做 `1` 次 embedding + `1` 次 impression 向量检索
- `最新输入召回`
  - 取最近 `4` 轮历史对话作为补充信息
  - 再追加当前用户这条新消息，拼成一条 `latestQuery`
  - 每条消息保留原文；如果单条消息超过 `100` 字，直接截断到 `100` 字
  - 对这条 query 做 `1` 次 embedding + `1` 次 impression 向量检索

### 状态规则

- 同步上下文接口**不更新** `lastActivatedAt`
- `lastActivatedAt` 只在 impression 创建或更新时写入
- 因此这一路更接近“近期 impression”，不是“本次被检索过的 impression”

### 排序规则

- 三路结果统一融合、去重、排序
- 必须先按 `id` 去重，再按 ancestor chain 去重
- 当前默认权重：

```text
finalScore =
  latestScore * 0.50 +
  windowScore * 0.30 +
  recentBoost * 0.15 +
  salienceScore * 0.05
```

- 默认返回 `top 6`

### 当前会话约束

- 当前产品方向不再强调多 session 切分
- `session` 仍然作为聊天消息、Dify conversation、排查链路的记录字段保留
- 一个用户固定复用一个默认 session id
- 初次创建会话后，后续默认复用同一个 session id
- 前端不再提供主动新建会话、切换会话、删除会话的产品入口
- 后端仍需能在用户没有 session 时自动创建默认 session
- 同步上下文接口本身不依赖 session 过滤

## Node1 检索草稿

### 定位

- `Node1` 是旧印象召回前的多视角检索草稿生成器。
- `Node1` 不直接生成最终 impression，也不直接落库。
- `Node1` 的职责是从不同方面表达当前聊天，生成更适合召回旧 impression 的检索草稿。

### 输入

- `历史消息`
  - 本次 flush 中 `isNew === false` 的消息
  - 用于表达这轮之前仍在可见窗口中的旧上下文
- `最近激活的 impressions（仅作补充）`
  - 先取最近激活的 `10` 条 impression 作为候选
  - 再通过 hybrid rerank 选出 `6` 条传给 `Node1`
  - 这些内容不是当前聊天原文，只能作为补充线索
  - 如果和当前聊天原文冲突，以当前聊天原文为准
  - 如果和当前聊天无明显关系，应忽略，不要强行带入
  - 它们只参与 `Node1` 草稿生成，不直接作为 `Node2` 的候选旧 impression 输入
- `当前 batch 新消息`
  - 本次 flush 中 `isNew !== false` 的消息
  - 用于表达这轮新增的事实、纠正、变化和推进

### 输出

- `Node1` 当前固定只输出一组 JSON，不输出多组 topic drafts
- 输出结构：

```json
{
  "historyRetrievalDraft": "...",
  "deltaRetrievalDraft": "...",
  "mergedRetrievalDraft": "..."
}
```

- 三条草稿的含义：
  - `historyRetrievalDraft`
    - 从历史延续视角表达旧上下文原来在聊什么
    - 不混入这轮新增内容
  - `deltaRetrievalDraft`
    - 从本轮新增视角表达这轮新增了什么
    - 不复述旧上下文
  - `mergedRetrievalDraft`
    - 从整体主题视角表达此刻整体到底在聊什么、核心张力是什么
    - 不再显式区分历史和新增

### Hybrid Rerank

- `Node1` 的最近激活 impression 补充采用：
  - `Recent-10 candidate retrieval + hybrid rerank Top-6`
- 当前 rerank 使用 3 个信号：
  - `semanticScore`
    - 当前消息 query 与 impression 的语义相关性
  - `anchorCoverage`
    - 当前消息中的锚点与 impression 的 `entities` 或 `scene + points` 提取锚点之间的覆盖情况
    - 锚点优先关注人物、关系、对象、地点、时间等客观信息
  - `salienceScore`
    - impression 的记忆强度
- 当前权重：

```text
finalScore =
  semanticScore * 0.55 +
  anchorCoverage * 0.25 +
  salienceScore * 0.20
```

- 设计原则：
  - `最近激活` 负责时效性
  - `相关性` 负责当前适配性
  - `印象强度` 只做辅助，不应压过当前相关性

### 当前边界

- `Node1` 当前只输出一组草稿，不做多组并行召回
- 如果一个 batch 中存在多个话题，默认优先抓主话题
- 次话题最多轻量带一下，不平均展开
- 是否最终拆成多条 impression 主要由后续节点决定

### 后续可优化方向

- 支持 `Node1` 输出 `1-2` 组 topic drafts，用于明显多话题 batch 的并行召回
- 继续增强 hybrid rerank，对不同类型锚点使用不同权重
- 增加三条 draft 的相似度校验，避免三个视角塌成一个视角
- 增加 batch 内话题转折检测，决定是否需要多组检索草稿
- 保留当前默认非 agent 模式，在必要时增加条件触发的 agentic 扩检 fallback

## Node2 候选印象重建与对账更新

### 定位

- 旧 `Node2` 已拆成两个顺序节点：
  - `候选印象重建器`
  - `印象对账与更新器`
- 两个节点都必须显式区分：
  - `history_messages`
  - `new_messages`
  - `old_impressions`
- 原始聊天消息始终是最终证据源，`old_impressions` 只用于辅助理解和对账。

### 输入

- `history_messages`
  - 当前 flush 中 `isNew === false` 的消息
  - 只用于补足上下文、承接关系、代词、省略和主线延续
- `new_messages`
  - 当前 flush 中 `isNew !== false` 的消息
  - 这是本轮记忆变化判断的核心输入
- `old_impressions`
  - 只来自 `Node1` 检索草稿召回出的旧 impression 结果
  - 可以对这些召回结果做融合、去重、排序、筛选
  - 不额外混入未经过 `Node1` 检索草稿命中的独立候选源
  - 这些内容只作为辅助理解和对账参考，不高于原始聊天消息

### 阶段 1：候选印象重建器

#### 定位

- 基于 `history_messages + new_messages` 重建“此刻成立的候选聊天印象”
- 输出的是 `candidate_impressions`，不是最终落库结果
- 不负责判断 `sourceImpressionId`
- `old_impressions` 只能帮助稳定 scene 命名和避免机械重复，不能直接提供新事实

#### 输出

```json
{
  "candidate_impressions": [
    {
      "scene": "...",
      "points": ["..."],
      "entities": ["..."],
      "retrievalText": "...",
      "evidenceMessageIds": ["msg_id_1", "msg_id_2"]
    }
  ]
}
```

#### 规则

- 必须显式区分 `history_messages` 和 `new_messages`
- candidate impression 只能由原始聊天消息直接支持，不能仅由 `old_impressions` 推出
- 默认 impression 数量尽量少，默认优先合并，不做细碎拆分
- `scene`
  - 只写“我和用户在聊什么”
  - 如果主题不明确、内容较散，用“时间段 + 闲聊”命名
- `points`
  - 优先 1～2 条
  - 每个 point 尽量同时体现双方内容
  - 优先合并问答、追问、解释、纠正，不写细碎流水账
- `retrievalText`
  - 只能基于最终 `scene + points + entities`
- `evidenceMessageIds`
  - 只能引用原始消息 id
  - 必须精简且能直接支撑 candidate impression

### 阶段 2：印象对账与更新器

#### 定位

- 把 `candidate_impressions` 与 `old_impressions` 对账
- 结合 `history_messages + new_messages` 决定：
  - 更新旧 impression
  - 新建 impression
  - 丢弃 candidate
- 输出的是最终要落库的 impressions，不输出无需变化的旧 impression

#### 输出结构

```json
{
  "impressions": [
    {
      "sourceImpressionId": "old_id_or_null",
      "scene": "...",
      "points": ["..."],
      "entities": ["..."],
      "retrievalText": "..."
    }
  ]
}
```

#### 对账规则

- 先逐条校验 `candidate_impressions` 是否值得保留
  - 没有足够原始消息支持
  - 只是摘要性空话
  - 与原始聊天不符
  - 没有实质记忆价值
  - 以上情况直接丢弃
- 再判断 candidate 与哪条 `old_impression` 承接
  - 只有讨论对象、核心话题、互动情境明显连续时才承接
  - 承接时填写 `sourceImpressionId`
  - 不承接时填 `null`
- 承接旧 impression 时，优先：
  - 补充旧 point
  - 改写旧 point
  - 必要时才新增 point
- 如果出现不一致：
  - 不删除旧事实
  - 不直接覆盖旧事实
  - 在新的 point 中明确写“现在和之前不一致”或“现在补充了新的情况”
- 最终输出的 `points` 必须是整理后的结果，不允许：
  - 原样保留旧 points 再机械追加 candidate points
  - 完全抛开旧 points 只按 candidate 重写

### 当前规则

- 原始聊天消息优先于 `candidate_impressions` 和 `old_impressions`
- 必须显式区分 `history_messages` 和 `new_messages`
- 默认少量 candidate / impression，避免不必要的拆分
- `points` 只保留真正持久的记忆点，少写空泛总结
- 除非这一轮几乎只有一方持续输出，否则 `points` 应尽量体现双方内容
- 只写有明确聊天证据支持的内容，不根据常识、身份、语气推测用户未表达的事实
- 承接旧 impression 时，优先补充或改写旧 point，不直接覆盖旧事实
- 出现前后不一致时，在新 point 中明确写出变化，不抹掉旧事实
- `scene` 只写“我和用户在聊什么”，不写分析、建议、结论；主题不明时用“时间段 + 闲聊”
- `entities` 只保留最关键的客观锚点
- `retrievalText` 只能基于最终 `scene + points + entities` 生成
- `candidate_impressions` 必须绑定精简的 `evidenceMessageIds`

### 当前边界

- 当前 `Node2` 已拆成“候选印象重建器 + 印象对账与更新器”
- 当前没有 point 级状态机
- 当前没有 point 级冲突/补充分类存储
- 当前 `entities` 是轻量集合，不是复杂 schema
- 当前消息来源追溯仍以 impression 级为主，不是 point 级

### 后续可优化方向

- 继续收紧 candidate 丢弃规则，减少空泛候选
- 增强对账阶段对“补充旧 point / 改写旧 point / 新增 point / 冲突补记”的显式分类
- 增强多话题拆分判断，让多场景切换更稳
- 增强 `entities` 提取质量，让时间、关系、对象锚点更稳定
- 继续优化 `retrievalText`，让它更偏检索友好而不是自然串接
- 增加 point 级来源信息：
  - 让每个 point 绑定其对应的消息来源
  - 这不仅用于降低幻觉，也用于数据来源溯源、后台排查、后续删除和重算影响范围

## 用户画像 — 事实提取

### 定位

- 从用户对话中提取用户明确提到的个人事实和偏好
- 分为两类数据：
  - `结构化事实`：能枚举 key 的个人信息，存 MySQL
  - `非结构化文本`：无法预定义 key 的语义信息，存 Qdrant（暂未实现）
- 当前只实现结构化事实提取

### 触发机制

- Backend flush 时同时入队两个任务：
  - `chat-summary-queue`：现有印象生成流程（有 per-user 锁）
  - `chat-fact-queue`：事实提取（无锁）
- 两个队列并行消费，互不阻塞
- 事实提取不依赖印象生成结果

### 输入

- 只使用当前 batch 的新消息
- 不拼接历史消息（历史消息在之前的 batch 中已经提取过）
- 不依赖 Node1 / Node2 的输出

### 处理流程

1. 从 `chat-fact-queue` 取出 job
2. 调用 Dashscope（Qwen）做结构化提取
3. 返回 JSON，每个字段为提取值或 `null`
4. 过滤掉 `null` 字段
5. 对 `user_profiles` 表执行 upsert（按 `user_id` 匹配，有则更新，无则插入）

### 结构化字段定义

所有字段均为 `NULLABLE`，提取到什么填什么。

- 身份与背景：`name`、`nickname`、`age_range`、`gender`、`birthday`、`zodiac`、`location`、`hometown`、`ethnicity`
- 教育与职业：`education`、`major`、`school`、`occupation`、`work_years`
- 家庭与生活：`marital_status`、`has_children`、`pet`、`family_structure`
- 生活习惯：`diet`、`exercise`、`sleep_schedule`、`smoking`、`drinking`、`cooking`
- 兴趣偏好：`hobbies`、`favorite_food`、`favorite_drink`、`favorite_music`、`favorite_sport`、`favorite_books`、`favorite_movies`、`favorite_travel`

### 存储

```sql
CREATE TABLE user_profiles (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL UNIQUE,

  -- 身份与背景
  name            VARCHAR(64) NULL,
  nickname        VARCHAR(64) NULL,
  age_range       VARCHAR(32) NULL,
  gender          VARCHAR(16) NULL,
  birthday        VARCHAR(32) NULL,
  zodiac          VARCHAR(16) NULL,
  location        VARCHAR(64) NULL,
  hometown        VARCHAR(64) NULL,
  ethnicity       VARCHAR(32) NULL,

  -- 教育与职业
  education       VARCHAR(32) NULL,
  major           VARCHAR(64) NULL,
  school          VARCHAR(64) NULL,
  occupation      VARCHAR(64) NULL,
  work_years      VARCHAR(16) NULL,

  -- 家庭与生活
  marital_status  VARCHAR(16) NULL,
  has_children    VARCHAR(64) NULL,
  pet             VARCHAR(128) NULL,
  family_structure VARCHAR(128) NULL,

  -- 生活习惯
  diet            VARCHAR(128) NULL,
  exercise        VARCHAR(128) NULL,
  sleep_schedule  VARCHAR(64) NULL,
  smoking         VARCHAR(32) NULL,
  drinking        VARCHAR(32) NULL,
  cooking         VARCHAR(64) NULL,

  -- 兴趣偏好
  hobbies         VARCHAR(256) NULL,
  favorite_food   VARCHAR(256) NULL,
  favorite_drink  VARCHAR(128) NULL,
  favorite_music  VARCHAR(256) NULL,
  favorite_sport  VARCHAR(128) NULL,
  favorite_books  VARCHAR(256) NULL,
  favorite_movies VARCHAR(256) NULL,
  favorite_travel VARCHAR(256) NULL,

  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_user (user_id)
);
```

### 提取 Prompt 要点

- 只提取用户直接说出的事实，不推测
- 没有提到的字段返回 `null`
- 同一字段如果用户说了新值，以新值为准
- 多值字段（如 hobbies、favorite_food）以顿号或逗号分隔存储

### 当前边界

- 事实提取不做锁，同一用户并发执行时 MySQL upsert 天然幂等
- 大部分 batch 可能提取不到新信息，输出全 `null` 时跳过写库
- 当前不处理字段冲突检测（如用户先说 A 后说 B），统一以最新值为准
- 非结构化文本存储（Qdrant）暂未实现

### 后续可优化方向

- 实现非结构化文本提取，存入 Qdrant 单独 collection
- 增加字段级来源追溯（哪个 batch / 哪条消息提取的）
- 增加字段更新时间戳，用于判断信息时效性
- 基于会话印象实现深层用户建模（跨场景聚合推理）
