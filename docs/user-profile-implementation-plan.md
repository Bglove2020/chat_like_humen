# 用户画像实现方案

## 目标

在现有聊天系统和自研 impression 记忆系统之外，新增一条异步用户画像链路。

用户画像分成两部分：

- `固定字段画像`：AGENTS.md 中已经列出的可枚举字段，存 MySQL `user_profiles`。
- `开放式偏好画像`：无法提前枚举的用户偏好、习惯、约束、目标等，存 Qdrant 独立 collection `user_profile_memories`。

这条链路不替换现有记忆系统，不阻塞聊天回复，不影响现有 impression 生成。

## 总体链路

现有 impression 链路保持不变：

```text
用户消息进入后端
  -> 后端调用 Dify 获取回复
  -> 用户消息和 AI 回复写入 MySQL
  -> flush 满足 10 条消息或 2 分钟
  -> 入队 chat-summary-queue
  -> worker 生成 impression
  -> 写入 Qdrant user_impressions
```

新增画像链路：

```text
同一次 flush
  -> 取当前 batch 的新用户消息
  -> 入队 chat-fact-queue
  -> worker 提取用户画像
  -> 固定字段 upsert 到 MySQL user_profiles
  -> 开放式偏好对账后写入 Qdrant user_profile_memories
```

`chat-summary-queue` 和 `chat-fact-queue` 并行消费，互不阻塞。

## 不做的事情

- 不改变 flush 条件：仍然是 `10 条消息` 或 `2 分钟`。
- 不改变单次 flush 最多携带最近 `15` 条消息。
- 不把用户画像生成放进 `/api/chat` 同步链路。
- 不依赖 Node1 / Node2 的输出。
- 不写入现有 `user_impressions` collection。
- 不从 AI 回复里提取用户事实。
- 不根据常识、语气、身份、问句推测用户没有直接说出的事实。

## 数据来源

画像提取只使用当前 flush 中的新用户消息：

```ts
messages
  .filter((message) => message.isNew !== false)
  .filter((message) => message.role === 'user')
```

原因：

- 历史消息之前已经被处理过，不需要重复提取。
- 用户画像关注用户自己表达的事实和偏好。
- AI 回复可能包含推测、建议或复述，不能作为用户事实来源。

## Backend 改动

### 1. 新增 chat-fact-queue

修改：

```text
backend/src/queue/queue.module.ts
backend/src/queue/queue.service.ts
```

在 `QueueModule` 中同时注册：

```text
chat-summary-queue
chat-fact-queue
```

新增 `enqueueFactBatch`：

```ts
export interface FactJobData {
  userId: number;
  batchId: string;
  messages: Array<{
    messageId?: number;
    role: 'user';
    content: string;
    timestamp: string;
  }>;
}
```

入队规则：

- 只传当前 batch 的新用户消息。
- 如果本次 flush 没有用户消息，则不入队。
- fact 入队失败只记录日志，不影响 summary 入队。

### 2. flush 时并行入队

修改：

```text
backend/src/chat/chat.service.ts
```

在 `doFlush` 中：

- 继续构建 summary payload，入队 `chat-summary-queue`。
- 从当前 flush 的 `messages` 中提取用户新消息，入队 `chat-fact-queue`。

建议不要让两个队列互相包在一个事务里。画像失败不能影响现有记忆。

### 3. 新增 user_profiles 表

新增实体：

```text
backend/src/users/user-profile.entity.ts
```

表名：

```text
user_profiles
```

字段按 AGENTS.md 中的固定字段定义：

- 身份与背景：`name`、`nickname`、`age_range`、`gender`、`birthday`、`zodiac`、`location`、`hometown`、`ethnicity`
- 教育与职业：`education`、`major`、`school`、`occupation`、`work_years`
- 家庭与生活：`marital_status`、`has_children`、`pet`、`family_structure`
- 生活习惯：`diet`、`exercise`、`sleep_schedule`、`smoking`、`drinking`、`cooking`
- 兴趣偏好：`hobbies`、`favorite_food`、`favorite_drink`、`favorite_music`、`favorite_sport`、`favorite_books`、`favorite_movies`、`favorite_travel`

约束：

- `user_id` 唯一。
- 所有画像字段 nullable。
- `created_at` / `updated_at` 自动维护。

### 4. 新增固定字段 upsert 服务

新增：

```text
backend/src/users/user-profile.service.ts
```

职责：

- 过滤 `null`、空字符串、空数组。
- 如果所有字段为空，跳过写库。
- 按 `userId` upsert。
- 新值覆盖旧值。

第一版不做字段级冲突检测，不做字段级来源追溯。

### 5. 新增内部 upsert 接口

新增内部接口：

