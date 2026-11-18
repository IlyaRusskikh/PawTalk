-- API 2, schema 2. Fresh database only; never executed against the legacy chat DB.
CREATE TABLE server_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    schema_version INTEGER NOT NULL CHECK(schema_version=2),
    server_id TEXT NOT NULL UNIQUE CHECK(length(server_id)=32 AND server_id NOT GLOB '*[^0-9a-f]*'),
    identity_seed BLOB NOT NULL CHECK(length(identity_seed)=32),
    identity_public_key BLOB NOT NULL UNIQUE CHECK(length(identity_public_key)=32),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
    e2ee_key_id TEXT CHECK(e2ee_key_id IS NULL OR (length(e2ee_key_id)=64 AND e2ee_key_id NOT GLOB '*[^0-9a-f]*')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
) STRICT;

CREATE TABLE profiles (
    profile_id TEXT PRIMARY KEY CHECK(length(profile_id)=64 AND profile_id NOT GLOB '*[^0-9a-f]*'),
    identity_public_key BLOB NOT NULL UNIQUE CHECK(length(identity_public_key)=32),
    nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 32),
    avatar_envelope BLOB,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    created_at INTEGER NOT NULL
) STRICT;

-- Each original identity belongs to one installation. Grouping never copies keys.
CREATE TABLE devices (
    device_id TEXT PRIMARY KEY CHECK(length(device_id)=64 AND device_id NOT GLOB '*[^0-9a-f]*'),
    original_profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    signing_public_key BLOB NOT NULL UNIQUE CHECK(length(signing_public_key)=32),
    label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
    identity_certificate BLOB NOT NULL CHECK(length(identity_certificate)=64),
    created_at INTEGER NOT NULL,
    UNIQUE(device_id, original_profile_id)
) STRICT;
CREATE TRIGGER immutable_profile_identity BEFORE UPDATE OF profile_id,identity_public_key ON profiles BEGIN
    SELECT RAISE(ABORT,'profile identity cannot be replaced');
END;
CREATE TRIGGER immutable_device_identity BEFORE UPDATE OF device_id,original_profile_id,signing_public_key,identity_certificate ON devices BEGIN
    SELECT RAISE(ABORT,'device identity cannot be replaced');
END;

CREATE TABLE memberships (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK(state IN ('active','linked','left','kicked','revoked')),
    joined_at INTEGER NOT NULL,
    ended_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
) STRICT;

CREATE TABLE profile_bindings (
    source_profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    target_profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    CHECK(source_profile_id<>target_profile_id)
) STRICT;
CREATE INDEX binding_target ON profile_bindings(target_profile_id);
CREATE TRIGGER binding_insert BEFORE INSERT ON profile_bindings BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM profile_bindings WHERE source_profile_id=NEW.target_profile_id OR target_profile_id=NEW.source_profile_id)
        THEN RAISE(ABORT,'bindings must point directly to a root') END;
END;
CREATE TRIGGER binding_update BEFORE UPDATE ON profile_bindings BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM profile_bindings WHERE source_profile_id<>OLD.source_profile_id AND
        (source_profile_id=NEW.target_profile_id OR target_profile_id=NEW.source_profile_id)) OR NEW.target_profile_id=OLD.source_profile_id
        THEN RAISE(ABORT,'bindings must point directly to a root') END;
END;

CREATE TABLE profile_controls (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    primary_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
) STRICT;

CREATE TABLE roles (
    role_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    system_kind TEXT UNIQUE CHECK(system_kind IN ('member','moderator','admin'))
) STRICT;
CREATE TABLE role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY(role_id,permission)
) STRICT;
CREATE TABLE profile_roles (
    profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
    PRIMARY KEY(profile_id,role_id)
) STRICT;
-- Original profile assignments/appearance remain available when a device unlinks.
-- Overrides preserve a group's state when its original ID-owning device leaves.
CREATE TABLE group_roles (
    profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
    PRIMARY KEY(profile_id,role_id)
) STRICT;
CREATE VIEW effective_profile_roles AS
    SELECT profile_id,role_id FROM group_roles
    UNION ALL SELECT p.profile_id,p.role_id FROM profile_roles p
    WHERE NOT EXISTS(SELECT 1 FROM group_roles g WHERE g.profile_id=p.profile_id);
CREATE TABLE group_profiles (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 32),
    avatar_envelope BLOB,
    avatar_profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;
CREATE VIEW effective_profiles AS SELECT p.profile_id,p.created_at,
    CASE WHEN g.profile_id IS NULL THEN p.nickname ELSE g.nickname END AS nickname,
    CASE WHEN g.profile_id IS NULL THEN p.avatar_envelope ELSE g.avatar_envelope END AS avatar_envelope,
    CASE WHEN g.profile_id IS NULL THEN p.profile_id ELSE g.avatar_profile_id END AS avatar_profile_id,
    CASE WHEN g.profile_id IS NULL THEN p.revision ELSE g.revision END AS revision
    FROM profiles p LEFT JOIN group_profiles g ON g.profile_id=p.profile_id;
