export default () => ({
  port: parseInt(process.env.PORT || '7001', 10),
  host: process.env.HOST || '0.0.0.0',

  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agent_db',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-jwt-secret',
    expiresIn: '7d',
  },

  dify: {
    apiKey: process.env.DIFY_API_KEY || '',
    apiUrl: process.env.DIFY_API_URL || 'http://47.107.85.114/v1/chat-messages',
    timeoutMs: parseInt(process.env.DIFY_TIMEOUT_MS || '60000', 10),
  },

  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    collectionName: process.env.QDRANT_COLLECTION_NAME || 'user_impressions',
  },

  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    embeddingUrl:
      process.env.DASHSCOPE_EMBEDDING_URL ||
      'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
    embeddingModel: process.env.DASHSCOPE_EMBEDDING_MODEL || 'text-embedding-v3',
    embeddingDim: parseInt(process.env.EMBEDDING_DIM || '1024', 10),
  },
});
