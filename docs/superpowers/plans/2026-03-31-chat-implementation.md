# Chat Like Human Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal chatbot with AI chat via Dify, user auth (JWT), and async impression generation via Worker + BullMQ + Qdrant.

**Architecture:** Three-process architecture: (1) React frontend with Vite, (2) MidwayJS API backend handling auth/chat/retrieve, (3) Independent Worker process consuming BullMQ batches and generating impressions stored in Qdrant. Dify handles original chat storage and AI responses.

**Tech Stack:** Vite + React (frontend), MidwayJS (backend), Dify Workflow API (AI chat), MySQL (users), Redis + BullMQ (queue), Qdrant (impression vectors), Qwen via DashScope (summary generation).

---

## File Structure

```
/root/chat_like_human/
├── frontend/                         # Vite + React
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   └── Chat.tsx
│   │   ├── api/
│   │   │   └── client.ts
│   │   └── stores/
│   │       └── auth.ts
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── backend/                         # MidwayJS
│   ├── src/
│   │   ├── controller/
│   │   │   ├── auth.ts
│   │   │   ├── chat.ts
│   │   │   └── retrieve.ts
│   │   ├── service/
│   │   │   ├── userService.ts
│   │   │   ├── chatService.ts
│   │   │   ├── queueService.ts
│   │   │   └── impressionService.ts
│   │   ├── entity/
│   │   │   └── user.ts
│   │   ├── queue/
│   │   │   └── summaryProducer.ts
│   │   ├── middleware/
│   │   │   └── auth.ts
│   │   ├── config/
│   │   │   └── index.ts
│   │   └── app.ts
│   ├── package.json
│   ├── midway.config.ts
│   └── tsconfig.json
├── worker/                           # Independent process
│   ├── src/
│   │   ├── summaryWorker.ts
│   │   ├── processor.ts
│   │   └── qwenClient.ts
│   ├── package.json
│   └── tsconfig.json
├── docs/
│   ├── specs/
│   │   └── 2026-03-31-chat-design.md
│   └── plans/
│       └── 2026-03-31-chat-implementation.md
├── docker-compose.yml
└── README.md
```

---

## Task 1: Project Scaffold - Frontend (Vite + React)

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`

- [ ] **Step 1: Create frontend directory and package.json**

```bash
mkdir -p /root/chat_like_human/frontend/src/pages /root/chat_like_human/frontend/src/api /root/chat_like_human/frontend/src/stores
```

Create `frontend/package.json`:
```json
{
  "name": "chat-like-human-frontend",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.20.0",
    "zustand": "^4.4.7",
    "axios": "^1.6.2"
  },
  "devDependencies": {
    "@types/react": "^18.2.43",
    "@types/react-dom": "^18.2.17",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.3.2",
    "vite": "^5.0.8"
  }
}
```

- [ ] **Step 2: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:7001',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 4: Create index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Chat Like Human</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create main.tsx**

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 6: Create App.tsx with routing**

```typescript
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Chat from './pages/Chat';
import { useAuthStore } from './stores/auth';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.token);
  if (!isLoggedIn) return <Navigate to="/login" />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/chat"
          element={
            <ProtectedRoute>
              <Chat />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/chat" />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 7: Create auth store with zustand**

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  username: string | null;
  setAuth: (token: string, username: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      username: null,
      setAuth: (token, username) => set({ token, username }),
      logout: () => set({ token: null, username: null }),
    }),
    { name: 'auth-storage' }
  )
);
```

- [ ] **Step 8: Create API client**

```typescript
import axios from 'axios';
import { useAuthStore } from '../stores/auth';

const client = axios.create({ baseURL: '/api' });

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const authApi = {
  register: (username: string, password: string) =>
    client.post('/register', { username, password }),
  login: (username: string, password: string) =>
    client.post('/login', { username, password }),
};

export const chatApi = {
  sendMessage: (message: string) =>
    client.post('/chat', { message }, { responseType: 'stream' }),
};

