# Worker

独立的 NestJS Worker，负责：

- 消费 `chat-summary-queue`
- 对同一用户任务加 Redis 锁串行处理
- 调用 DashScope Qwen 生成会话印象
- 将印象 embedding 后写入 Qdrant

## 启动

```bash
npm install
npm run start:dev
```

## 构建

```bash
npm run build
```

## 关键模块

- `src/processor/summary.processor.ts`: BullMQ 消费与用户级锁
- `src/services/dashscope.service.ts`: Qwen 与 embedding 调用
- `src/services/qdrant.service.ts`: 印象查询、创建、更新

## 必须保持的行为

- 后端的 flush 规则不变：`10 条消息` 或 `2 分钟`
- Worker 继续消费批量消息并生成印象摘要
- 摘要结果必须写入 Qdrant

## 环境变量

复制 `worker/.env.example` 到 `worker/.env` 后按需修改。
