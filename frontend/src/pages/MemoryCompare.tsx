import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { memoryCompareApi } from '../api/client';
import { useAuthStore } from '../stores/auth';

interface CustomMemory {
  scene: string;
  points: string[];
  time: string;
  score?: number;
}

interface Mem0Memory {
  id?: string;
  memory: string;
  score: number | null;
  metadata: Record<string, unknown>;
}

interface ProfileMemory {
  text: string;
  time: string;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function formatScore(score: number | null | undefined) {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return '';
  }

  return score.toFixed(3);
}

export default function MemoryCompare() {
  const [query, setQuery] = useState('用户最近在聊什么');
  const [customResults, setCustomResults] = useState<CustomMemory[]>([]);
  const [profileResults, setProfileResults] = useState<ProfileMemory[]>([]);
  const [mem0Results, setMem0Results] = useState<Mem0Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const userId = Number(user?.id);
    if (!Number.isInteger(userId) || !query.trim() || loading) return;

    setLoading(true);
    setError('');

    try {
      const response = await memoryCompareApi.search(userId, query.trim(), 6);
      setCustomResults(response.data.custom?.context || []);
      setProfileResults(response.data.profile?.preferences || []);
      setMem0Results(response.data.mem0?.results || []);
    } catch (err) {
      console.error(err);
      setError('Search failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="summaries-page">
      <div className="mirror-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
        <div className="orb orb-4" />
      </div>

      <header className="summaries-header">
        <div className="header-left">
          <button className="back-button" onClick={() => navigate('/chat')}>
            <BackIcon />
          </button>
          <h1 className="page-title">Memory Compare</h1>
        </div>
        <button className="logout-button" onClick={handleLogout}>
          Logout
        </button>
      </header>

      <main className="compare-main">
        <form className="compare-search" onSubmit={handleSearch}>
          <input
            className="compare-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memory"
            disabled={loading}
          />
          <button className="compare-button" type="submit" disabled={loading || !query.trim()}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>

        {error && <div className="error-state">{error}</div>}

        <section className="compare-grid">
          <div className="compare-column">
            <div className="compare-column-header">
              <h2>Custom Impressions</h2>
              <span>{customResults.length} results</span>
            </div>
            <div className="compare-result-list">
              {customResults.length === 0 ? (
                <p className="compare-empty">No custom results.</p>
              ) : customResults.map((item, index) => (
                <article key={`${item.scene}-${index}`} className="compare-result-card">
                  <div className="compare-card-meta">
                    <span>{item.time || 'No time'}</span>
                    {formatScore(item.score) && <span>{formatScore(item.score)}</span>}
                  </div>
                  <h3>{item.scene}</h3>
                  {item.points.map((point, pointIndex) => (
                    <p key={pointIndex}>{point}</p>
                  ))}
                </article>
              ))}
            </div>
          </div>

          <div className="compare-column">
            <div className="compare-column-header">
              <h2>Profile Memories</h2>
              <span>{profileResults.length} results</span>
            </div>
            <div className="compare-result-list">
              {profileResults.length === 0 ? (
                <p className="compare-empty">No profile results.</p>
              ) : profileResults.map((item, index) => (
                <article key={`${item.text}-${index}`} className="compare-result-card">
                  <div className="compare-card-meta">
                    <span>{item.time || 'No time'}</span>
                  </div>
                  <h3>{item.text}</h3>
                </article>
              ))}
            </div>
          </div>

          <div className="compare-column">
            <div className="compare-column-header">
              <h2>Mem0 Memories</h2>
              <span>{mem0Results.length} results</span>
            </div>
            <div className="compare-result-list">
              {mem0Results.length === 0 ? (
                <p className="compare-empty">No Mem0 results.</p>
              ) : mem0Results.map((item, index) => (
                <article key={item.id || index} className="compare-result-card">
                  <div className="compare-card-meta">
                    <span>{item.id || 'No id'}</span>
                    {formatScore(item.score) && <span>{formatScore(item.score)}</span>}
                  </div>
                  <h3>{item.memory}</h3>
                  {Object.keys(item.metadata || {}).length > 0 && (
                    <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
                  )}
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
