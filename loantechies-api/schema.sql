-- loantechies-api D1 schema. Apply via the D1 dashboard console (no local wrangler on this
-- machine — see root CLAUDE.md). Mirrors the 11 Azure Table Storage tables in SofticianApi's
-- Backend, verified against each table's actual ITableEntity class (not guessed). Every Azure
-- table used a near-fixed PartitionKey discriminator, so this is a mechanical flatten: PartitionKey
-- is dropped, RowKey becomes `id`, and all timestamps move from Azure's DateTime/DateTimeOffset to
-- INTEGER epoch seconds (D1/SQLite convention, matches examprep-api's schema.sql).
--
-- Populate via the Phase 1/3/4 backfill script (see the migration plan) — this file only creates
-- the empty schema.

-- ── Leads (SofticianApi/Leads/EstimateGate.cs LeadEntity) ──────────────────────────────────
-- The single highest-stakes table: OTP-gated session, admin CRM fields, Reg B §1002.9 adverse-
-- action/incomplete-notice compliance fields, and E-SIGN Act consent. Migrate last (Phase 3).
CREATE TABLE leads (
  id                            TEXT PRIMARY KEY,       -- was RowKey (GUID "N")
  first_name                    TEXT,
  last_name                     TEXT,
  email                         TEXT,
  phone                         TEXT,
  lang                          TEXT NOT NULL DEFAULT 'en',
  created_at                    INTEGER NOT NULL,
  verified_at                   INTEGER,                 -- NULL = admin-created, never 2FA-verified
  updated_at                    INTEGER,
  form_data_json                TEXT,                    -- last captured What's My Rate inputs + results
  session_token                 TEXT,
  session_expires_at            INTEGER,
  -- Admin CRM fields (admin.loantechies.com only; public flow never touches these except
  -- status/source/updated_by via system values)
  status                        TEXT,                    -- pipeline stage, default 'New'
  temperature                   TEXT,                    -- Hot / Warm / Cold
  follow_up_at                  INTEGER,
  notes                         TEXT,
  source                        TEXT,                    -- 'estimate' (tool) | 'admin'
  updated_by                    TEXT,                    -- admin email | 'system (...)'
  deleted                       INTEGER NOT NULL DEFAULT 0,
  crm_json                      TEXT,                    -- extended scenario/refi/financial blob (editor)
  -- Rate-email fields (console/leads/email-rate)
  no_email                      INTEGER NOT NULL DEFAULT 0,
  unsubscribe_token             TEXT,
  last_rate_email_at            INTEGER,
  -- Pre-approval status (borrower-facing; deliberately separate vocabulary from status/temperature)
  pre_approval_status           TEXT,                    -- NULL = never submitted
  pre_approval_status_updated_at INTEGER,
  -- Reg B §1002.9 closure fields
  adverse_action_sent_at        INTEGER,
  adverse_action_reasons_json   TEXT,                    -- JSON string[]
  incomplete_notice_at          INTEGER,
  incomplete_deadline_at        INTEGER,                 -- drives the daily auto-withdraw sweep
  incomplete_notice_note        TEXT,
  incomplete_reminder_sent_at   INTEGER,                 -- persisted flag, not a timing check — see
                                                           -- loantechies-alert-cooldown-reliability memory
  -- E-SIGN Act (15 U.S.C. §7001(c)) consent
  esign_email_verified_at       INTEGER,
  esign_consent_at              INTEGER,
  esign_consent_version         TEXT
);
CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_session_token ON leads(session_token);
CREATE INDEX idx_leads_incomplete_deadline ON leads(incomplete_deadline_at);

-- ── Estimate OTPs (EstimateGate.cs EstimateOtpEntity, PK "otp") ─────────────────────────────
-- Email 2FA gate in front of What's My Rate. id = normalized-email key (one row per email; a new
-- request overwrites the pending code, matching the Azure upsert-by-RowKey behavior).
CREATE TABLE estimate_otps (
  id            TEXT PRIMARY KEY,   -- EmailKey(normalized email)
  code_hash     TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  email         TEXT,
  phone         TEXT,
  lang          TEXT NOT NULL DEFAULT 'en',
  expires_at    INTEGER NOT NULL,
  sent_at       INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0
);

