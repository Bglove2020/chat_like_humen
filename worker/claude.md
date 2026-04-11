# Claude Code 项目经验沉淀

## 问题与解决方案记录

### 1. BullMQ Redis Key 前缀不一致问题

**问题描述**：
Redis 中存在两套 key 前缀：`bull:` 和 `bullmq:`。Backend 使用 `bull:` 前缀写入队列，但 worker 默认使用 `bullmq:` 前缀读取，导致 jobs 无法被消费。

**症状**：
- Backend enqueue 成功，Redis 中有 `bull:chat-summary-queue:*` 键
- Worker 日志显示 "Waiting for jobs..." 但无 "Processing" 输出
- `redis.keys('bullmq:*')` 返回 0 条，但 `redis.keys('bull:*')` 返回几十条

**根本原因**：
BullMQ 默认使用 `bullmq:` 前缀，但某些 BullMQ 版本或配置使用 `bull:` 前缀。QueueModule 和 WorkerModule 的 BullModule.forRootAsync 需要显式指定 prefix。

**解决方案**：
在 `BullModule.forRootAsync` 中添加 `prefix: 'bull'` 配置（与 Redis 中已有 keys 保持一致）：
```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    connection: {
      host: configService.get<string>('redis.host'),
      port: configService.get<number>('redis.port'),
      password: configService.get<string>('redis.password'),
    },
    prefix: 'bull', // 统一前缀，与 Redis 中已有键一致
  }),
}),
```

**验证方法**：
```bash
# 使用 node + ioredis 检查（redis-cli 可能不支持某些操作）
node -e "
const Redis = require('ioredis');
const redis = new Redis({ host: 'localhost', port: 6379, password: 'xxx' });
redis.keys('bull:chat-summary-queue:*').then(k => console.log('bull: keys:', k.length));
redis.keys('bullmq:chat-summary-queue:*').then(k => console.log('bullmq: keys:', k.length));
"
```

**Redis Key 类型说明**：
- `bull:chat-summary-queue:XX` (hash) = 单独的 job 数据
- `bull:chat-summary-queue:completed` (zset) = 已完成 job ID 列表
- `bull:chat-summary-queue:failed` (zset) = 失败 job ID 列表
- `bull:chat-summary-queue:id` (string) = 自增 ID 计数器

**重要发现**：
Worker 处理完 job 后，job 数据仍保留在 Redis 中（hash），只是从 wait 队列移除。Job ID 是自增的，job ID ≠ userId。

---

### 2. 消息摘要生成提示词优化（AI 视角）

**问题描述**：
用户发送多条相关消息时，系统为每条消息生成单独的摘要印象，导致同一主题产生多条相似印象。

**优化后的提示词模板**（中文，AI 视角）：

```
## 已有的对话印象：
${existingText}

## 本次新消息（按对话顺序）：
${newMessagesText}${historicalText}

## 你的任务：
以**AI的视角**，总结这段对话给AI留下的印象。这不是单纯记录"用户说了什么"，而是AI与用户这段交流后，对用户形成的整体认知。

## 核心规则：
1. **双向总结**：不仅要总结用户表达的内容（需求、偏好、问题等），也要总结AI回复的要点（提供了什么建议，信息、方法等）
2. **合并同类**：如果用户多轮消息都在讨论同一话题，应该合并为一条印象
3. **更新已有**：如果新话题与已有印象相关，应该更新已有印象而非创建新的
4. **跳过无意义**：纯粹的客套话（如"好的"、"谢谢"）没有信息量，应该跳过
5. **每话题一条**：即使5条消息讨论同一件事，也只生成一条印象

## 视角示例：
- ❌ 错误："用户想减肥"
- ✅ 正确："用户想减肥但缺乏运动习惯，AI建议从低强度运动开始，并推荐了游泳和跑步的对比分析"

- ❌ 错误："用户对川菜感兴趣"
- ✅ 正确："用户正在学习川菜，已掌握红烧肉，AI推荐了回锅肉、麻婆豆腐等入门菜，并提供了调料准备建议"

## 输出格式（每条印象）：
```json
{
  "decisions": [
    {"id": "<已有印象ID（更新时填）>", "content": "<50-100字，以AI视角描述这段对话的印象>", "action": "<update|create|skip>", "targetId": "<关联的已有印象ID（可选）>"}
  ]
}
```

## 示例：
- 用户："我想减肥" + "目标是三个月" + "没运动过" → 创建："用户想三个月内减肥但无运动习惯，AI建议循序渐进并推荐了跑步和游泳的对比"
- 已有印象："用户对烹饪感兴趣" + 新消息："宫保鸡丁怎么做" → 更新为："用户在学习川菜，已会红烧肉，AI详细介绍了宫保鸡丁的做法和调料准备"
- 用户："好的"（单独一句，无其他信息） → 跳过
```

