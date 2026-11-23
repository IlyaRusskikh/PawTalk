package main

import (
	"context"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

// Scope is checked by the caller in the same policy transaction before
// looking up names of effective profiles that are visible there.
func protectedMemberNickname(ctx context.Context, query access.SessionQuery, profile string) (string, error) {
	var name string
	err := query.QueryRowContext(ctx, `SELECT COALESCE(
		(SELECT name FROM protected_nicknames WHERE profile_id=?),
		(SELECT json_extract(CAST(request AS TEXT),'$.nickname') FROM protected_invite_admissions WHERE profile_id=?),
		(SELECT nickname FROM effective_profiles WHERE profile_id=?),'')`, profile, profile, profile).Scan(&name)
	return name, err
}

func (p *protectedRuntime) readNicknameHTTP(w http.ResponseWriter, r *http.Request) {
	profile, channel := r.PathValue("profile"), r.URL.Query().Get("channel")
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchNickname(r.Context(), p.resolveSession(memberBearer(r)),
		profile, channel, func(query access.SessionQuery, current access.NicknameState) error {
			if current.Revision == 0 {
				var err error
				current.Name, err = protectedMemberNickname(r.Context(), query, profile)
				if err != nil {
					return err
				}
			}
			return writeProtectedDelivery(w, &sent, current)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) changeNicknameHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.NicknameUpdate
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	result, err := access.NewStoreWithClock(p.store.db, p.store.now).ChangeNickname(r.Context(), p.resolveSession(memberBearer(r)),
		r.PathValue("profile"), input)
	if errors.Is(err, access.ErrNicknameChanged) {
		err = memberError(http.StatusConflict, "REVISION_CONFLICT")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, result)
}
