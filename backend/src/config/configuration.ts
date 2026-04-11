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
    profileCollectionName: process.env.QDRANT_PROFILE_COLLECTION_NAME || 'user_profile_memories',
  },

  mem0: {
    enabled: process.env.MEM0_ENABLED === 'true',
    apiUrl: process.env.MEM0_API_URL || 'http://127.0.0.1:8000',
    apiKey: process.env.MEM0_API_KEY || '',
    autoConfigure: process.env.MEM0_AUTO_CONFIGURE === 'true',
    qdrantUrl: process.env.MEM0_QDRANT_URL || process.env.QDRANT_URL || 'http://localhost:6333',
    qdrantCollection: process.env.MEM0_QDRANT_COLLECTION || 'mem0_user_memories',
    graphEnabled: process.env.MEM0_GRAPH_ENABLED === 'true',
    llmProvider: process.env.MEM0_LLM_PROVIDER || 'openai',
    llmApiKey: process.env.MEM0_LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    llmModel: process.env.MEM0_LLM_MODEL || 'gpt-4.1-nano-2025-04-14',
    llmBaseUrl: process.env.MEM0_LLM_BASE_URL || '',
    embedderProvider: process.env.MEM0_EMBEDDER_PROVIDER || 'openai',
    embedderApiKey: process.env.MEM0_EMBEDDER_API_KEY || process.env.OPENAI_API_KEY || '',
    embedderModel: process.env.MEM0_EMBEDDER_MODEL || 'text-embedding-3-small',
    embedderBaseUrl: process.env.MEM0_EMBEDDER_BASE_URL || '',
    historyDbPath: process.env.MEM0_HISTORY_DB_PATH || '/app/history/history.db',
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