```text
POST /api/internal/user-profiles/upsert
```

请求体：

```json
{
  "userId": 1,
  "batchId": "1_2026-04-11_1712800000000",
  "fields": {
    "nickname": "小张",
    "favorite_drink": "冰美式",
    "sleep_schedule": "晚上喝咖啡容易睡不着"
  }
}
```

这个接口只给 worker 调用，前端不直接使用。

## Worker 改动

### 1. 新增 FactProcessor

新增：

```text
worker/src/processor/fact.processor.ts
```

使用：

```ts
@Processor('chat-fact-queue')
```

处理流程：

1. 读取 `FactJobData`。
2. 如果没有用户消息，直接跳过。
3. 调用 `FactExtractionService`。
4. 将固定字段 POST 到 backend 内部 upsert 接口。
5. 将开放式偏好写入 Qdrant `user_profile_memories`。
6. 记录日志：固定字段数量、偏好候选数量、创建/更新/替换/丢弃数量。

第一版不加 per-user lock。原因：

- 固定字段 upsert 天然幂等。
- 开放式偏好可以通过 source message id 和语义对账降低重复。
- 即使偶发重复，也不影响聊天主链路，后续可用重算脚本修复。

### 2. 新增 FactExtractionService

新增：

```text
worker/src/services/fact-extraction.service.ts
```

职责：

- 调 Qwen 提取结构化字段。
- 调 Qwen 提取开放式偏好候选。
- 标准化模型输出。
- 过滤低价值、无证据、推测性内容。

模型输出建议：

```json
{
  "structuredProfile": {
    "name": null,
    "nickname": null,
    "favorite_drink": "冰美式"
  },
  "preferenceMemories": [
    {
      "type": "preference",
      "category": "drink",
      "subject": "冰美式",
      "preference": "用户喜欢喝冰美式",
      "condition": "晚上不太敢喝",
      "reason": "怕睡不着",
      "polarity": "like",
      "confidence": 0.9,
      "evidenceMessageIds": ["123"]
    }
  ]
}
```

提取规则：

- 只提取用户直接说出的事实。
- 未提到的固定字段返回 `null`。
- 不把问句当成偏好。
- 不把一次临时选择当成长期偏好，除非用户明确表达“平时、一直、最近常、我不吃、我喜欢、我讨厌、我习惯”等稳定含义。
- 多值字段用顿号或逗号合并。
- `evidenceMessageIds` 必须来自原始用户消息。

## 固定字段画像

固定字段适合放 MySQL，因为它们：

- 字段可枚举。
- 需要快速展示。
- 适合直接覆盖。
- 适合直接拼进 Dify 上下文。

示例：

```json
{
  "userId": 1,
  "nickname": "小张",
  "location": "广州",
  "favorite_drink": "冰美式",
  "diet": "不吃香菜"
}
```

更新策略：

- 新字段覆盖旧字段。
- 空值不覆盖旧字段。
- 如果模型返回全 `null`，跳过写库。

## 开放式偏好画像

开放式偏好不适合放宽表，因为它无法提前枚举，且需要语义召回。

新增 Qdrant collection：

```text
user_profile_memories
```

不要写入：

```text
user_impressions
```

原因：

- `user_impressions` 记录聊天印象。
- `user_profile_memories` 记录用户长期偏好、习惯、约束、目标。
- 两者 payload schema 不同。
- 分开 collection 更方便清理、回放、对比和扩展。

### Payload 结构

```ts
interface UserProfileMemoryPayload {
  userId: number;
  type: 'preference' | 'habit' | 'constraint' | 'goal' | 'dislike' | 'style';
  category: string;
  subject: string;
  preference: string;
  condition?: string | null;
  reason?: string | null;
  polarity: 'like' | 'dislike' | 'neutral' | 'avoid' | 'prefer';
  confidence: number;
  status: 'active' | 'superseded';
  sourceMessageIds: number[];
  batchId: string;
  retrievalText: string;
  createdAt: string;
  updatedAt: string;
  lastActivatedAt: string;
  supersededById?: string | null;
}
```

`retrievalText` 只能基于最终字段生成，不能新增事实。

示例：

```json
{
  "userId": 1,
  "type": "preference",
  "category": "drink",
  "subject": "冰美式",
  "preference": "用户喜欢喝冰美式",
  "condition": "晚上不太敢喝",
  "reason": "怕睡不着",
  "polarity": "like",
  "confidence": 0.9,
  "status": "active",
  "sourceMessageIds": [123],
  "batchId": "1_2026-04-11_1712800000000",
  "retrievalText": "用户喜欢喝冰美式，但晚上不太敢喝，因为怕睡不着。"
}
```

## 开放式偏好对账

