# Chat Impression 测试方案

## 目标

本轮测试以 `CHAT_IMPRESSION_DESIGN.md` 为准，验证当前项目已经从“摘要生成”改造成“聊天印象”系统，并且关键数据流在开发/测试环境中完整可追踪。

必须覆盖的文档要求：

- flush 规则固定为 `10 条消息` 或 `2 分钟`
- 单次 flush 最多携带最近 `15` 条消息
- Worker 按 `4` 个 LLM 节点处理
- 检索后必须做 `impressionId` 去重和祖先链去重
- 更新规则必须满足“`同一记忆日 + 命中叶子节点`”
- 历史节点默认冻结，跨记忆日只能新建 `continued`
- 必须异步生成印象
- 必须写入 Qdrant
- 必须写入 `impression_message_links`
- 检索排序必须包含 `salienceScore + lastActivatedAt + decay`

## 测试分层

### 1. 单元测试

#### 1.1 Backend

| 编号 | 模块 | 用例 | 预期 |
|------|------|------|------|
| BE-U01 | `memory-date` | `05:00` 前后的记忆日切换 | `04:59:59` 归前一日，`05:00:00` 归当日 |
| BE-U02 | `queue.service` | 按最新消息时间计算 `memoryDate` | job 中 `date` 符合记忆日规则 |
| BE-U03 | `queue.service` | flush payload 截断 | job `messages.length <= 15` |
| BE-U04 | `queue.service` | 透传 `messageId` | 每条 queue message 都有 `messageId` |
| BE-U05 | `impressions.service` | `impression_message_links` 幂等写入 | 重复写入不会产生重复记录 |

#### 1.2 Worker

| 编号 | 模块 | 用例 | 预期 |
|------|------|------|------|
| WK-U01 | `impression-logic` | `effectiveScore` 计算 | 热度越高、越新，得分越高 |
| WK-U02 | `impression-logic` | 按 `impressionId` 去重 | 同 ID 多次召回只保留最高相似度 |
| WK-U03 | `impression-logic` | 祖先链去重 | 同链祖先和后继同时命中时仅保留后继 |
| WK-U04 | `impression-logic` | 同 root 不同叶子不去重 | 两个分叉叶子都保留 |
| WK-U05 | `impression-logic` | update 准入规则 | 仅“叶子 + 同记忆日”返回可 update |
| WK-U06 | `dashscope.service` | 节点 1 结果标准化 | candidate 的 `action/messageIndexes` 可落地 |
| WK-U07 | `dashscope.service` | 节点 2 query 生成 | 至少返回 1 条临时 query |
| WK-U08 | `dashscope.service` | 节点 3 来源判定 | 仅同一主线才选 `sourceImpressionId` |
| WK-U09 | `dashscope.service` | 节点 4 最终内容生成 | `continued/changed` 会保留旧背景并加入新变化 |

### 2. 集成测试

#### 2.1 主链路集成

| 编号 | 场景 | 步骤 | 预期 |
|------|------|------|------|
| INT-01 | 消息入库 | 发送 1 轮问答 | `chat_messages` 新增 user + assistant |
| INT-02 | 10 条 flush | 累计 10 条消息 | Redis/BullMQ 出现新 job |
| INT-03 | 2 分钟 flush | 不足 10 条消息等待 2 分钟 | 自动 flush |
| INT-04 | flush payload | 检查最新 job | 包含 `batchId/date/messages/messageId/isNew`，且最多 15 条 |
| INT-05 | Worker 异步消费 | flush 后等待 worker | job 从 `wait/active` 进入 `completed` |
| INT-06 | Qdrant 落库 | 完成消费后查询 Qdrant | 新 impression 存在，payload 含 `memoryDate/content/salienceScore/lastActivatedAt` |
| INT-07 | message links 落库 | 查询 impression 对应 links | `impression_message_links` 存在，且能回看原始消息 |

#### 2.2 文档规则集成

| 编号 | 场景 | 步骤 | 预期 |
|------|------|------|------|
| INT-08 | standalone | 首次聊全新主线 | 新建 `originType=standalone`，`rootImpressionId=self` |
| INT-09 | 同记忆日 continued update | 同一主线当天继续聊，命中叶子 | 原 impression 被 update，`salienceScore` 增加，`lastActivatedAt` 更新 |
| INT-10 | 跨记忆日 continued create | 隔天继续同一主线 | 旧 impression 冻结，新建 `originType=continued` |
| INT-11 | 非叶子 continued create | 命中旧节点但它已有子节点 | 不更新旧节点，新建 `continued` |
| INT-12 | changed | 同一主线出现显著变化/冲突 | 最终内容明确记录变化，不直接抹掉旧历史 |
| INT-13 | 祖先链去重 | 召回同时命中祖先和后继 | 节点 3 输入中只保留后继 |
| INT-14 | 分叉链保留 | 同 root 下多个叶子同时命中 | 多个叶子都保留参与判定 |
| INT-15 | 遗忘排序 | 构造新旧热度不同的 impression | 检索排序体现 `effectiveScore` 差异 |

### 3. 端到端测试

| 编号 | 场景 | 步骤 | 预期 |
|------|------|------|------|
| E2E-01 | 用户注册并聊天 | 注册、登录、发送消息 | 聊天主链路正常 |
| E2E-02 | 多主题拆分 | 同一 batch 里混合两个主线 | 生成至少两条独立 impression |
| E2E-03 | message links 回溯 | 从 impression 查询原文 | 返回当前 batch 对应消息 |
| E2E-04 | 印象列表页 | 前端打开 `/summaries` | 可看到最新 impression |
| E2E-05 | 同日续写可见 | 同一主线再次聊天 | impression 数量不异常增长，内容体现增量更新 |
| E2E-06 | 跨日续写可见 | 人工构造跨记忆日 batch | 同 root 下出现新节点，旧节点保留 |

## 关键数据流检查点

测试执行时，必须逐节点检查以下数据：

1. MySQL `chat_messages`
   检查消息是否按 user/assistant 成对写入。

2. Redis / BullMQ
   检查是否在满足 flush 条件后才入队；job 是否带 `batchId`、`memoryDate`、`messageId`、最近 `15` 条消息。

3. Worker 节点日志
   检查每个 batch 是否输出：
   - 节点 1 candidate 数量
   - 节点 2 query 数量
   - 节点 3 `sourceImpressionId/relationType`
   - 节点 4 最终内容

4. Qdrant payload
   检查 impression 是否具备：
   - `content`
   - `memoryDate`
   - `sourceImpressionId`
   - `rootImpressionId`
   - `originType`
   - `salienceScore`
   - `lastActivatedAt`

5. MySQL `impression_message_links`
   检查 `impressionId/messageId/batchId` 是否落库，并能正确关联到原始消息。

## 本次执行顺序

1. 先跑单元测试，锁定纯逻辑正确性。
2. 启动开发基础设施、后端、worker、前端。
3. 跑主链路集成测试，逐节点检查 MySQL/Redis/Qdrant。
4. 跑同日续写、跨日续写、changed、祖先链去重专项测试。
5. 完成开发环境验证后，构建并发布到生产环境。
6. 生产环境只做发布后烟雾校验，不与开发数据混用。
