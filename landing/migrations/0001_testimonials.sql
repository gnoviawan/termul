CREATE TABLE IF NOT EXISTS testimonials (
  id TEXT PRIMARY KEY,
  quote TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  avatar_url TEXT,
  avatar_r2_key TEXT,
  avatar_content_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_testimonials_status_created_at
  ON testimonials (status, created_at DESC);

CREATE TABLE IF NOT EXISTS testimonial_submission_rate_limits (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_testimonial_rate_limits_ip_created_at
  ON testimonial_submission_rate_limits (ip_hash, created_at DESC);
