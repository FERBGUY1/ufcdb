import { Link } from 'react-router-dom';
export default function NotFoundPage() {
  return <main className="text-center py-24"><div className="font-display text-8xl tracking-wider text-white/10">404</div><p className="text-white/40 mt-4 mb-6">Page not found</p><Link to="/" className="btn-outline">Go Home</Link></main>;
}