-- ── E-SIGN OTPs (same EstimateOtpEntity shape, PK "esign-otp" per the pre-approval E-SIGN
-- confirm-code flow) — split into its own table since D1 doesn't need Table Storage's PK
-- multiplexing trick. id = lead_id (this flow is session-gated by leadId+token, not by email).
CREATE TABLE esign_otps (
  id            TEXT PRIMARY KEY,   -- lead_id
  code_hash     TEXT NOT NULL,
  email         TEXT,               -- the just-entered address being verified
  lang          TEXT NOT NULL DEFAULT 'en',
  expires_at    INTEGER NOT NULL,
  sent_at       INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0
);

-- ── Document uploads (Loans/DocumentUpload.cs DocumentUploadEntity, PK "submission") ────────
-- Files themselves live in R2 (loantechies-documents bucket), one object per file under
-- {id}/{fileIndex}-{sanitizedFileName} — same key scheme as the Azure blob path so
-- files_json's references don't need rewriting. Migrate in Phase 4.
CREATE TABLE document_uploads (
  id                TEXT PRIMARY KEY,   -- submission id (GUID), also the R2 key prefix
  borrower_name     TEXT,
  email             TEXT,
  phone             TEXT,
  purpose           TEXT,               -- 'Purchase' | 'Refinance' | 'Not sure' | ''
  created_at        INTEGER NOT NULL,
  files_json        TEXT,               -- JSON array of file metadata
  file_count        INTEGER NOT NULL DEFAULT 0,   -- denormalized, avoids parsing files_json for list view
  total_size_bytes  INTEGER NOT NULL DEFAULT 0,
  lead_id           TEXT REFERENCES leads(id)     -- NULL for anonymous /upload-documents submissions
);
CREATE INDEX idx_document_uploads_lead ON document_uploads(lead_id);

-- ── Rate Watch alerts (Loans/RateAlert.cs RateAlertEntity, PK "alert") ──────────────────────
CREATE TABLE rate_alerts (
  id            TEXT PRIMARY KEY,   -- unsubscribe token (GUID)
  email         TEXT NOT NULL,
  term          INTEGER NOT NULL,   -- 30 / 15 / 7 / 5
  refinance     INTEGER NOT NULL DEFAULT 0,
  target_rate   REAL NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  notified_at   INTEGER,
  lang          TEXT NOT NULL DEFAULT 'en'
);
CREATE INDEX idx_rate_alerts_active ON rate_alerts(active);

-- ── Savings Watch alerts (Loans/SavingsAlert.cs SavingsAlertEntity, PK "alert") ─────────────
CREATE TABLE savings_alerts (
  id              TEXT PRIMARY KEY,  -- unsubscribe token (GUID)
  email           TEXT NOT NULL,
  balance         REAL NOT NULL,     -- remaining principal on the current loan
  current_rate    REAL NOT NULL,
  years_left      INTEGER NOT NULL,
  term            INTEGER NOT NULL,  -- new program compared against: 30 / 15 / 7 / 5
  target_savings  REAL NOT NULL,     -- notify when monthly P&I drops by >= this ($)
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  notified_at     INTEGER,
  lang            TEXT NOT NULL DEFAULT 'en'
);
CREATE INDEX idx_savings_alerts_active ON savings_alerts(active);

-- ── Contact inquiries (Utils/SendInquiry.cs, PK "inquiry") ──────────────────────────────────
CREATE TABLE inquiries (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  zip         TEXT,
  source      TEXT,
  message     TEXT,
  lang        TEXT NOT NULL DEFAULT 'en',
  created_at  INTEGER NOT NULL
);

-- ── PMMS weekly-average cache (Loans/PmmsProvider.cs PmmsCacheEntity) ───────────────────────
CREATE TABLE pmms_cache (
  term        TEXT PRIMARY KEY,  -- "30" / "15" (was RowKey)
  value       REAL NOT NULL,     -- last good PMMS weekly average (%)
  fetched_at  INTEGER NOT NULL
);

-- ── Site visits (Analytics/VisitTracker.cs VisitEntity, PK "visit") ─────────────────────────
-- Highest row count of any table (per-session beacon writes); rolling MaxRetained=5000 cap
-- pruned on admin read today — keep that pruning behavior rather than letting this grow unbounded.
CREATE TABLE visits (
  id              TEXT PRIMARY KEY,   -- sanitized SessionId (was RowKey)
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  page            TEXT,
  zip             TEXT,
  city            TEXT,
  region          TEXT,
  lead_id         TEXT,
  lang            TEXT,
  referrer        TEXT,
  ip              TEXT,               -- for the admin-editable Visitor Exclusions filter
  user_agent      TEXT,
  pages           TEXT                -- every page seen this session, "\n"-joined, in order
);
CREATE INDEX idx_visits_last_seen ON visits(last_seen_at);

