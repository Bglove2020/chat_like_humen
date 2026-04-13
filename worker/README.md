# Worker

NestJS worker for memory summary and fact/profile extraction.

## What It Needs

- `common_core` internal API
- Redis for BullMQ
- shared Qdrant
- DashScope API key

Worker does not connect to MySQL directly.

## Environments

- Test: use `.env.development`
- Production: use `.env.production`

Qdrant is shared by both environments:

- test collections: `user_impressions_dev`, `user_profile_memories_dev`
- production collections: `user_impressions`, `user_profile_memories`

## Start

```bash
npm install
npm run build
npm run start:test
npm run start:prod
```

If worker and `common_core` are not on the same machine, update `BACKEND_INTERNAL_URL`.
If Qdrant is not local to the worker host, update `QDRANT_URL` in both env files.
