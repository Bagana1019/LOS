-- Schema-per-service: нэг Postgres, сервис бүр өөрийн schema, cross-schema FK хориотой.
-- Хүснэгтүүдийг (outbox зэрэг) Prisma migration үүсгэнэ — энд ЗӨВХӨН schema ба extension.
CREATE SCHEMA IF NOT EXISTS origination;
CREATE SCHEMA IF NOT EXISTS kyc;
CREATE SCHEMA IF NOT EXISTS scoring;
CREATE SCHEMA IF NOT EXISTS valuation;
CREATE SCHEMA IF NOT EXISTS dms;
CREATE SCHEMA IF NOT EXISTS iam;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
