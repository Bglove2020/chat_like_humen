# Chat Like Human - 聊天机器人设计文档

**日期:** 2026-03-31
**状态:** 设计完成，待实现

---

## 1. 项目概述

创建一个模拟"AI对用户印象"的聊天机器人，最小化实现。

### 技术栈

| 模块 | 技术 |
|------|------|
| 前端 | Vite + React |
| 后端 | MidwayJS |
| 数据库 | MySQL（已有） |
| 向量库 | Qdrant（已有） |
| 消息队列 | Redis + BullMQ（已有） |
| AI 对话 | Dify Workflow API |
| 摘要生成 | Qwen via DashScope API |

---

## 2. 系统架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Frontend  │────▶│  MidwayJS    │────▶│    Dify     │
│  (React)    │◀────│  (API)       │◀────│  (Workflow) │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                           │ 写入队列
                           ▼
                    ┌─────────────┐
                    │  BullMQ     │
                    │  (Redis)    │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐     ┌─────────────┐
                    │  Worker     │────▶│   Qdrant    │
                    │ (独立进程)  │     │  (摘要存储) │
                    └──────┬──────┘     └─────────────┘
                           │ 写入向量
                           ▼
                    ┌─────────────┐
                    │  Qwen API   │
                    │ (DashScope) │
                    └─────────────┘

                    ┌─────────────┐
                    │   MySQL     │  存用户信息
                    └─────────────┘
```

---

## 3. 数据模型

### 3.1 MySQL - 用户表

```sql
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.2 Qdrant - 印象向量集合

**集合名称:** `user_impressions`

**向量结构:**
- id: UUID（格式: `{userId}_{date}_{index}`）
- vector: float[1536]（Qwen embedding 向量）
- payload: `{userId, date, summaryText, createdAt}`

**示例:**
```
id: "123_2026-03-31_1"
vector: [0.123, -0.456, ...]
payload: {
  "userId": 123,
  "date": "2026-03-31",
  "summaryText": "用户想做减脂计划，目标3个月减10kg。我建议了跑步方案，他表示以前没接触过器械。后续可以讲讲跑步的正确姿势。",
  "createdAt": "2026-03-31T10:05:30.123Z"
}
```

---

## 4. API 设计

### 4.1 用户注册
**POST /api/register**
- 输入: `{username, password}`
- 输出: `{success: true}` 或 `{error: "用户名已存在"}`

### 4.2 用户登录
**POST /api/login**
- 输入: `{username, password}`
- 输出: `{token: "jwt..."}` 或 `{error: "认证失败"}`

### 4.3 发送聊天消息
**POST /api/chat** (需认证，Header: `Authorization: Bearer {token}`)
- 输入: `{message: "用户消息"}`
- 输出: `{reply: "AI回复"}`（流式）

### 4.4 检索相似印象（给 Dify HTTP 节点调用）
**POST /api/retrieve**
- 输入: `{query: "检索文字"}`
- 输出:
```json
[
  {"content": "用户想做减脂计划...", "score": 0.95},
  {"content": "用户询问增肌饮食建议...", "score": 0.87}
]
```

---

## 5. 消息队列设计

### 5.1 队列名称
`chat-summary-queue`

### 5.2 入队时机

**时机1: 用户发消息**
```
用户发送消息 → 发给Dify（同时，实时）
    ↓
5s防抖计时器开始
    ↓
5s内无新消息 → 从今日消息凑够15条 → 入队列
```

**时机2: Dify返回完整消息**
```
Dify回复 → 流式返回前端
    ↓
5s防抖计时器开始
    ↓
5s内无新消息 → 从今日消息凑够15条 → 入队列
```

### 5.3 批次消息结构

```json
{
  "userId": 123,
  "date": "2026-03-31",
  "batchId": "uuid-xxx",
  "messages": [
    {"role": "user", "content": "我想开始健身", "timestamp": "2026-03-31T09:30:15.123"},
    {"role": "assistant", "content": "好的，想减脂还是增肌？", "timestamp": "2026-03-31T09:30:16.456"},
    {"role": "user", "content": "减脂", "timestamp": "2026-03-31T09:30:20.789"}
    // ... 共15条，按时间顺序，不够15条有多少发多少
  ]
}
```

### 5.4 消息来源

- 队列中的消息 = 今日已完成对话片段
- 不包含正在和Dify进行中的消息
- 15条 = 用户消息 + AI回复的混合

