-- ============================================================
-- Migration: 20260403180000_tasks
-- WKH-23: Crear tabla tasks para A2A Protocol
-- ============================================================

-- Función reutilizable para trigger updated_at (idempotente)
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Tabla principal
CREATE TABLE IF NOT EXISTS tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id  TEXT,
  status      TEXT        NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','working','completed','failed','canceled','input-required')),
  messages    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  artifacts   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice en status (queries frecuentes por estado)
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks (status);

-- Índice parcial en context_id (solo filas con valor)
CREATE INDEX IF NOT EXISTS idx_tasks_context_id
  ON tasks (context_id)
  WHERE context_id IS NOT NULL;

-- Trigger para updated_at automático
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();
