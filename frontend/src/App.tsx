import { Routes, Route } from 'react-router-dom';
import { Landing } from './pages/Landing';
import { SignUp } from './pages/SignUp';
import { Login } from './pages/Login';
import { ResetPassword } from './pages/ResetPassword';
import { Dashboard } from './pages/Dashboard';
import { Privacy } from './pages/Privacy';
import { PassportPage } from './pages/PassportPage';
import { UnsubscribePage } from './pages/UnsubscribePage';
import { DoorPage } from './pages/DoorPage';
import { JoinPage } from './pages/JoinPage';
import { RoadmapPage } from './pages/RoadmapPage';
import { ProtectedRoute } from './components/ProtectedRoute';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/p/:token" element={<PassportPage />} />
      <Route path="/unsubscribe" element={<UnsubscribePage />} />
      <Route path="/door" element={<DoorPage />} />
      <Route path="/join/:token" element={<JoinPage />} />
      <Route path="/roadmap" element={<RoadmapPage />} />
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