INSERT INTO roles VALUES ('member','Member','member'),('moderator','Moderator','moderator'),('admin','Administrator','admin');
INSERT INTO role_permissions VALUES
    ('member','chat.read'),('member','chat.write'),('member','voice.join'),
    ('moderator','chat.read'),('moderator','chat.write'),('moderator','voice.join'),
    ('moderator','invite.create'),('moderator','invite.revoke.own'),
    ('admin','chat.read'),('admin','chat.write'),('admin','voice.join'),
    ('admin','invite.create'),('admin','invite.revoke.own'),('admin','invite.revoke.any'),
    ('admin','channel.manage'),('admin','role.manage'),('admin','member.kick'),('admin','member.ban');

CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER,
    CHECK(expires_at>created_at)
) STRICT;
CREATE INDEX sessions_device ON sessions(device_id,revoked_at,expires_at);

CREATE TABLE auth_challenges (
    challenge_id TEXT PRIMARY KEY,
    nonce BLOB NOT NULL CHECK(length(nonce)=32),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
) STRICT;
CREATE INDEX challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE device_link_requests (
    request_id TEXT PRIMARY KEY,
    target_profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    source_profile_id TEXT REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    chosen_profile_id TEXT REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    target_main_device_id TEXT NOT NULL REFERENCES devices(device_id),
    source_main_device_id TEXT REFERENCES devices(device_id),
    target_exchange_key BLOB NOT NULL CHECK(length(target_exchange_key)=32),
    source_exchange_key BLOB CHECK(source_exchange_key IS NULL OR length(source_exchange_key)=32),
    target_revision INTEGER NOT NULL,
    source_revision INTEGER,
    token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32),
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('waiting','proposed','approved','confirmed','expired','cancelled')),
    source_proof BLOB,
    target_proof BLOB,
    final_proof BLOB,
    key_envelope BLOB
) STRICT;

CREATE TABLE ban_actions (
    ban_id TEXT PRIMARY KEY,
    issued_by_profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    reason TEXT NOT NULL DEFAULT '' CHECK(length(reason)<=512),
    CHECK(expires_at IS NULL OR expires_at>created_at)
) STRICT;
CREATE TABLE ban_subjects (
    ban_id TEXT NOT NULL REFERENCES ban_actions(ban_id) ON DELETE RESTRICT,
    profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    PRIMARY KEY(ban_id,profile_id)
) STRICT;
CREATE INDEX ban_profile ON ban_subjects(profile_id,ban_id);

CREATE TABLE channels (
    channel_id TEXT PRIMARY KEY CHECK(length(channel_id)=32 AND channel_id NOT GLOB '*[^0-9a-f]*'),
    kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
    position INTEGER NOT NULL CHECK(position>=0),
    protected_kind TEXT UNIQUE CHECK(protected_kind IN ('default_text','default_voice')),
    created_by_profile_id TEXT REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    message_revision INTEGER NOT NULL DEFAULT 0 CHECK(message_revision>=0),
    CHECK(protected_kind IS NULL OR (protected_kind='default_text' AND kind='text') OR (protected_kind='default_voice' AND kind='voice'))
) STRICT;
CREATE TRIGGER protect_channel_delete BEFORE DELETE ON channels WHEN OLD.protected_kind IS NOT NULL BEGIN
    SELECT RAISE(ABORT,'default channel cannot be deleted');
END;
CREATE TRIGGER protect_channel_identity BEFORE UPDATE OF channel_id,kind,protected_kind ON channels BEGIN
    SELECT CASE WHEN NEW.channel_id<>OLD.channel_id OR NEW.kind<>OLD.kind OR NEW.protected_kind IS NOT OLD.protected_kind
        THEN RAISE(ABORT,'channel identity cannot be changed') END;
END;

CREATE TABLE messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    author_profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    author_device_id TEXT NOT NULL,
    request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 64),
    sent_at INTEGER NOT NULL,
    edited_at INTEGER,
    crypto_context_id TEXT NOT NULL CHECK(length(crypto_context_id)=64),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 17 AND 12304),
    FOREIGN KEY(author_device_id,author_profile_id) REFERENCES devices(device_id,original_profile_id) ON DELETE RESTRICT,
    UNIQUE(author_device_id,request_id)
) STRICT;
CREATE INDEX messages_channel_cursor ON messages(channel_id,message_id);
CREATE INDEX messages_author ON messages(author_profile_id,message_id);
CREATE TRIGGER message_insert_revision AFTER INSERT ON messages BEGIN
    UPDATE channels SET message_revision=message_revision+1 WHERE channel_id=NEW.channel_id;
