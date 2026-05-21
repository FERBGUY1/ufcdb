# UFCDB — The Complete UFC Fighter Database

A full-stack web application covering every UFC fighter in history with stats, profiles, fight records, betting odds, personal details, gym info, and coaching staff.

## Tech Stack

- **Frontend**: React 18 + Vite + Tailwind CSS
- **Backend**: Node.js + Express
- **Database**: PostgreSQL via Supabase
- **Auth**: Supabase Auth
- **Hosting**: Vercel (frontend) + Railway (backend)
- **APIs**: API-Sports (fighter data), The Odds API (betting lines)
- **Scraping**: Cheerio + Axios (UFC Stats, Sherdog, Tapology)

## Project Structure

```
ufcdb/
├── frontend/          # React app
│   └── src/
│       ├── components/   # Reusable UI components
│       ├── pages/        # Route pages
│       ├── hooks/        # Custom React hooks
│       └── lib/          # API client, utilities
├── backend/           # Express API server
│   └── src/
│       ├── routes/       # API route handlers
│       ├── scrapers/     # Data scrapers
│       ├── db/           # Database queries
│       └── middleware/   # Auth, rate limiting, etc.
└── shared/            # Shared types/constants
```

## Quick Start

### 1. Clone and install
```bash
git clone <repo>
cd ufcdb
npm run install:all
```

### 2. Environment variables
Copy `.env.example` to `.env` in both `/frontend` and `/backend` and fill in:
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` (from supabase.com)
- `API_SPORTS_KEY` (from api-sports.io — ~$15/mo)
- `ODDS_API_KEY` (from the-odds-api.com — free tier available)

### 3. Set up database
```bash
cd backend
npm run db:migrate    # Creates all tables
npm run db:seed       # Seeds weight classes, initial data
```

### 4. Run the scraper (one-time historical import)
```bash
npm run scrape:ufcstats    # ~1,800 fighters from ufcstats.com
npm run scrape:sherdog     # Amateur records + additional history
```

### 5. Start development
```bash
# From root
npm run dev   # Starts both frontend (5173) and backend (3001)
```

## API Keys Needed

| Service | Purpose | Cost | Link |
|---------|---------|------|------|
| Supabase | Database + Auth | Free tier | supabase.com |
| API-Sports | Live fighter data | ~$15/mo | api-sports.io |
| The Odds API | Betting lines | Free tier (500 req/mo) | the-odds-api.com |

## Monetization

- Google AdSense display ads
- Sportsbook affiliate links (DraftKings, FanDuel, BetMGM)
- Premium tier ($7.99/mo) for odds history + advanced stats
