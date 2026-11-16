import { Routes, Route, Link } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import { Shell } from './components/Shell.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Assets from './pages/Assets.jsx';
import AssetDetail from './pages/AssetDetail.jsx';

export default function App() {
  const { user } = useAuth();
  if (user === undefined) return <div className="center-fill" style={{ minHeight: '100vh' }}><div className="spinner" /></div>;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="assets" element={<Assets />} />
        <Route path="assets/:id" element={<AssetDetail />} />
        <Route path="*" element={<div className="empty"><strong>Page not found</strong><Link to="/">Return to dashboard</Link></div>} />
      </Route>
    </Routes>
  );
}
