import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { authApi } from '../api/client';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await authApi.login(username, password);
      login(response.data.token, response.data.user);
      navigate('/chat');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { message?: string } } };
        setError(axiosErr.response?.data?.message || 'Login failed');
      } else {
        setError('Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await authApi.register(username, password);
      const response = await authApi.login(username, password);
      login(response.data.token, response.data.user);
      navigate('/chat');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { message?: string } } };
        setError(axiosErr.response?.data?.message || 'Registration failed');
      } else {
        setError('Registration failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Background */}
      <div className="mirror-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
        <div className="orb orb-4" />
      </div>

      {/* Login Card */}
      <div className="login-container">
        <div className="glass-card">
          <h1 className="login-title">CHAT LIKE HUMAN</h1>
          <p className="login-subtitle">Gaze into the mirror</p>

          <form className="login-form" onSubmit={handleLogin}>
            <input
              type="text"
              className="glass-input"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={loading}
            />
            <input
              type="password"
              className="glass-input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
            />

            {error && <div className="login-error">{error}</div>}

            <button
              type="submit"
              className="glow-button"
              disabled={loading}
            >
              {loading ? (
                <span className="spinner" style={{ margin: '0 auto' }} />
              ) : (
                'Enter the Mirror'
              )}
            </button>
          </form>

          <div className="login-divider">or</div>

          <p className="login-footer">
            No account?{' '}
            <button type="button" onClick={handleRegister} disabled={loading}>
              Register
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
