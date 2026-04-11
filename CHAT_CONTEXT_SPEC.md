# Chat Context Spec

## 目标

- 提供一个同步接口，在用户发来新消息后、生成 AI 回复前，召回本次回复所需的历史上下文。
- 这个接口不走 LLM，不生成 Node1 草稿，不做关键词提取，只做固定规则的消息拼接和向量检索。

## 接口

- `POST /api/chat-context`
- 不要求鉴权
- 调用方必须在请求体中显式传 `userId`

请求体：

```json
{
  "userId": 1,
  "message": "用户这次刚发来的新消息",
  "limit": 6
}
```

返回体：

```json
{
  "context": [
    {
      "scene": "...",
      "points": ["..."],
      "time": "2026-04-08 09:14:29"
    }
  ]
}
```

## 召回路线

### 1. 近期印象

- 从当前用户的 impressions 中取最近 `7` 天内的近期 impression
- 最多取 `5` 条
- 按 `lastActivatedAt desc` 排序；如果为空则回退 `updatedAt` / `createdAt`
- 这一路只用于补近期主线，不主导最终排序
- 这个接口**不更新** `lastActivatedAt`
- `lastActivatedAt` 仍只在 impression 创建或更新时写入

### 2. 历史窗口召回

- 取当前用户最近 `20` 条历史消息
- 不再按 session 切分，统一按 `userId` 维度取最新消息
- 每条消息保留原文；如果单条消息超过 `100` 字，直接截断到 `100` 字
- 按时间顺序拼接为 `windowQuery`

格式：

```text
最近历史对话：
[用户] ...
[AI] ...
[用户] ...
[AI] ...
```

- 对 `windowQuery` 做 `1` 次 embedding
- 再对 Qdrant 做 `1` 次按 `userId` 过滤的 impression 向量检索
- 默认取 `top 8`

### 3. 最新输入召回

- 取最近 `4` 轮历史对话作为补充信息
- `4` 轮按最多 `8` 条历史消息处理，包含用户和 AI
- 每条消息保留原文；如果单条消息超过 `100` 字，直接截断到 `100` 字
- 在这段历史之后追加当前用户新消息，形成 `latestQuery`

格式：

```text
最近4轮对话：
[用户] ...
[AI] ...
[用户] ...
[AI] ...

当前用户新消息：
[用户] ...
```

- 对 `latestQuery` 做 `1` 次 embedding
- 再对 Qdrant 做 `1` 次按 `userId` 过滤的 impression 向量检索
- 默认取 `top 8`

## 融合排序

- 三路结果统一合并
- 先按 impression `id` 去重
- 再按 ancestor chain 去重，避免同一记忆链上的父子 impression 同时进入上下文

最终分数：

```text
finalScore =
  latestScore * 0.50 +
  windowScore * 0.30 +
  recentBoost * 0.15 +
  salienceScore * 0.05
```

说明：

- `latestScore`
  - 来自最新输入召回的向量相似度
- `windowScore`
  - 来自历史窗口召回的向量相似度
- `recentBoost`
  - 近期 impression 的时间加成，不来自向量相似度
- `salienceScore`
  - impression 现有记忆强度，做归一化后参与最终排序

最终保留：

- 默认返回 `top 6`

## 当前会话约束

- 当前产品方向不再强调多 session 切分
- 初次创建会话后，后续默认复用同一个 session id
- 同步上下文接口本身不依赖 session 过滤，只按 `userId` 维度取最近历史消息和 impressions