export default client;
```

- [ ] **Step 9: Create Login page**

```typescript
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/client';
import { useAuthStore } from '../stores/auth';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await authApi.login(username, password);
      setAuth(res.data.token, username);
      navigate('/chat');
    } catch {
      setError('登录失败');
    }
  };

  const handleRegister = async () => {
    try {
      await authApi.register(username, password);
      const res = await authApi.login(username, password);
      setAuth(res.data.token, username);
      navigate('/chat');
    } catch {
      setError('注册失败');
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h1>登录</h1>
      <form onSubmit={handleSubmit}>
        <input
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit">登录</button>
        <button type="button" onClick={handleRegister}>注册</button>
      </form>
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 10: Create Chat page with streaming**

```typescript
import { useState, useRef, useEffect } from 'react';
import { chatApi } from '../api/client';
import { useAuthStore } from '../stores/auth';

export default function Chat() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const username = useAuthStore((s) => s.username);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMessage = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const response = await chatApi.sendMessage(userMessage);
      const reader = response.data.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = '';

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        assistantMessage += chunk;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: assistantMessage };
          return updated;
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '1rem' }}>
      <div style={{ marginBottom: '1rem' }}>
        <span>当前用户: {username}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ccc', padding: '1rem' }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: '0.5rem' }}>
            <strong>{msg.role === 'user' ? '我' : 'AI'}: </strong>
            <span>{msg.content}</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div style={{ marginTop: '1rem', display: 'flex' }}>
        <input
          style={{ flex: 1, marginRight: '0.5rem' }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="输入消息..."
        />
        <button onClick={handleSend} disabled={loading}>
          {loading ? '发送中...' : '发送'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 11: Install dependencies and verify frontend**

```bash
cd /root/chat_like_human/frontend && npm install
npm run dev &
sleep 3
curl -s http://localhost:3000 | head -20
```

---

## Task 2: Project Scaffold - Backend (MidwayJS)

**Files:**
- Create: `backend/package.json`
- Create: `backend/midway.config.ts`
- Create: `backend/tsconfig.json`
- Create: `backend/src/app.ts`

- [ ] **Step 1: Create backend directory structure**

```bash
mkdir -p /root/chat_like_human/backend/src/{controller,service,entity,middleware,queue,config}
```

- [ ] **Step 2: Create backend/package.json**

```json
{
  "name": "chat-like-human-backend",
  "version": "1.0.0",
  "scripts": {
    "dev": "midway-bin dev",
    "build": "midway-bin build",
    "start": "node dist/app.js"
  },
  "dependencies": {
    "@midwayjs/core": "^3.13.0",
    "@midwayjs/koa": "^3.13.0",
    "@midwayjs/redis": "^3.13.0",
    "@midwayjs/typeorm": "^3.13.0",
    "bullmq": "^5.1.0",
    "mysql2": "^3.6.5",
    "bcrypt": "^5.1.1",
    "jsonwebtoken": "^9.0.2",
    "axios": "^1.6.2",
    "typeorm": "^0.3.17"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/jsonwebtoken": "^9.0.5",
    "@types/node": "^20.10.4",
    "typescript": "^5.3.2"
  }
}
```

- [ ] **Step 3: Create midway.config.ts**

```typescript
import { MidwayConfig } from '@midwayjs/core';

export default {
  koa: { port: 7001 },
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'zxr120713.',
  },
  typeorm: {
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    username: 'root',
    password: 'zxr120713.',
    database: 'agent_db',
    synchronize: true,
    logging: false,
  },
} as MidwayConfig;
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: Create src/app.ts**

```typescript
import { createApp, IMidwayApplication } from '@midwayjs/core';
import { IlikeApplication } from '@midwayjs/koa';

async function main() {
  const app: IMidwayApplication = await createApp();
  await app.run();
  console.log('Server started at http://localhost:7001');
}

main();
```

---

## Task 3: MySQL User Entity and User Service

**Files:**
- Create: `backend/src/entity/user.ts`
- Create: `backend/src/service/userService.ts`

- [ ] **Step 1: Create user entity**

```typescript
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 50, unique: true })
  username: string;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 2: Create user service**

```typescript
import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../entity/user';

const JWT_SECRET = process.env.JWT_SECRET || 'chat-like-human-secret-key';

@Provide()
export class UserService {
  @InjectEntityModel(User)
  userModel: Repository<User>;

  async register(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    const existing = await this.userModel.findOne({ where: { username } });
    if (existing) {
      return { success: false, error: '用户名已存在' };
    }
    const hashed = await bcrypt.hash(password, 10);
    const user = this.userModel.create({ username, password: hashed });
    await this.userModel.save(user);
    return { success: true };
  }

  async login(username: string, password: string): Promise<{ success: boolean; token?: string; error?: string }> {
    const user = await this.userModel.findOne({ where: { username } });
    if (!user) {
      return { success: false, error: '认证失败' };
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return { success: false, error: '认证失败' };
    }
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    return { success: true, token };
  }
}
```

---

## Task 4: Auth Controller and Middleware

**Files:**
- Create: `backend/src/middleware/auth.ts`
- Create: `backend/src/controller/auth.ts`

- [ ] **Step 1: Create auth middleware**

```typescript
import { Provide, Middleware } from '@midwayjs/core';
import { NextFunction } from 'koa';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'chat-like-human-secret-key';

@Middleware()
export class AuthMiddleware {
  resolve() {
    return async (ctx: any, next: NextFunction) => {
      const auth = ctx.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        ctx.status = 401;
        ctx.body = { error: '未授权' };
        return;
      }
      const token = auth.slice(7);
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; username: string };
        ctx.state.user = decoded;
        await next();
      } catch {
        ctx.status = 401;
        ctx.body = { error: 'token无效' };
      }
    };
  }
}
```

- [ ] **Step 2: Create auth controller**

```typescript
import { Controller, Post, Body } from '@midwayjs/core';
import { UserService } from '../service/userService';