这部分借鉴现有 impression 的“候选生成 + 旧记录对账”思路，但比 impression 更轻。

不需要 Node1 三草稿。偏好画像不是为了召回旧聊天场景，而是拿“候选偏好本身”去召回旧偏好。

流程：

```text
用户新消息
  -> 提取 preference candidates
  -> 每个 candidate 生成 retrievalText
  -> embedding
  -> 检索 user_profile_memories top 5
  -> 对账
  -> create / update / supersede / discard
```

动作定义：

- `create`：没有相关旧偏好，新建。
- `update`：同一 subject/category，当前信息是补充或更精确表达。
- `supersede`：当前信息和旧 active 偏好冲突，旧记录标记为 `superseded`，新建 active 记录。
- `discard`：太空泛、无长期价值、无消息证据、只是重复表达。

第一版可以先用确定性规则：

- `category + subject` 相同：进入 update/supersede 判断。
- 语义分高且锚点重合：进入 update 判断。
- 出现“现在不、不再、改成、更喜欢、以前...现在”等变化表达：进入 supersede 判断。
- 没有实质增量：discard。

后续如果规则不够稳，再增加一个轻量 Qwen reconcile prompt。

## 冲突处理

不要直接覆盖旧偏好。

例子：

```text
旧记录：用户喜欢喝拿铁。
新消息：我现在不太喝拿铁了，最近更喜欢冰美式。
```

处理：

- 旧拿铁记录：`status = superseded`
- 新冰美式记录：`status = active`
- 新记录可以写明“用户现在更喜欢冰美式，之前提到过拿铁但现在不太喝”

补充例子：

```text
旧记录：用户喜欢冰美式。
新消息：我喜欢冰美式，尤其是少冰不加糖。
```

处理：

- 更新旧记录。
- 新 `preference`：`用户喜欢冰美式，偏好少冰不加糖`

## chat-context 接入

后续扩展 `POST /api/chat-context`，保持现有 `context` 字段不变，新增 `userProfile` 字段。

响应示例：

```json
{
  "context": [
    {
      "scene": "聊咖啡和睡眠",
      "points": ["用户提到晚上喝咖啡容易睡不着，我围绕咖啡因影响做了回应。"],
      "time": "2026-04-11 10:00:00"
    }
  ],
  "userProfile": {
    "structured": {
      "nickname": "小张",
      "favorite_drink": "冰美式"
    },
    "preferences": [
      {
        "text": "用户喜欢冰美式，偏好少冰不加糖。",
        "time": "2026-04-11 10:00:00"
      }
    ]
  }
}
```

Dify 可以继续消费原有 `context`，再逐步接入 `userProfile`。

画像召回规则：

- 固定字段：按 `userId` 从 MySQL 读取。
- 开放式偏好：用当前 `message` 和最近几轮消息构造 query，检索 `user_profile_memories`。
- 默认返回 active 偏好 top 5。
- 不更新 `lastActivatedAt`，除非后续明确需要“画像被召回”也算激活。

## 实现顺序

1. 新增 `user_profiles` entity 和 upsert service。
2. 新增 backend 内部 upsert 接口。
3. 注册 `chat-fact-queue`。
4. 在 flush 时入队 fact job。
5. 新增 worker `FactProcessor`。
6. 新增 `FactExtractionService`，先实现固定字段提取。
7. 新增 `user_profile_memories` Qdrant collection 管理。
8. 实现开放式偏好 candidate 提取。
9. 实现开放式偏好对账和写入。
10. 扩展 `/api/chat-context` 返回 `userProfile`。
11. 增加单元测试和集成测试。

## 测试计划

Backend 单测：

- 固定字段全空时跳过 upsert。
- 固定字段新值覆盖旧值。
- flush 同时入队 summary 和 fact。
- fact 入队失败不影响 summary 入队。

Worker 单测：

- 用户问句不会被提取成偏好。
- 明确偏好能生成 candidate。
- 同 subject 补充信息会 update。
- 冲突偏好会 supersede 旧记录并 create 新记录。
- 无 evidenceMessageIds 的 candidate 会被丢弃。

集成测试：

- 发送 10 条包含用户事实的消息，等待 fact job，验证 `user_profiles`。
- 发送开放式偏好，验证 Qdrant `user_profile_memories`。
- 调用 `/api/chat-context`，验证返回 `userProfile.structured` 和 `userProfile.preferences`。

## 后续优化

- 字段级来源追溯：记录每个字段来自哪个 batch / message。
- 字段级更新时间：判断画像时效性。
- 开放式偏好增加 salience 和 decay。
- 偏好对账从确定性规则升级为 Qwen reconcile。
- 增加后台画像调试接口，展示固定字段和开放式偏好。
