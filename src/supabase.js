import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;

if (!url || !key) {
  console.warn('Supabase env vars missing — set VITE_SUPABASE_URL and VITE_SUPABASE_KEY in .env');
}

// Prototype uses a client-side role switcher, so no auth session is persisted.
export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
