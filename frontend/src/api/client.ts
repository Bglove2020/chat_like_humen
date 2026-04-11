import axios from 'axios';
import { useAuthStore } from '../stores/auth';

const baseURL = import.meta.env.VITE_API_BASE_URL || '/';

export const client = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authApi = {
  register: (username: string, password: string) =>
    client.post('/register', { username, password }),
  login: (username: string, password: string) =>
    client.post('/login', { username, password }),
};

export const chatApi = {
  listSessions: () => client.get('/chat-sessions'),
  createSession: (title?: string) => client.post('/chat-sessions', title ? { title } : {}),
  getMessages: (sessionId: string) => client.get(`/chat-sessions/${sessionId}/messages`),
  deleteSession: (sessionId: string) => client.delete(`/chat-sessions/${sessionId}`),
  sendMessage: (message: string, sessionId?: string) =>
    client.post('/chat', { message, sessionId }),
};

export const memoryCompareApi = {
  search: (userId: number, query: string, limit = 6) =>
    client.post('/memory-compare/search', { userId, query, limit }),
};
