import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { client } from '../api/client';

interface Impression {
  scene: string;
  points: string[];
  retrievalText: string;
  content: string;
  score: number;
  createdAt: string;
  date: string;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12c0 1.2-4.03 6-9 6s-9-4.8-9-6c0-1.2 4.03-6 9-6s9 4.8 9 6" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function Summaries() {
  const [impressions, setImpressions] = useState<Impression[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { isAuthenticated, user, logout } = useAuthStore();

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }
    fetchImpressions();
  }, [isAuthenticated, navigate, user]);

  const fetchImpressions = async () => {
    if (!user?.id) return;
    try {
      const response = await client.get(`/impressions/${user.id}`);
      setImpressions(response.data.impressions || []);
    } catch (err) {
      setError('Failed to load impressions');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const groupByDate = (impressions: Impression[]) => {
    const grouped: Record<string, Impression[]> = {};
    impressions.forEach((imp) => {
      const date = imp.date || imp.createdAt?.split('T')[0] || 'Unknown';
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(imp);
    });
    return grouped;
  };

  const groupedImpressions = groupByDate(impressions);

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
          <h1 className="page-title">Memory Impressions</h1>
        </div>
        <button className="logout-button" onClick={handleLogout}>
          Logout
        </button>
      </header>

      <main className="summaries-main">
        {loading ? (
          <div className="loading-state">
            <div className="loading-spinner" />
            <p>Loading impressions...</p>
          </div>
        ) : error ? (
          <div className="error-state">{error}</div>
        ) : impressions.length === 0 ? (
          <div className="empty-state">
            <MemoryIcon />
            <p>No impressions yet.</p>
            <p className="empty-hint">Start chatting to create memory impressions.</p>
          </div>
        ) : (
          <div className="impressions-list">
            {Object.entries(groupedImpressions).map(([date, imps]) => (
              <div key={date} className="date-group">
                <h2 className="date-header">{date}</h2>
                <div className="impressions-grid">
                  {imps.map((imp, idx) => (
                    <div key={idx} className="impression-card">
                      <p className="impression-content">{imp.scene || imp.content}</p>
                      {imp.points?.length > 0 && (
                        <div className="impression-points">
                          {imp.points.map((point, pointIndex) => (
                            <p key={pointIndex} className="impression-content">{`- ${point}`}</p>
                          ))}
                        </div>
                      )}
                      {imp.createdAt && (
                        <span className="impression-time">
                          {new Date(imp.createdAt).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
