/**
 * Supabase Client — Singleton para operaciones server-side
 *
 * Usa SUPABASE_SERVICE_KEY (no anon key) para bypasear RLS.
 * Valida env vars en startup; falla con mensaje descriptivo si faltan.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types.js';
import { getLogger } from './logger.js';

const log = getLogger('supabase');

function createSupabaseClient(): SupabaseClient<Database> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    const missing = [
      !url ? 'SUPABASE_URL' : null,
      !key ? 'SUPABASE_SERVICE_KEY' : null,
    ]
      .filter(Boolean)
      .join(', ');

    log.error(
      { missing },
      'FATAL: missing required environment variables. Set these in your .env file. See .env.example for reference.',
    );
    process.exit(1);
  }

  return createClient<Database>(url, key, {
    auth: {
      persistSession: false, // servidor: no persistir sesión de usuario
      autoRefreshToken: false,
    },
  });
}

// Singleton — se instancia una vez al importar el módulo
export const supabase = createSupabaseClient();
