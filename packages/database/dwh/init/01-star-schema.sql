-- DWH star schema (docs/03, CLAUDE.md §4). `dwh-sync` (event + CDC) ЗӨВХӨН энд бичнэ; operational DB руу хэзээ ч бичихгүй.
-- Нэгж: мөнгө numeric(18,2), хувь numeric(7,4) бутархай (0.55 = 55%). Бизнес түлхүүр = operational ID (string) — cross-DB FK-гүй.
-- Docker compose-д dwh сервисийн /docker-entrypoint-initdb.d-д mount хийгдэнэ (хоосон volume дээр нэг удаа ажиллана).

CREATE TABLE IF NOT EXISTS dim_date (
  date_key     integer PRIMARY KEY,            -- YYYYMMDD
  full_date    date NOT NULL UNIQUE,
  year         smallint NOT NULL,
  quarter      smallint NOT NULL,
  month        smallint NOT NULL,
  day          smallint NOT NULL,
  iso_week     smallint NOT NULL,
  is_weekend   boolean NOT NULL
);
INSERT INTO dim_date (date_key, full_date, year, quarter, month, day, iso_week, is_weekend)
SELECT to_char(d, 'YYYYMMDD')::int, d, extract(year FROM d), extract(quarter FROM d), extract(month FROM d), extract(day FROM d),
       extract(week FROM d), extract(isodow FROM d) IN (6, 7)
FROM generate_series('2020-01-01'::date, '2040-12-31'::date, interval '1 day') AS g(d)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS dim_branch (
  branch_id    text PRIMARY KEY,
  org_id       text NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim_product (
  product_id   text PRIMARY KEY,
  org_id       text NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  product_type text NOT NULL,
  currency     text NOT NULL DEFAULT 'MNT',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Хувийн мэдээлэл (регистр, утас, хаяг) DWH-д ОРОХГҮЙ (CLAUDE.md §6.5): зөвхөн шинжилгээнд хэрэгтэй задаргаа.
CREATE TABLE IF NOT EXISTS dim_customer (
  customer_id     text PRIMARY KEY,
  org_id          text NOT NULL,
  customer_type   text NOT NULL,
  gender          text,
  birth_year      smallint,
  activity_sector text,
  segment         text,
  is_related_party boolean NOT NULL DEFAULT false,
  is_pep          boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact_application (
  application_id   text PRIMARY KEY,
  org_id           text NOT NULL,
  branch_id        text REFERENCES dim_branch (branch_id),
  product_id       text REFERENCES dim_product (product_id),
  customer_id      text REFERENCES dim_customer (customer_id),
  officer_id       text,
  status           text NOT NULL,
  amount           numeric(18,2),
  interest_rate    numeric(7,4),
  term_months      integer,
  selected_method  text,
  dti              numeric(7,4),
  dscr             numeric(7,4),
  ltv              numeric(7,4),
  sosco_score      numeric(7,2),
  submitted_date_key integer REFERENCES dim_date (date_key),
  decided_date_key   integer REFERENCES dim_date (date_key),
  submitted_at     timestamptz,
  approved_at      timestamptz,
  returned_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_application_status_idx ON fact_application (org_id, status);
CREATE INDEX IF NOT EXISTS fact_application_branch_idx ON fact_application (branch_id, submitted_date_key);

CREATE TABLE IF NOT EXISTS fact_disbursement (
  application_id   text PRIMARY KEY,
  org_id           text NOT NULL,
  branch_id        text REFERENCES dim_branch (branch_id),
  product_id       text REFERENCES dim_product (product_id),
  customer_id      text REFERENCES dim_customer (customer_id),
  disbursed_amount numeric(18,2) NOT NULL,
  core_loan_id     text,
  disbursed_date_key integer REFERENCES dim_date (date_key),
  disbursed_at     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_bsa_analysis (
  analysis_id      text PRIMARY KEY,
  org_id           text NOT NULL,
  application_id   text,
  customer_id      text REFERENCES dim_customer (customer_id),
  period_months    smallint,
  total_income     numeric(18,2),
  net_cash_flow_monthly numeric(18,2),
  dti              numeric(7,4),
  dti_level        text,
  suspicion_count  integer NOT NULL DEFAULT 0,
  analyzed_at      timestamptz
);

-- Consumer idempotency (CLAUDE.md §3.2.6): давхар хүргэлтийг eventId-аар хаана.
CREATE TABLE IF NOT EXISTS processed_events (
  consumer     text NOT NULL,
  event_id     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
