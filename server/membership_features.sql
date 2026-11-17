-- Additive API 2 feature storage; legacy API 2 tables and identities stay intact.
CREATE TABLE IF NOT EXISTS session_activity (
 session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
 away INTEGER NOT NULL CHECK(away IN (0,1))
) STRICT;

CREATE TABLE IF NOT EXISTS server_avatar (
 id INTEGER PRIMARY KEY CHECK(id=1), envelope BLOB, author_profile_id TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1
) STRICT;
INSERT OR IGNORE INTO server_avatar(id) VALUES(1);

CREATE TABLE IF NOT EXISTS polls (
 poll_id TEXT PRIMARY KEY CHECK(length(poll_id)=32),
 message_id INTEGER NOT NULL UNIQUE REFERENCES messages(message_id) ON DELETE CASCADE,
 option_count INTEGER NOT NULL CHECK(option_count BETWEEN 2 AND 10),
 multiple INTEGER NOT NULL CHECK(multiple IN (0,1)), anonymous INTEGER NOT NULL CHECK(anonymous IN (0,1)),
 intermediate INTEGER NOT NULL CHECK(intermediate IN (0,1)), closes_at INTEGER NOT NULL,
 closed_at INTEGER, result_message_id INTEGER REFERENCES messages(message_id) ON DELETE SET NULL,
 result_request_id TEXT NOT NULL UNIQUE CHECK(length(result_request_id)=32), result_nonce BLOB NOT NULL,
 result_ciphertext BLOB NOT NULL, create_hash BLOB NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS polls_deadline ON polls(closes_at) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS poll_votes (
 poll_id TEXT NOT NULL REFERENCES polls(poll_id) ON DELETE CASCADE,
 profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
 choices TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(poll_id,profile_id)
) STRICT;

-- System attribution is server-owned metadata; encrypted author contexts stay immutable.
CREATE TABLE IF NOT EXISTS system_messages (
 message_id INTEGER PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind='poll-result')
) STRICT;
INSERT OR IGNORE INTO system_messages(message_id,kind) SELECT result_message_id,'poll-result' FROM polls WHERE result_message_id IS NOT NULL;
