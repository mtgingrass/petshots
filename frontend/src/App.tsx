import { Routes, Route } from 'react-router-dom';
import { Landing } from './pages/Landing';
import { SignUp } from './pages/SignUp';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Privacy } from './pages/Privacy';
import { ProtectedRoute } from './components/ProtectedRoute';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/login" element={<Login />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