END;
CREATE TRIGGER message_update_revision AFTER UPDATE ON messages BEGIN
    UPDATE channels SET message_revision=message_revision+1 WHERE channel_id=NEW.channel_id;
END;
CREATE TRIGGER message_delete_revision AFTER DELETE ON messages BEGIN
    UPDATE channels SET message_revision=message_revision+1 WHERE channel_id=OLD.channel_id;
END;
CREATE TRIGGER message_text_channel BEFORE INSERT ON messages BEGIN
    SELECT CASE WHEN (SELECT kind FROM channels WHERE channel_id=NEW.channel_id)<>'text'
        THEN RAISE(ABORT,'messages require a text channel') END;
END;
CREATE TRIGGER immutable_author BEFORE UPDATE OF channel_id,author_profile_id,author_device_id,request_id,crypto_context_id,nonce ON messages BEGIN
    SELECT CASE WHEN NEW.channel_id<>OLD.channel_id OR NEW.author_profile_id<>OLD.author_profile_id OR NEW.author_device_id<>OLD.author_device_id OR NEW.request_id<>OLD.request_id OR NEW.crypto_context_id<>OLD.crypto_context_id
        THEN RAISE(ABORT,'message provenance is immutable') END;
END;

CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY CHECK(length(attachment_id)=32),
    channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(message_id) ON DELETE CASCADE,
    owner_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    crypto_context_id TEXT NOT NULL CHECK(length(crypto_context_id)=64),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 17 AND 2097168),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pending_attachments ON attachments(owner_device_id,created_at) WHERE message_id IS NULL;
CREATE TRIGGER attachment_message_insert BEFORE INSERT ON attachments WHEN NEW.message_id IS NOT NULL BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM messages WHERE message_id=NEW.message_id AND channel_id=NEW.channel_id AND author_device_id=NEW.owner_device_id)
        THEN RAISE(ABORT,'attachment message owner/channel mismatch') END;
END;
CREATE TRIGGER attachment_message BEFORE UPDATE OF message_id ON attachments WHEN NEW.message_id IS NOT NULL BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM messages WHERE message_id=NEW.message_id AND channel_id=NEW.channel_id AND author_device_id=NEW.owner_device_id)
        THEN RAISE(ABORT,'attachment message owner/channel mismatch') END;
END;

CREATE TABLE invites (
    invite_id TEXT PRIMARY KEY CHECK(length(invite_id)=32),
    token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32),
    kind TEXT NOT NULL CHECK(kind IN ('single','reusable','bootstrap')),
    created_by_profile_id TEXT REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    max_uses INTEGER CHECK(max_uses IS NULL OR max_uses=1),
    used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count>=0),
    encrypted_key_package BLOB,
    package_digest BLOB,
    UNIQUE(invite_id,kind),
    CHECK(expires_at>created_at),
    CHECK((kind='reusable' AND max_uses IS NULL) OR (kind IN ('single','bootstrap') AND max_uses=1)),
    CHECK(max_uses IS NULL OR used_count<=max_uses),
    CHECK(package_digest IS NULL OR length(package_digest)=32)
) STRICT;
CREATE INDEX invites_active ON invites(kind,expires_at,revoked_at);
CREATE TABLE invite_attempts (
    attempt_id TEXT PRIMARY KEY,
    invite_id TEXT NOT NULL REFERENCES invites(invite_id) ON DELETE RESTRICT,
    invite_kind TEXT NOT NULL CHECK(invite_kind IN ('single','reusable','bootstrap')),
    profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    device_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','confirmed','expired','cancelled')),
    reserved_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    completed_at INTEGER,
    package_digest BLOB,
    FOREIGN KEY(device_id,profile_id) REFERENCES devices(device_id,original_profile_id),
    FOREIGN KEY(invite_id,invite_kind) REFERENCES invites(invite_id,kind),
    UNIQUE(invite_id,device_id),
    UNIQUE(device_id,request_id),
    CHECK(deadline>reserved_at),
    CHECK(package_digest IS NULL OR length(package_digest)=32)
) STRICT;
CREATE UNIQUE INDEX reserved_single_invite ON invite_attempts(invite_id) WHERE state='reserved' AND invite_kind IN ('single','bootstrap');
CREATE TABLE invite_redemptions (
    attempt_id TEXT PRIMARY KEY REFERENCES invite_attempts(attempt_id) ON DELETE RESTRICT,
    profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    redeemed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE voice_slots (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE audit_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_profile_id TEXT REFERENCES profiles(profile_id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    subject_id TEXT,
    created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE mutation_receipts (
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL CHECK(length(request_id)=32),
    action TEXT NOT NULL,
    payload_hash BLOB NOT NULL CHECK(length(payload_hash)=32),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(device_id,request_id)
) STRICT;
PRAGMA user_version=2;