@Controller('/api')
export class AuthController {
  @Inject()
  userService: UserService;

  @Post('/register')
  async register(@Body() body: { username: string; password: string }) {
    const { username, password } = body;
    if (!username || !password) {
      return { error: '用户名和密码必填' };
    }
    return this.userService.register(username, password);
  }

  @Post('/login')
  async login(@Body() body: { username: string; password: string }) {
    const { username, password } = body;
    if (!username || !password) {
      return { error: '用户名和密码必填' };
    }
    return this.userService.login(username, password);
  }
}
```

---

## Task 5: Chat Service and Dify Integration

**Files:**
- Create: `backend/src/service/chatService.ts`
- Create: `backend/src/controller/chat.ts`

- [ ] **Step 1: Create chat service with debounce and message batching**

```typescript
import { Provide, Inject } from '@midwayjs/core';
import axios from 'axios';
import { QueueService } from './queueService';

const DIFY_API_KEY = process.env.DIFY_API_KEY || 'app-xxxxx';
const DIFY_API_URL = process.env.DIFY_API_URL || 'https://api.dify.ai/v1/chat-messages';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface UserSession {
  messages: ChatMessage[];
  debounceTimer: NodeJS.Timeout | null;
}

@Provide()
export class ChatService {
  @Inject()
  queueService: QueueService;

  private sessions: Map<number, UserSession> = new Map();

