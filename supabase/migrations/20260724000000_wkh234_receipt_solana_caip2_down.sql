-- WKH-234 (W5) DOWN — revierte las columnas aditivas de metadata Solana.
-- Seguro: solo elimina columnas nullable no referenciadas por el HMAC canónico.

ALTER TABLE public.a2a_receipts
  DROP COLUMN IF EXISTS settle_caip2,
  DROP COLUMN IF EXISTS settle_signature;
