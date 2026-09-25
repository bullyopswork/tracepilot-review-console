CREATE TABLE review_session_capacity_lock (
  lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1)
);

INSERT INTO review_session_capacity_lock (lock_id) VALUES (1);

CREATE INDEX review_sessions_expires_idx ON review_sessions (expires_at ASC);
