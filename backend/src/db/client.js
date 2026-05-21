const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('[DB] Warning: Supabase credentials not set. Using mock mode.');
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'http://localhost:54321',
  process.env.SUPABASE_SERVICE_KEY || 'mock-key',
  {
    auth: { persistSession: false },
  }
);

module.exports = supabase;
