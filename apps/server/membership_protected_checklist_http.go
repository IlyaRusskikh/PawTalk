package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

func resolveImportedChecklist(ctx context.Context, query access.SessionQuery, channel string, position uint64) (access.ChecklistDefinition, error) {
	var definition access.ChecklistDefinition
	var items, checked string
	err := query.QueryRowContext(ctx, `SELECT COALESCE(b.target_profile_id,m.author_profile_id),c.everyone,c.item_ids,c.checked
		FROM protected_migration_message_positions i
		JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
		JOIN checklists c ON c.message_id=m.message_id
		JOIN protected_migration_records r ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
		LEFT JOIN profile_bindings b ON b.source_profile_id=m.author_profile_id
		WHERE i.channel_id=? AND i.position=?
		AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)`,
		channel, position).Scan(&definition.Author, &definition.Everyone, &items, &checked)
	if err != nil {
		return definition, err
	}
	if err = json.Unmarshal([]byte(items), &definition.Items); err != nil {
		return definition, err
	}
	err = json.Unmarshal([]byte(checked), &definition.Checked)
	return definition, err
}

func (p *protectedRuntime) checklistHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	position, err := strconv.ParseUint(r.PathValue("position"), 10, 64)
	if err != nil || position == 0 || position >= uint64(migrationMaxSafePosition) || !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var lookup access.ResolveChecklist
	if p.importedProfileNames != nil {
		lookup = resolveImportedChecklist
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	resolve := p.resolveSession(memberBearer(r))
	if r.Method == http.MethodGet {
		var sent bool
		err = store.DispatchChecklist(r.Context(), resolve, lookup, channel, position, func(state access.ChecklistState) error {
			return writeProtectedDelivery(w, &sent, state)
		})
		if err != nil && !sent {
			protectedRuntimeFail(w, err)
		}
		return
	}
	var input struct {
		OperationID string `json:"operationId"`
		Item        string `json:"item"`
		Checked     *bool  `json:"checked"`
	}
	if _, err := decodeMemberJSON(w, r, 512, &input); err != nil {
		memberFail(w, err)
		return
	}
	if input.Checked == nil {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	state, err := store.ChangeChecklist(r.Context(), resolve, lookup, channel, position,
		access.ChecklistChange{OperationID: input.OperationID, Item: input.Item, Checked: *input.Checked})
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, state)
}
