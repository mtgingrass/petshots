// Wraps any route that requires a logged-in user. While we're still checking
// for an existing session we show a tiny placeholder to avoid a flash of redirect.
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { email, loading } = useAuth();
  if (loading) return <p style={{ padding: '2rem' }}>Loading…</p>;
  if (!email) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
