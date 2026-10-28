-- Schema-per-service: нэг Postgres, сервис бүр өөрийн schema, cross-schema FK хориотой.
CREATE SCHEMA IF NOT EXISTS origination;
CREATE SCHEMA IF NOT EXISTS kyc;
CREATE SCHEMA IF NOT EXISTS scoring;
CREATE SCHEMA IF NOT EXISTS valuation;
CREATE SCHEMA IF NOT EXISTS dms;
CREATE SCHEMA IF NOT EXISTS iam;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Outbox хүснэгт schema бүрт
DO $$ DECLARE s text; BEGIN
  FOREACH s IN ARRAY ARRAY['origination','kyc','scoring','valuation','dms'] LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.outbox (id uuid PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz)', s);
  END LOOP; END $$;
