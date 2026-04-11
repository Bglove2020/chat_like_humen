# CLAUDE.md

先看 `AGENTS.md`。

如果本文件与 `AGENTS.md` 冲突，以 `AGENTS.md` 为准。

常用命令：

```bash
docker-compose up -d
docker-compose -f docker-compose.dev.yml up -d
cd backend && npm run start:dev
cd worker && npm run start:dev
cd frontend && npm run dev
pm2 start ecosystem.config.cjs
```