**测试结果**：
- 输入 3 条相关消息："我想减肥"、"目标是三个月"、"之前没怎么运动过"
- 输出 1 条印象："用户想三个月内减肥但无运动习惯，AI建议了科学减肥指南，包括饮食调整、有氧与力量训练及生活习惯改变。"
- ✅ 合并成功，双向总结正确

---

## 项目架构备忘录

### 队列流程
1. Backend `ChatService.sendMessage()` 调用 `QueueService.enqueueSummaryBatch()`
2. Backend 使用 BullMQ 将 job 加入 `chat-summary-queue`
3. Worker `SummaryProcessor` 从队列消费 job
4. Worker 调用 `QdrantService.processSummaryJob()` 处理

### 消息标记
- `isNew !== false` → 新消息（NEW）
- `isNew === false` → 历史消息（HISTORICAL）
- 注意：当前 `isNew` 标记在 enqueue 时未设置，提示词通过 `[用户]` / `[AI]` 区分角色

### 15 条消息限制
- `queue.service.ts` 中 `messages.slice(-15)` 确保最多发送 15 条消息
- `getRecentMessages` 使用 `order: { createdAt: 'DESC' }` 获取最新消息

---

## 经验教训（写作标准）

每条经验需包含：**背景 → 问题现象 → 原因分析 → 解决方法 → 行动指导**

---

### 经验 1：诊断 Queue 问题必须直接查 Redis，不能只看 PM2 logs

**背景**：
在调试 BullMQ 队列时，发现 Worker 日志显示 "Waiting for jobs..."，但 jobs 迟迟未被处理。

**问题现象**：
- Backend enqueue 成功（日志显示 `[Queue] Enqueued summary job: XX`）
- Worker 日志始终显示 `Waiting for jobs...`，没有任何 `Processing` 输出
- 但 Redis 中确实存在对应的 job 数据

**原因分析**：
PM2 logs 命令输出的是日志文件的最后几行，如果 Worker 在日志写入前就处理完 job，或者日志配置导致某些日志没有写入文件，就会出现"日志看不到但实际已处理"的情况。

**解决方法**：
使用 Redis client 直接查询：
```typescript
node -e "
const Redis = require('ioredis');
const redis = new Redis({ host: 'localhost', port: 6379, password: 'xxx' });
// 检查 job 数据
redis.hgetall('bull:chat-summary-queue:70').then(data => {
  console.log('Job data:', data);
  if (data.data) console.log('Parsed:', JSON.parse(data.data));
});
// 检查已完成 jobs
redis.type('bull:chat-summary-queue:completed').then(t => console.log('Type:', t));
"
```

**行动指导**：
- 遇到 queue 延迟或 Worker 不消费问题时，第一时间查 Redis hash 数据
- 不要依赖 `pm2 logs` 作为唯一诊断依据
- 学会使用 `redis.keys()`, `redis.hgetall()`, `redis.type()` 等命令

---

### 经验 2：BullMQ Job ID 是自增序列，不是业务 ID

**背景**：
在排查 jobs 时，看到 Redis 中有 `bull:chat-summary-queue:69`、`bull:chat-summary-queue:70` 等 key，误以为这些是 userId。

**问题现象**：
查询 job 69 的数据，发现 userId 实际上是 74 而不是 69。

**原因分析**：
BullMQ 内部维护一个自增 ID 计数器（`bull:chat-summary-queue:id`），每次 enqueue 都会递增。Job ID 是队列的内部序列号，与业务数据（userId、batchId）没有对应关系。

**解决方法**：
从 job data 的 `data` 字段中解析出真实的业务数据：
```typescript
const jobData = JSON.parse(hashData.data);
console.log('userId:', jobData.userId);
console.log('batchId:', jobData.batchId);
console.log('messages count:', jobData.messages.length);
```

