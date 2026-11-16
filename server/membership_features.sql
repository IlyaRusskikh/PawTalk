-- Additive API 2 feature storage; legacy API 2 tables and identities stay intact.
CREATE TABLE IF NOT EXISTS session_activity (
 session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
 away INTEGER NOT NULL CHECK(away IN (0,1))
) STRICT;