  private getSession(userId: number): UserSession {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, { messages: [], debounceTimer: null });
    }
    return this.sessions.get(userId)!;
  }

  async sendMessage(userId: number, message: string): Promise<AsyncIterable<string>> {
    const session = this.getSession(userId);

    const userMsg: ChatMessage = {
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMsg);

    const response = await this.callDify(userId, message);
    return this.streamDifyResponse(userId, response);
  }

  private async callDify(userId: number, message: string): Promise<any> {
    const session = this.getSession(userId);
    const response = await axios.post(
      DIFY_API_URL,
      {
        query: message,
        user: `user_${userId}`,
        response_mode: 'blocking',
      },
      {
        headers: {
          Authorization: `Bearer ${DIFY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
    return response.data;
  }

  private async *streamDifyResponse(userId: number, response: any): AsyncIterable<string> {
    const session = this.getSession(userId);

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: response.answer || '',
      timestamp: new Date().toISOString(),
    };
    session.messages.push(assistantMsg);

    yield response.answer || '';

    this.scheduleBatch(userId);
  }

  private scheduleBatch(userId: number) {
    const session = this.getSession(userId);

    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
    }

    session.debounceTimer = setTimeout(async () => {
      if (session.messages.length > 0) {
        await this.queueService.enqueueSummaryBatch(userId, session.messages);
        session.messages = [];
      }
    }, 5000);
  }

  flushSession(userId: number) {
    const session = this.getSession(userId);
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = null;
    }
    if (session.messages.length > 0) {
      this.queueService.enqueueSummaryBatch(userId, session.messages);
      session.messages = [];
    }
  }
}
```

- [ ] **Step 2: Create chat controller with streaming**

```typescript
import { Controller, Post, Body, Headers, ReadBody } from '@midwayjs/core';
import { ChatService } from '../service/chatService';
import { AuthMiddleware } from '../middleware/auth';

@Controller('/api')
export class ChatController {
  @Inject()
  chatService: ChatService;

  @Post('/chat')
  @Use(AuthMiddleware)
  async chat(
    @Body('message') message: string,
    @Headers('authorization') auth: string
  ) {
    const token = auth.slice(7);
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'chat-like-human-secret-key';
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
    const userId = decoded.userId;

    const stream = await this.chatService.sendMessage(userId, message);

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return { reply: chunks.join('') };
  }
}
```

---

## Task 6: BullMQ Queue Service

**Files:**
- Create: `backend/src/service/queueService.ts`
- Create: `backend/src/queue/summaryProducer.ts`

- [ ] **Step 1: Create queue service**

```typescript
import { Provide, Inject, Singleton } from '@midwayjs/core';
import { Redis } from '@midwayjs/redis';
import { Queue } from 'bullmq';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

@Provide()
@Singleton()
export class QueueService {
  @Inject()
  redis: Redis;

  private queue: Queue;

  async onContainerInit() {
    const connection = {
      host: 'localhost',
      port: 6379,
      password: 'zxr120713.',
    };
    this.queue = new Queue('chat-summary-queue', { connection });
  }

  async enqueueSummaryBatch(userId: number, messages: ChatMessage[]) {
    const today = new Date().toISOString().split('T')[0];
    const batchId = `${userId}_${today}_${Date.now()}`;

    const job = await this.queue.add('summary', {
      userId,
      date: today,
      batchId,
      messages: messages.slice(-15),
    });

    console.log(`Enqueued summary job ${job.id} for user ${userId}`);
  }
}
```

---

## Task 7: Qdrant Retrieve Service

**Files:**
- Create: `backend/src/service/impressionService.ts`
- Create: `backend/src/controller/retrieve.ts`

- [ ] **Step 1: Create impression service for Qdrant**

```typescript
import { Provide, Inject } from '@midwayjs/core';
import axios from 'axios';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = 'user_impressions';

interface Impression {
  id: string;
  userId: number;
  date: string;
  summaryText: string;
  createdAt: string;
}

@Provide()
export class ImpressionService {
  async search(query: string, userId?: number, limit: number = 5): Promise<{ content: string; score: number }[]> {
    const embedding = await this.getEmbedding(query);

    const filter = userId ? { must: [{ key: 'userId', match: { value: userId } }] } : undefined;

    const response = await axios.post(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
      vector: embedding,
      limit,
      filter,
      with_payload: true,
    });

    return (response.data.result || []).map((point: any) => ({
      content: point.payload.summaryText,
      score: point.score,
    }));
  }

  async upsertImpression(impression: Impression): Promise<void> {
    const embedding = await this.getEmbedding(impression.summaryText);

    await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/${impression.id}`, {
      vector: embedding,
      payload: {
        userId: impression.userId,
        date: impression.date,
        summaryText: impression.summaryText,
        createdAt: impression.createdAt,
      },
    });
  }

  async getTodayImpressions(userId: number, date: string): Promise<Impression[]> {
    const filter = {
      must: [
        { key: 'userId', match: { value: userId } },
        { key: 'date', match: { value: date } },
      ],
    };

    const response = await axios.post(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
      vector: new Array(1536).fill(0),
      limit: 100,
      filter,
      with_payload: true,
    });

    return (response.data.result || []).map((point: any) => ({
      id: point.id,
      userId: point.payload.userId,
      date: point.payload.date,
      summaryText: point.payload.summaryText,
      createdAt: point.payload.createdAt,
    }));
  }

  async ensureCollection(): Promise<void> {
    try {
      await axios.get(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
    } catch {
      await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
        vectors: { size: 1536, distance: 'Cosine' },
      });
    }
  }

  private async getEmbedding(text: string): Promise<number[]> {
    const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'your-api-key';
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
      {
        model: 'text-embedding-v3',
        input: { text },
      },
      {
        headers: {
          Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data.data.embedding;
  }
}
```

- [ ] **Step 2: Create retrieve controller (for Dify HTTP node)**

```typescript
import { Controller, Post, Body } from '@midwayjs/core';
import { ImpressionService } from '../service/impressionService';
import { AuthMiddleware } from '../middleware/auth';

@Controller('/api')
export class RetrieveController {
  @Inject()
  impressionService: ImpressionService;

  @Post('/retrieve')
  async retrieve(@Body('query') query: string) {
    if (!query) {
      return [];
    }
    return this.impressionService.search(query, undefined, 5);
  }
}
```

---

## Task 8: Worker Process

**Files:**
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/src/qwenClient.ts`
- Create: `worker/src/processor.ts`
- Create: `worker/src/summaryWorker.ts`

- [ ] **Step 1: Create worker package.json**

```json
{
  "name": "chat-like-human-worker",
  "version": "1.0.0",
  "scripts": {
    "dev": "ts-node src/summaryWorker.ts",
    "start": "node dist/summaryWorker.js"
  },
  "dependencies": {
    "bullmq": "^5.1.0",
    "axios": "^1.6.2",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.10.4",
    "@types/uuid": "^9.0.7",
    "typescript": "^5.3.2",
    "ts-node": "^10.9.2"
  }
}
```

- [ ] **Step 2: Create worker tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create Qwen client for DashScope API**

```typescript
import axios from 'axios';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'your-api-key';

interface ImpressionDecision {
  id: string;
  content: string;
  action: 'update' | 'create';
}

export async function callQwenForImpressions(
  existingImpressions: { id: string; content: string; createdAt: string }[],
  newMessages: { role: string; content: string; timestamp: string }[]
): Promise<ImpressionDecision[]> {
  const impressionsText = existingImpressions
    .map((imp, idx) => `  印象${idx + 1} [${imp.createdAt}]: "${imp.content}"`)
    .join('\n');

  const messagesText = newMessages
    .map((m) => `  [${m.role}] ${m.timestamp}: ${m.content}`)
    .join('\n');

  const prompt = `你是Dify AI Agent的记忆整理助手。

## 任务
根据新消息和已有印象，判断每条新消息应该合并到哪个印象，或者需要新建印象。

## 印象列表（当前已有的印象，按时间倒序）
现有印象数量：${existingImpressions.length}
${impressionsText || '（无现有印象）'}

## 今日消息（用于生成新印象或更新已有印象）
${messagesText}

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
}`;

  const response = await axios.post(
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    {
      model: 'qwen-max',
      input: { prompt },
      parameters: { temperature: 0.7, max_tokens: 2000 },
    },
    {
      headers: {
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const text = response.data.output.text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse LLM response');
  }
  return JSON.parse(jsonMatch[0]).impressions;
}
```

