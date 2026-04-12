import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/auth';
import Login from './pages/Login';
import Chat from './pages/Chat';
import Summaries from './pages/Summaries';
import MemoryCompare from './pages/MemoryCompare';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function App() {
  return (
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
      <Route
        path="/summaries"
        element={
          <ProtectedRoute>
            <Summaries />
          </ProtectedRoute>
        }
      />
      <Route
        path="/memory-compare"
        element={
          <ProtectedRoute>
            <MemoryCompare />
          </ProtectedRoute>
        }
      />
      <Route path="/" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}

export default App;
