// App-wide auth state. On mount it asks Cognito whether a valid session exists
// (tokens live in localStorage), so a refresh keeps you logged in.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { getSession, signOut as cognitoSignOut } from './cognito';
import { clearDoorCache } from '../doorCache';

interface AuthContextValue {
  email: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const session = await getSession();
    const claimEmail = session?.getIdToken().payload.email as string | undefined;
    setEmail(claimEmail ?? null);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  function logout() {
    cognitoSignOut();
    // Door mode's offline copy is viewable without auth — it must not outlive
    // the login that created it.
    void clearDoorCache();
    setEmail(null);
  }

  return (
    <AuthContext.Provider value={{ email, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
