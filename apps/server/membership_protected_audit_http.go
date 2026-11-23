package main

import (
	"context"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) readAuditHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	names := access.AuditNames{Channels: p.importedChannelNames, Roles: p.importedRoleNames,
		Member: func(ctx context.Context, query access.SessionQuery, id string) (string, error) {
			name, err := protectedMemberNickname(ctx, query, id)
			if name == "" {
				name = p.importedProfileNames[id]
			}
			return name, err
		}}
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchAuditWithNames(r.Context(), p.resolveSession(memberBearer(r)),
		r.URL.Query().Get("before"), p.importedProfileNames != nil, names, func(page access.AuditPage) error {
			return writeProtectedDelivery(w, &sent, page)
		})
	if err != nil && !sent {
		if errors.Is(err, access.ErrAuditCursor) {
			err = memberError(http.StatusConflict, "PROTECTED_AUDIT_CURSOR_EXPIRED")
		}
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) auditRetentionHTTP(w http.ResponseWriter, r *http.Request) {
	var request access.AuditRetentionRequest
	if _, err := decodeMemberJSON(w, r, 1024, &request); err != nil {
		memberFail(w, err)
		return
	}
	err := access.NewStoreWithClock(p.store.db, p.store.now).ChangeAuditRetention(r.Context(),
		p.resolveSession(memberBearer(r)), request)
	if errors.Is(err, access.ErrAuditRetentionChanged) {
		err = memberError(http.StatusConflict, "PROTECTED_AUDIT_RETENTION_CHANGED")
	} else if errors.Is(err, access.ErrAuditRetentionConfirmation) {
		err = memberError(http.StatusConflict, "PROTECTED_AUDIT_CONFIRM_RETENTION")
	}
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}
