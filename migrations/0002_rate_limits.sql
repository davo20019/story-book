CREATE TABLE IF NOT EXISTS rate_limits (
  ip TEXT NOT NULL,
  date_key TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, date_key)
);
