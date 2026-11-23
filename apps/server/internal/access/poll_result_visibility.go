package access

// ImportedPollResultAllowed expects i to name the imported position row.
// first is a SQL placeholder or a column from the fixed delivery query.
func ImportedPollResultAllowed(first string, retained bool) string {
	original := `SELECT 1 FROM protected_migration_message_positions origin
		JOIN protected_migration_records record ON record.kind='messages'
			AND record.source_id=CAST(origin.message_id AS TEXT) AND record.channel_id=origin.channel_id
		WHERE origin.channel_id=i.channel_id AND origin.message_id=poll.message_id
		AND origin.position>=` + first + ` AND origin.position<i.position`
	if retained {
		original += ` AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d
			WHERE d.channel_id=origin.channel_id AND d.position=origin.position)`
	}
	return `NOT EXISTS(SELECT 1 FROM polls poll WHERE poll.result_message_id=i.message_id AND NOT EXISTS(` + original + `))
		AND NOT EXISTS(SELECT 1 FROM system_messages system WHERE system.message_id=i.message_id AND system.kind='poll-result'
			AND NOT EXISTS(SELECT 1 FROM polls poll WHERE poll.result_message_id=system.message_id))`
}

func pollResultEventFilter(alias, first string, hasImported bool) string {
	// Deletion events can still be delivered for a poll and result that were
	// removed together, with the original history boundary applied first.
	filter := ` AND NOT EXISTS(SELECT 1 FROM protected_poll_results result WHERE result.channel_id=` + alias + `.channel_id
		AND result.position=` + alias + `.position AND result.original_position<` + first + `)`
	if !hasImported {
		return filter
	}
	return filter + ` AND NOT EXISTS(SELECT 1 FROM protected_migration_message_positions i
		WHERE i.channel_id=` + alias + `.channel_id AND i.position=` + alias + `.position
		AND NOT (` + ImportedPollResultAllowed(first, false) + `))`
}
