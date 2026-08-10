CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  updated_at INTEGER,
  form_data_json TEXT,
  session_token TEXT,
  session_expires_at INTEGER,
  status TEXT,
  temperature TEXT,
  follow_up_at INTEGER,
  notes TEXT,
  source TEXT,
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  crm_json TEXT,
  no_email INTEGER NOT NULL DEFAULT 0,
  unsubscribe_token TEXT,
  last_rate_email_at INTEGER,
  pre_approval_status TEXT,
  pre_approval_status_updated_at INTEGER,
  adverse_action_sent_at INTEGER,
  adverse_action_reasons_json TEXT,
  incomplete_notice_at INTEGER,
  incomplete_deadline_at INTEGER,
  incomplete_notice_note TEXT,
  incomplete_reminder_sent_at INTEGER,
  esign_email_verified_at INTEGER,
  esign_consent_at INTEGER,
  esign_consent_version TEXT
);

CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_session_token ON leads(session_token);
CREATE INDEX idx_leads_incomplete_deadline ON leads(incomplete_deadline_at);

CREATE TABLE estimate_otps (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE esign_otps (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  email TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE document_uploads (
  id TEXT PRIMARY KEY,
  borrower_name TEXT,
  email TEXT,
  phone TEXT,
  purpose TEXT,
  created_at INTEGER NOT NULL,
  files_json TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_size_bytes INTEGER NOT NULL DEFAULT 0,
  lead_id TEXT REFERENCES leads(id)
);

CREATE INDEX idx_document_uploads_lead ON document_uploads(lead_id);

CREATE TABLE rate_alerts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  term INTEGER NOT NULL,
  refinance INTEGER NOT NULL DEFAULT 0,
  target_rate REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  lang TEXT NOT NULL DEFAULT 'en'
);

CREATE INDEX idx_rate_alerts_active ON rate_alerts(active);

CREATE TABLE savings_alerts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  balance REAL NOT NULL,
  current_rate REAL NOT NULL,
  years_left INTEGER NOT NULL,
  term INTEGER NOT NULL,
  target_savings REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  lang TEXT NOT NULL DEFAULT 'en'
);

CREATE INDEX idx_savings_alerts_active ON savings_alerts(active);

CREATE TABLE inquiries (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  phone TEXT,
  zip TEXT,
  source TEXT,
  message TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL
);

CREATE TABLE pmms_cache (
  term TEXT PRIMARY KEY,
  value REAL NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  page TEXT,
  zip TEXT,
  city TEXT,
  region TEXT,
  lead_id TEXT,
  lang TEXT,
  referrer TEXT,
  ip TEXT,
  user_agent TEXT,
  pages TEXT
);

CREATE INDEX idx_visits_last_seen ON visits(last_seen_at);

CREATE TABLE rate_snapshots (
  id TEXT PRIMARY KEY,
  thirty_year_fixed REAL,
  fifteen_year_fixed REAL,
  seven_year_arm REAL,
  five_year_arm REAL,
  thirty_year_fixed_fha REAL,
  thirty_year_fixed_va REAL,
  fetched_at INTEGER NOT NULL,
  source TEXT
);

CREATE TABLE external_rates (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  scenario TEXT,
  email_date TEXT,
  posted_date TEXT,
  json TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (source, id)
);

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE rate_config_history (
  version INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE alert_cooldowns (
  kind TEXT PRIMARY KEY,
  last_fired_at INTEGER NOT NULL
);

CREATE TABLE azure_fallback_hits (
  path TEXT NOT NULL,
  method TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (path, method)
);
