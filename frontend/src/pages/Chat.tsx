import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { chatApi } from '../api/client';

const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isError?: boolean;
}

interface ChatSessionSummary {
  id: string;
  title: string;
  difyConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

function LogoutIcon() {
  return (
    <svg
      className="logout-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      className="chat-send-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function MirrorIcon() {
  return (
    <svg
      className="chat-empty-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg
      className="memory-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12c0 1.2-4.03 6-9 6s-9-4.8-9-6c0-1.2 4.03-6 9-6s9 4.8 9 6" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function Chat() {
  const [activeSession, setActiveSession] = useState<ChatSessionSummary | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuthStore();

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }

    void initializeChat();
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeSessionId]);

  const initializeChat = async () => {
    setLoadingSession(true);

    try {
      const response = await chatApi.createSession();
      const session = response.data as ChatSessionSummary;
      setActiveSession(session);
      setActiveSessionId(session.id);
      await loadMessages(session.id);
    } finally {
      setLoadingSession(false);
    }
  };

  const loadMessages = async (sessionId: string) => {
    setLoadingMessages(true);
    try {
      const response = await chatApi.getMessages(sessionId);
      const nextMessages: Message[] = (response.data.messages || []).map((message: any) => ({
        id: String(message.id),
        role: message.role,
        content: message.content,
        timestamp: new Date(message.timestamp),
      }));
      setMessages(nextMessages);
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const syncSessionSummary = (sessionId: string, title: string) => {
    setActiveSession((prev) => {
      const base = prev?.id === sessionId
        ? prev
        : {
          id: sessionId,
          title,
          difyConversationId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

      return {
        ...base,
        title,
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || streaming || !activeSessionId) return;

    const messageText = input.trim();
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: messageText,
      timestamp: new Date(),
    };

    const assistantMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput('');
    setStreaming(true);

    try {
      const response = await chatApi.sendMessage(messageText);
      const reply = response.data.reply || '';
      const sessionId = response.data.sessionId || activeSessionId;
      const title = response.data.title || activeSession?.title || 'New Chat';

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessage.id
            ? { ...msg, content: reply }
            : msg,
        ),
      );

      syncSessionSummary(sessionId, title);
      setActiveSessionId(sessionId);
    } catch {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessage.id
            ? { ...msg, content: 'Sorry, something went wrong.', isError: true }
            : msg,
        ),
      );
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="chat-page">
      <div className="mirror-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
        <div className="orb orb-4" />
      </div>

      <header className="chat-header">
        <h1 className="chat-header-title">CHAT LIKE HUMAN</h1>
        <div className="header-actions">
          <button className="memory-button" onClick={() => navigate('/summaries')}>
            <MemoryIcon />
            Memories
          </button>
          <button className="memory-button" onClick={() => navigate('/memory-compare')}>
            Compare
          </button>
          <button className="logout-button" onClick={handleLogout}>
            <LogoutIcon />
            Logout
          </button>
        </div>
      </header>

      <main className="chat-main">
        <section className="chat-panel">
          <div className="chat-session-bar">
            <div>
              <div className="chat-session-label">Conversation</div>
              <div className="chat-session-title">{activeSession?.title || 'New Chat'}</div>
            </div>
          </div>

          <div className="chat-messages">
            {(loadingSession || loadingMessages) && (
              <div className="chat-empty">
                <div className="loading-spinner" />
                <p className="chat-empty-text">Loading conversation...</p>
              </div>
            )}

            {!loadingSession && !loadingMessages && messages.length === 0 && (
              <div className="chat-empty">
                <MirrorIcon />
                <p className="chat-empty-text">
                  Start talking and this thread will keep its Dify context.
                </p>
              </div>
            )}

            {!loadingSession && !loadingMessages && messages.map((message) => (
              <div
                key={message.id}
                className={`message-wrapper ${message.role}`}
              >
                <div
                  className={`message-bubble ${message.role} ${message.isError ? 'error' : ''}`}
                >
                  {message.content}
                  {streaming && message.role === 'assistant' && message.content === '' && (
                    <div className="thinking-indicator">
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-container">
            <form className="chat-input-wrapper" onSubmit={sendMessage}>
              <input
                type="text"
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your message..."
                disabled={streaming || loadingSession || loadingMessages || !activeSessionId}
              />
              <button
                type="submit"
                className="chat-send-button"
                disabled={streaming || loadingSession || loadingMessages || !input.trim() || !activeSessionId}
              >
                <SendIcon />
              </button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
