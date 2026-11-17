import { Routes, Route, Link } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import { Shell } from './components/Shell.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Assets from './pages/Assets.jsx';
import AssetDetail from './pages/AssetDetail.jsx';
import Imports from './pages/Imports.jsx';
import ImportNew from './pages/ImportNew.jsx';
import ImportBatch from './pages/ImportBatch.jsx';
import Conflicts from './pages/Conflicts.jsx';
import Scan from './pages/Scan.jsx';
import QrRequests from './pages/QrRequests.jsx';
import Transfer from './pages/Transfer.jsx';
import Receive from './pages/Receive.jsx';
import Transfers from './pages/Transfers.jsx';
import Report from './pages/Report.jsx';
import Investigations, { InvestigationDetail } from './pages/Investigations.jsx';
import Facilities, { FacilityDetail } from './pages/Facilities.jsx';
import Teams from './pages/Teams.jsx';
import People from './pages/People.jsx';
import Account, { ForcePasswordChange } from './pages/Account.jsx';

export default function App() {
  const { user } = useAuth();
  if (user === undefined) return <div className="center-fill" style={{ minHeight: '100vh' }}><div className="spinner" /></div>;
  if (!user) return <Login />;
  if (user.must_change_password) return <ForcePasswordChange />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="assets" element={<Assets />} />
        <Route path="assets/:id" element={<AssetDetail />} />
        <Route path="imports" element={<Imports />} />
        <Route path="imports/new" element={<ImportNew />} />
        <Route path="imports/:id" element={<ImportBatch />} />
        <Route path="conflicts" element={<Conflicts />} />
        <Route path="scan" element={<Scan />} />
        <Route path="qr-requests" element={<QrRequests />} />
        <Route path="transfer" element={<Transfer />} />
        <Route path="receive" element={<Receive />} />
        <Route path="transfers" element={<Transfers />} />
        <Route path="report" element={<Report />} />
        <Route path="investigations" element={<Investigations />} />
        <Route path="investigations/:id" element={<InvestigationDetail />} />
        <Route path="facilities" element={<Facilities />} />
        <Route path="facilities/:id" element={<FacilityDetail />} />
        <Route path="teams" element={<Teams />} />
        <Route path="people" element={<People />} />
        <Route path="account" element={<Account />} />
        <Route path="*" element={<div className="empty"><strong>Page not found</strong><Link to="/">Return to dashboard</Link></div>} />
      </Route>
    </Routes>
  );
}
