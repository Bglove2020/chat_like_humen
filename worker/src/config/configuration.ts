export default () => ({
  backend: {
    internalUrl: process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:7001',
    internalApiKey: process.env.BACKEND_INTERNAL_API_KEY || '1234567890',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || '',
  },

  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    collectionName: process.env.QDRANT_COLLECTION_NAME || 'user_impressions',
    profileCollectionName: process.env.QDRANT_PROFILE_COLLECTION_NAME || 'user_profile_memories',
  },

  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    embeddingUrl:
      process.env.DASHSCOPE_EMBEDDING_URL ||
      'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
    embeddingModel: process.env.DASHSCOPE_EMBEDDING_MODEL || 'text-embedding-v3',
    embeddingDim: parseInt(process.env.EMBEDDING_DIM || '1024', 10),
    qwenUrl:
      process.env.DASHSCOPE_QWEN_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    qwenModel: process.env.DASHSCOPE_QWEN_MODEL || 'qwen3.6-plus',
    enableThinking: process.env.DASHSCOPE_ENABLE_THINKING,
  },

  worker: {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
    queueName: process.env.QUEUE_NAME || 'chat-summary-queue',
  },
});
