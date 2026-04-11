# Backend

NestJS 后端，负责：

- 用户注册与登录
- JWT 鉴权
- 调用 Dify 生成聊天回复
- 聊天消息持久化到 MySQL
- 按 `10 条消息` 或 `2 分钟静默` 的规则批量入队

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

- `src/auth`: 注册、登录、JWT
- `src/chat`: 聊天接口、消息存储、flush 逻辑
- `src/queue`: BullMQ 生产者
- `src/impressions`: Qdrant 检索与记忆列表接口

## 重要行为约束

- 不直接逐条入队
- 维持 `10 条消息` 或 `2 分钟无新消息` 才 flush
- flush 时最多携带最近 `15` 条消息上下文

## 环境变量

复制 `backend/.env.example` 到 `backend/.env` 后按需修改。