-- ── Daily rate snapshots (Loans/RateSnapshotTimer.cs RateSnapshotEntity, PK "snapshot") ─────
-- id keeps the lexicographically-sortable "yyyy-MM-dd" format from RowKey — the 365-day
-- retention sweep does a string comparison (WHERE id < cutoff) that ports unchanged onto D1's
-- byte-wise TEXT comparison.
CREATE TABLE rate_snapshots (
  id                       TEXT PRIMARY KEY,  -- "2026-06-27"
  thirty_year_fixed        REAL,
  fifteen_year_fixed       REAL,
  seven_year_arm           REAL,
  five_year_arm            REAL,
  thirty_year_fixed_fha    REAL,
  thirty_year_fixed_va     REAL,
  fetched_at               INTEGER NOT NULL,
  source                   TEXT               -- "zillow-current"
);

-- ── External rate-source snapshots (Admin/ExternalRates.cs + Admin/ProvidentRates.cs, both
-- share one Azure table keyed by source) ────────────────────────────────────────────────────
-- source = "loanfactory" | "rocketpro" | "provident" (was PartitionKey); id = "yyyy-MM-dd" (was
-- RowKey). json holds the full raw ingest payload for each source — the grid shapes differ
-- enough between sources (LoanFactory/RocketPro: Scenario+Conventional/NonQm arrays; Provident:
-- posted_date+Grids dict) that a single flexible json column matches the existing DTO-level
-- flexibility better than forcing one fixed column set across all three sources.
CREATE TABLE external_rates (
  source        TEXT NOT NULL,   -- "loanfactory" | "rocketpro" | "provident"
  id            TEXT NOT NULL,   -- "2026-06-30" (email/posted date)
  scenario      TEXT,            -- loanfactory/rocketpro only
  email_date    TEXT,            -- loanfactory/rocketpro only (raw string from the email)
  posted_date   TEXT,            -- provident only (raw string from the ingest payload)
  json          TEXT NOT NULL,   -- full raw ingest payload
  saved_at      INTEGER NOT NULL,
  PRIMARY KEY (source, id)
);

-- ── Generic admin config store (Config/RateConfig.cs ConfigEntity, PK "config" — reused as-is
-- by VisitExclusionsStore, FeatureFlagsStore, QuestionnaireConfigStore, EstimateDefaultsStore,
-- ContactConfigStore, RateConfigStore in the Azure code). One JSON blob per feature key.
CREATE TABLE app_config (
  key         TEXT PRIMARY KEY,  -- 'estimated-rate' | 'visit-exclusions' | 'feature-flags' |
                                   -- 'questionnaire' | 'estimate-defaults' | 'contact'
  json        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- ── Rate config admin value-trail (Config/RateConfig.cs RateConfigHistoryEntity, PK
-- "history") ─────────────────────────────────────────────────────────────────────────────
-- Deliberately simplified vs. the Azure entity's scalar columns (several of which are already
-- marked [Obsolete] there, kept only for a ~2-week deserialization grace period that has long
-- since passed) — store the full config snapshot as json instead of mirroring soon-to-be-dead
-- columns into a fresh table.
CREATE TABLE rate_config_history (
  version     INTEGER PRIMARY KEY,
  json        TEXT NOT NULL,     -- full RateConfig snapshot at this version
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- ── Alert cooldowns (Utils/AlertCooldownStore.cs — also just app_config rows in Azure, PK
-- "alert-cooldown") ─────────────────────────────────────────────────────────────────────────
-- Split into its own table for SQL clarity. MUST stay a durable D1 write, not an in-memory Map —
-- this exists because of a real 2026-07-04 incident where in-memory cooldowns reset on every
-- Azure Functions cold start and caused duplicate alert emails; a redeployed/restarted Workers
-- isolate must not forget the cooldown either.
CREATE TABLE alert_cooldowns (
  kind            TEXT PRIMARY KEY,  -- caller-chosen alert kind
  last_fired_at   INTEGER NOT NULL
);
