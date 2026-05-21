import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Nav         from './components/Nav';
import HomePage    from './pages/HomePage';
import RosterPage  from './pages/RosterPage';
import FighterPage from './pages/FighterPage';
import EventsPage  from './pages/EventsPage';
import EventPage   from './pages/EventPage';
import PredictPage from './pages/PredictPage';
import StylesPage  from './pages/StylesPage';
import ComparePage from './pages/ComparePage';
import RankingsPage from './pages/RankingsPage';
import NotFoundPage from './pages/NotFoundPage';
import './styles/globals.css';

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-dark text-white font-body">
        <Nav />
        <Routes>
          <Route path="/"                 element={<HomePage />} />
          <Route path="/fighters"         element={<RosterPage />} />
          <Route path="/fighters/:slug"   element={<FighterPage />} />
          <Route path="/events"           element={<EventsPage />} />
          <Route path="/events/:slug"     element={<EventPage />} />
          <Route path="/predict"          element={<PredictPage />} />
          <Route path="/styles"           element={<StylesPage />} />
          <Route path="/compare"          element={<ComparePage />} />
          <Route path="/rankings"         element={<RankingsPage />} />
          <Route path="*"                 element={<NotFoundPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