**行动指导**：
- 看到 Redis 中的数字 ID（69、70、71...）不要误认为是 userId
- 调试时要 `redis.hgetall('bull:chat-summary-queue:XX')` 查看 data 字段
- batchId 的命名格式是 `${userId}_${date}_${timestamp}`，可以从中提取 userId

---

### 经验 3：Redis Key 前缀必须 Backend/Worker 两端一致

**背景**：
Backend 使用 `bull:` 前缀写入队列，但 Worker 使用 `bullmq:` 前缀（默认），导致 Worker 无法读取到 jobs。

**问题现象**：
- Redis 中有 70+ 条 `bull:chat-summary-queue:*` keys
- `redis.keys('bullmq:chat-summary-queue:*')` 返回空
- Worker 启动后什么都不做，一直 Waiting

**原因分析**：
BullMQ 4.x 默认使用 `bullmq:` 前缀，但某些旧版本或特定配置使用 `bull:` 前缀。Backend 和 Worker 是两个独立进程，如果它们的 BullModule 配置不一致，就会出现"一个写一个读不通"的问题。

**解决方法**：
在 Backend 和 Worker 的 `BullModule.forRootAsync` 中都显式指定相同的 prefix：
```typescript
useFactory: (configService: ConfigService) => ({
  connection: { host, port, password },
  prefix: 'bull', // 必须与 Redis 中已有 keys 的前缀一致
}),
```

**行动指导**：
- 任何涉及多个进程/模块共享资源的配置，必须确保完全一致
- 优先适配已有数据（保持 `bull:` 前缀），而不是清空 Redis
- 修改配置后必须同时重启 Backend 和 Worker

---

### 经验 4：Job 处理完成但 Worker 日志缺失的排查方法

**背景**：
Job 70 已经被 Redis 标记为 `processedOn` 和 `finishedOn`，说明 Worker 确实处理过，但 PM2 logs 中没有任何相关记录。

**问题现象**：
Worker 重启后，日志从头开始，且只显示最新的 15-20 行。历史处理记录被覆盖。

**原因分析**：
- PM2 logs 默认只显示最后 N 行，不是完整日志
- Worker 处理 job 时可能没有写入足够的诊断日志
- NestJS 的日志 buffer 机制可能导致某些日志没有及时刷新

**解决方法**：
1. 查询 Redis job hash 的 `processedOn` 和 `finishedOn` 字段判断是否已处理
2. 查询 `bull:chat-summary-queue:completed` zset 确认 job 已在完成列表
3. 检查 job 的 `returnvalue` 字段查看处理结果

**行动指导**：
- 在 Processor 的关键步骤添加日志（收到 job、处理中、完成）
- 使用 `console.log` 而不只是 `this.logger` 便于快速调试
- 保留足够的 pm2 logs 行数：`pm2 logs chat-worker --lines 100`

---

### 经验 5：调试时优先验证问题是否存在，再修改代码

**背景**：
多次遇到"修改配置后问题依旧"的情况，花了大量时间排查，却发现问题根本不存在或已经被修复。

**问题现象**：
- 修改了 BullMQ prefix 配置后，仍然看不到 Worker 处理 jobs
- 实际上 Worker 已经在处理了，只是日志没显示

**原因分析**：
- 在修改-测试循环中，没有先确认问题是否仍然存在
- 没有使用独立的验证手段（Redis 查询）而依赖了不完整的信息（PM2 logs）

**解决方法**：
先独立验证问题状态：
```bash
# 1. 先查 Redis 确认问题状态
node -e "const Redis = require('ioredis'); const r = new Redis({...}); r.keys('bull:chat-summary-queue:*').then(k => console.log('Jobs in Redis:', k.length));"

# 2. 如果 Redis 有数据但 Worker 没处理，才是配置问题
# 3. 如果 Redis 没数据，说明 Backend 根本没 enqueue，是业务逻辑问题
```

**行动指导**：
- 遇到问题先独立诊断，不要假设问题原因
- 用 Redis 直接验证，比修改代码后重启服务更快定位问题
- 记录每次诊断的发现，避免重复排查同一个已知的点