- [ ] **Step 4: Create processor for handling summary jobs**

```typescript
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { callQwenForImpressions } from './qwenClient';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = 'user_impressions';

interface ChatMessage {
  role: string;
  content: string;
  timestamp: string;
}

interface JobData {
  userId: number;
  date: string;
  batchId: string;
  messages: ChatMessage[];
}

export async function processSummaryJob(job: JobData): Promise<void> {
  console.log(`Processing summary job ${job.batchId} for user ${job.userId}`);

  const existingImpressions = await getTodayImpressions(job.userId, job.date);

  const decisions = await callQwenForImpressions(existingImpressions, job.messages);

  for (const impression of decisions) {
    const impressionId = impression.action === 'create'
      ? `${job.userId}_${job.date}_${uuidv4()}`
      : impression.id;

    const embedding = await getEmbedding(impression.content);

    await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/${impressionId}`, {
      vector: embedding,
      payload: {
        userId: job.userId,
        date: job.date,
        summaryText: impression.content,
        createdAt: new Date().toISOString(),
      },
    });

    console.log(`${impression.action === 'create' ? 'Created' : 'Updated'} impression ${impressionId}`);
  }

  console.log(`Completed summary job ${job.batchId}`);
}

async function getTodayImpressions(userId: number, date: string): Promise<{ id: string; content: string; createdAt: string }[]> {
  const filter = {
    must: [
      { key: 'userId', match: { value: userId } },
      { key: 'date', match: { value: date } },
    ],
  };

  const response = await axios.post(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
    vector: new Array(1536).fill(0),
    limit: 100,
    filter,
    with_payload: true,
  });

  return (response.data.result || []).map((point: any) => ({
    id: point.id,
    content: point.payload.summaryText,
    createdAt: point.payload.createdAt,
  }));
}

