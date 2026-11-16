-- Additive API 2 feature storage; legacy API 2 tables and identities stay intact.
CREATE TABLE IF NOT EXISTS session_activity (
 session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
 away INTEGER NOT NULL CHECK(away IN (0,1))
) STRICT;

CREATE TABLE IF NOT EXISTS server_avatar (
 id INTEGER PRIMARY KEY CHECK(id=1), envelope BLOB, author_profile_id TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1
) STRICT;
INSERT OR IGNORE INTO server_avatar(id) VALUES(1);
