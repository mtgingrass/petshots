import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function Dashboard() {
  const { email, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  return (
    <main className="page">
      <header className="dashboard-header">
        <h1>Your pets</h1>
        <div className="dashboard-user">
          <span className="subtle">{email}</span>
          <button className="btn" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      <section className="card">
        <p className="subtle">
          You don't have a pet yet. Soon you'll add one pet and upload up to four
          vaccination documents here.
        </p>
        <button className="btn btn--primary" disabled>
          Add a pet (coming soon)
        </button>
      </section>
    </main>
  );
}
