# ═══════════════════════════════════════════════════════════
# DEPLOYMENT GUIDE
# ═══════════════════════════════════════════════════════════

# ── FRONTEND → Vercel ────────────────────────────────────
# 1. Push repo to GitHub
# 2. Go to vercel.com → New Project → Import from GitHub
# 3. Set Root Directory: frontend
# 4. Set Build Command: npm run build
# 5. Set Output Directory: dist
# 6. Add Environment Variables:
#    VITE_API_BASE = https://your-backend.railway.app/api
#    VITE_SUPABASE_URL = https://your-project.supabase.co
#    VITE_SUPABASE_ANON_KEY = your-anon-key

# ── BACKEND → Railway ────────────────────────────────────
# 1. Go to railway.app → New Project → Deploy from GitHub
# 2. Set Root Directory: backend
# 3. Set Start Command: npm start
# 4. Add Environment Variables (from backend/.env.example):
#    SUPABASE_URL
#    SUPABASE_SERVICE_KEY
#    API_SPORTS_KEY
#    ODDS_API_KEY
#    FRONTEND_URL = https://your-app.vercel.app
#    NODE_ENV = production
#    ADMIN_API_KEY = (generate a secure random string)

# ── DATABASE → Supabase ──────────────────────────────────
# 1. Go to supabase.com → New Project
# 2. Open SQL Editor
# 3. Paste contents of backend/src/db/schema.sql
# 4. Run it
# 5. Then run: cd backend && npm run db:seed
# 6. Then run: cd backend && npm run scrape:ufcstats
#    (This takes several hours for the full import)

# ── CUSTOM DOMAIN ────────────────────────────────────────
# On Vercel: Settings → Domains → Add domain
# Point your DNS CNAME to cname.vercel-dns.com

# ── ESTIMATED MONTHLY COSTS AT LAUNCH ───────────────────
# Supabase:       Free (up to 500MB, 2GB transfer)
# Vercel:         Free (hobby tier)
# Railway:        $5/mo (starter)
# API-Sports:     $15/mo (MMA plan)
# Odds API:       Free (500 req/mo) → $19/mo when you need more
# TOTAL:          ~$20-35/mo to start