async function getEmbedding(text: string): Promise<number[]> {
  const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'your-api-key';
  const response = await axios.post(
    'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
    {
      model: 'text-embedding-v3',
      input: { text },
    },
    {
      headers: {
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data.data.embedding;
}
```

- [ ] **Step 5: Create main worker entry point**

```typescript
import { Worker } from 'bullmq';
import { processSummaryJob } from './processor';

const connection = {
  host: 'localhost',
  port: 6379,
  password: 'zxr120713.',
};

const worker = new Worker(
  'chat-summary-queue',
  async (job) => {
    console.log(`Received job ${job.id}: ${JSON.stringify(job.data)}`);
    await processSummaryJob(job.data);
  },
  { connection, concurrency: 5 }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

console.log('Summary worker started, waiting for jobs...');
```

---

## Task 9: Docker Compose Update and Environment Setup

**Files:**
- Modify: `docker-compose.yml`
- Create: `README.md`

- [ ] **Step 1: Ensure docker-compose is up to date**

The existing docker-compose.yml already has qdrant, redis, and mysql. Verify they're running:

```bash
cd /root/chat_like_human && docker-compose up -d
docker-compose ps
```

- [ ] **Step 2: Create .env.example**

```bash
cat > /root/chat_like_human/.env.example << 'EOF'
# Backend
JWT_SECRET=your-jwt-secret-key
DIFY_API_KEY=your-dify-api-key
DIFY_API_URL=https://api.dify.ai/v1/chat-messages
DASHSCOPE_API_KEY=your-dashscope-api-key

# Qdrant
QDRANT_URL=http://localhost:6333

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=zxr120713.

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_PASSWORD=zxr120713.
MYSQL_DATABASE=agent_db
EOF
```

---

## Task 10: Integration Verification

**Files:**
- Create: `backend/src/controller/chat.ts` (streaming version)
- Verify all components work together

- [ ] **Step 1: Update chat controller for proper streaming**

The previous ChatController used a blocking approach. For true streaming with Dify:

```typescript
import { Controller, Post, Body, Headers } from '@midwayjs/core';
import { ChatService } from '../service/chatService';
import { AuthMiddleware } from '../middleware/auth';
import { Context } from 'koa';
import { UseMiddleware } from '@midwayjs/core';

@Controller('/api')
export class ChatController {
  @Inject()
  chatService: ChatService;

  @Post('/chat')
  @Use(AuthMiddleware)
  async chat(
    @Body('message') message: string,
    @Headers('authorization') auth: string,
    ctx: Context
  ) {
    const token = auth.slice(7);
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'chat-like-human-secret-key';
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
    const userId = decoded.userId;

    ctx.set('Content-Type', 'text/plain');
    ctx.set('Transfer-Encoding', 'chunked');

    const stream = await this.chatService.sendMessage(userId, message);
    ctx.body = stream;
  }
}
```

- [ ] **Step 2: Test end-to-end flow**

```bash
# Start backend
cd /root/chat_like_human/backend && npm install && npm run dev &

# Start worker
cd /root/chat_like_human/worker && npm install &

# Test register
curl -X POST http://localhost:7001/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}'

# Test login
curl -X POST http://localhost:7001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}'
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Frontend (Vite + React) - Task 1
- [x] Backend (MidwayJS) - Task 2
- [x] MySQL user table with TypeORM - Task 3
- [x] /api/register interface - Task 4
- [x] /api/login interface (JWT) - Task 4
- [x] /api/chat interface (Dify) - Task 5
- [x] /api/retrieve interface (Qdrant) - Task 7
- [x] BullMQ queue producer - Task 6
- [x] 5s debounce mechanism - Task 5
- [x] 15 message batching - Task 6
- [x] Worker independent process - Task 8
- [x] Qwen API call (DashScope) - Task 8
- [x] Qdrant impression storage - Task 7

**2. Placeholder scan:**
- All environment variables have defaults but should be set via .env
- DIFY_API_KEY placeholder noted
- DASHSCOPE_API_KEY placeholder noted

**3. Type consistency:**
- ChatMessage interface defined in both chatService and queueService - consider consolidating
- Impression interface defined in impressionService
- JobData interface defined in processor

**Gaps found:** None significant.

---

## Plan Complete

**Saved to:** `docs/superpowers/plans/2026-03-31-chat-implementation.md`

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