---

## 6. Worker 设计

### 6.1 处理流程

```
1. 从 BullMQ 取出 batch（15条消息）
2. 查询 Qdrant：该用户今日印象列表
3. 组装 Prompt（印象列表 + 消息）
4. 调用 Qwen（DashScope API）生成判断
5. 收到 LLM 结果后，Qdrant upsert 印象
6. ack 队列消息
```

### 6.2 非阻塞设计

Worker 异步并发处理，不阻塞在 LLM 调用上：
- 取出一条消息即可 ack（或失败重试）
- LLM 调用完成后更新 Qdrant

### 6.3 印象生成逻辑

- 逐条处理每条新消息
- 判断该消息与哪个已有印象语义相关
- 相关 → 合并更新该印象
- 不相关 → 新建印象
- 多条消息讨论同一主题 → 合并处理

### 6.4 提示词模板

```
你是Dify AI Agent的记忆整理助手。

## 任务
根据新消息和已有印象，判断每条新消息应该合并到哪个印象，或者需要新建印象。

## 印象列表（当前已有的印象，按时间倒序）
现有印象数量：{count}
{impressions}
格式：
  印象{idx} [创建时间]: "{summary_text}"

## 今日消息（用于生成新印象或更新已有印象）
{messages}
格式：
  [{role}] {timestamp}: {content}

## 处理要求
1. 仔细阅读今日消息，理解当前讨论的背景
2. 逐条处理每条消息
3. 判断该消息与哪个已有印象语义相关（讨论同一主题）
4. 如果相关：提供该印象的更新内容（融合新信息，保持人脑记忆风格）
5. 如果不相关：标记需要新建印象，并写出内容
6. 注意短回复（"对/好的/嗯"等）需结合上下文判断归属

## 输出格式（JSON）
{
  "decisions": [
    {
      "message": "消息内容",
      "action": "merge" | "create",
      "target_impression": "印象ID或'新建'",
      "reason": "判断理由"
    }
  ],
  "impressions": [
    {
      "id": "印象ID（更新已有印象填写该ID；新建填写'new_1'）",
      "content": "印象内容，50-100字，自然语言风格，如同人脑对这段对话的印象",
      "action": "update" | "create"
    }
  ]
}
```

---

## 7. Dify 对接

### 7.1 聊天接口

- API 类型: Dify App API（V1/chat/completion-messages）
- 认证: API Key 在请求头 `Authorization: Bearer {api_key}`
- 消息存储: Dify 侧已有历史记录

### 7.2 RAG 检索流程

```
Dify Workflow 执行中
    ↓
HTTP 节点调用 /api/retrieve
    ↓
MidwayJS 查询 Qdrant
    ↓
返回相似印象列表
    ↓
Dify 使用上下文继续生成回复
```

---

## 8. 安全考虑

| 项目 | 方案 |
|------|------|
| JWT 密钥 | 存储在环境变量 |
| 密码 | bcrypt 加密 |
| /api/retrieve | 建议 Dify IP 白名单保护 |

---

## 9. 项目结构

```
/root/chat_like_human/
├── frontend/              # Vite + React
│   └── src/
├── backend/               # MidwayJS
│   └── src/
│       ├── controller/    # API 路由
│       ├── service/       # 业务逻辑
│       ├── entity/        # TypeORM 实体
│       └── queue/         # BullMQ 生产者
├── worker/                # 独立进程
│   └── src/
│       └── summaryWorker.ts
├── docs/
│   └── specs/
│       └── 2026-03-31-chat-design.md
├── docker-compose.yml     # Qdrant/Redis/MySQL
└── README.md
```

---

## 10. 最小化实现清单

- [ ] 前端项目初始化（Vite + React）
- [ ] 后端项目初始化（MidwayJS）
- [ ] MySQL 用户表创建
- [ ] /api/register 接口
- [ ] /api/login 接口（JWT）
- [ ] /api/chat 接口（转发 Dify）
- [ ] /api/retrieve 接口（Qdrant 检索）
- [ ] BullMQ 消息队列集成
- [ ] 防抖机制（5s）
- [ ] 凑15条消息逻辑
- [ ] Worker 独立进程
- [ ] Qwen API 调用（DashScope）
- [ ] Qdrant 存取印象
- [ ] 提示词调优
