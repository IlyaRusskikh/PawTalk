package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"strings"
	"unicode"
)

type MentionTarget struct {
	Kind string `json:"kind"`
	ID   string `json:"id,omitempty"`
}

type MentionRouting struct {
	Salt    string          `json:"salt"`
	Targets []MentionTarget `json:"targets"`
}

func EnsureMentionSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_message_mentions (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(channel_id,position),
		FOREIGN KEY(channel_id,position) REFERENCES protected_messages(channel_id,position) ON DELETE CASCADE
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_mention_presence (
		device_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, touched_at INTEGER NOT NULL
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_mention_presence_age ON protected_mention_presence(touched_at);
	CREATE TABLE IF NOT EXISTS protected_mention_alerts (
		sequence INTEGER PRIMARY KEY AUTOINCREMENT, cursor TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
		position INTEGER NOT NULL, profile_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
		sent_at INTEGER NOT NULL, UNIQUE(channel_id,position,profile_id),
		FOREIGN KEY(channel_id,position) REFERENCES protected_message_mentions(channel_id,position) ON DELETE CASCADE
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_mention_alerts_inbox ON protected_mention_alerts(profile_id,sequence);
	CREATE INDEX IF NOT EXISTS protected_mention_alerts_age ON protected_mention_alerts(sent_at)`)
	return err
}

func (routing *MentionRouting) matchesDigest(digest string) bool {
	if routing == nil {
		return digest == ""
	}
	if len(digest) != 64 || len(routing.Salt) != 64 || strings.Trim(routing.Salt, "0123456789abcdef") != "" ||
		len(routing.Targets) < 1 || len(routing.Targets) > 64 {
		return false
	}
	fields := []string{"pawtalk-protected-mentions-v1", routing.Salt}
	seen := make(map[MentionTarget]bool, len(routing.Targets))
	for _, target := range routing.Targets {
		if !target.valid() || seen[target] {
			return false
		}
		seen[target] = true
		fields = append(fields, target.Kind, target.ID)
	}
	frame, err := SignatureFrame(fields...)
	if err != nil {
		return false
	}
	sum := sha256.Sum256(frame)
	return digest == hex.EncodeToString(sum[:])
}

func (target MentionTarget) valid() bool {
	switch target.Kind {
	case "profile":
		return len(target.ID) == 64 && strings.Trim(target.ID, "0123456789abcdef") == ""
	case "role":
		return len(target.ID) > 0 && len(target.ID) <= 128 && target.ID != Everyone && strings.IndexFunc(target.ID, unicode.IsControl) < 0
	case "everyone", "online":
		return target.ID == ""
	default:
		return false
	}
}

func (s State) checkMessageMentions(actor Subject, scope Scope, channelID string, now int64, routing *MentionRouting) Decision {
	if routing == nil {
		return Allowed
	}
	for _, target := range routing.Targets {
		switch target.Kind {
		case "profile":
			if !s.CanDeliver(target.ID, channelID, 0) {
				return ChannelRestricted
			}
		case "role":
			if _, exists := s.Roles[target.ID]; !exists {
				return MissingGrant
			}
			if !s.RolePresentation[target.ID].Mentionable {
				if decision := s.CheckGrant(actor, scope, "mention.any-role", now); decision != Allowed {
					return decision
				}
			}
		case "everyone", "online":
			if decision := s.CheckGrant(actor, scope, "mention.mass", now); decision != Allowed {
				return decision
			}
		}
	}
	return Allowed
}

func insertMessageMentions(ctx context.Context, tx *sql.Tx, state State, principal Principal, attempt MessageAttempt, position uint64, now int64) error {
	if attempt.MentionRouting == nil {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_message_mentions(channel_id,position,digest) VALUES(?,?,?)`,
		attempt.ChannelID, position, attempt.MentionDigest); err != nil {
		return err
	}
	return insertMentionAlerts(ctx, tx, state, principal, attempt, position, now)
}
