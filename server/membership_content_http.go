package main

import (
	"net/http"
	"strconv"
	"strings"
)

func (a *membershipAPI) createChannel(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Kind      string `json:"kind"`
		Name      string `json:"name"`
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	id, err := a.store.createChannel(r.Context(), memberBearer(r), input.Kind, input.Name, input.RequestID)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 201, map[string]string{"id": id})
}
func (a *membershipAPI) patchChannel(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name      string `json:"name"`
		Position  int    `json:"position"`
		Revision  int64  `json:"expectedRevision"`
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.patchChannel(r.Context(), memberBearer(r), r.PathValue("id"), input.Name, input.RequestID, input.Position, input.Revision); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) deleteChannel(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &input); err != nil {
		memberFail(w, err)
		return
	}
	room := a.store.channelRoom(r.Context(), r.PathValue("id"))
	if err := a.store.deleteChannel(r.Context(), memberBearer(r), r.PathValue("id"), input.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	if room != "" {
		a.mediaRPC(r.Context(), room, "DeleteRoom", map[string]string{"room": room})
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func pageNumber(r *http.Request, key string, fallback int64) (int64, error) {
	values := r.URL.Query()[key]
	if len(values) == 0 {
		return fallback, nil
	}
	if len(values) != 1 {
		return 0, memberError(400, "INVALID_PAGE")
	}
	n, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || n < 0 {
		return 0, memberError(400, "INVALID_PAGE")
	}
	return n, nil
}
func (a *membershipAPI) messages(w http.ResponseWriter, r *http.Request) {
	limit, err := pageNumber(r, "limit", 100)
	if err != nil {
		memberFail(w, err)
		return
	}
	before, err := pageNumber(r, "before", 0)
	if err != nil {
		memberFail(w, err)
		return
	}
	after, err := pageNumber(r, "after", 0)
	if err != nil {
		memberFail(w, err)
		return
	}
	read, err := pageNumber(r, "readAfter", 0)
	if err != nil {
		memberFail(w, err)
		return
	}
	around, err := pageNumber(r, "around", 0)
	if err != nil {
		memberFail(w, err)
		return
	}
	selection := memberMessageSelection{Around: around}
	if raw := r.URL.Query().Get("ids"); raw != "" {
		parts := strings.Split(raw, ",")
		if len(parts) > 500 {
			memberFail(w, memberError(400, "INVALID_PAGE"))
			return
		}
		for _, part := range parts {
			id, err := strconv.ParseInt(part, 10, 64)
			if err != nil || id < 1 {
				memberFail(w, memberError(400, "INVALID_PAGE"))
				return
			}
			selection.IDs = append(selection.IDs, id)
		}
	}
	page, err := a.store.messagePage(r.Context(), memberBearer(r), r.PathValue("id"), int(limit), before, after, read, selection)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, page)
}
func (a *membershipAPI) postMessage(w http.ResponseWriter, r *http.Request) {
	var input memberMessageInput
	if _, err := decodeMemberJSON(w, r, 50000, &input); err != nil {
		memberFail(w, err)
		return
	}
	id, err := a.store.postMessage(r.Context(), memberBearer(r), r.PathValue("id"), input)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 201, map[string]int64{"id": id})
}
func (a *membershipAPI) editMessage(w http.ResponseWriter, r *http.Request) {
	var input memberMessageInput
	if _, err := decodeMemberJSON(w, r, 20000, &input); err != nil {
		memberFail(w, err)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		memberFail(w, memberError(400, "INVALID_MESSAGE"))
		return
	}
	if err = a.store.editMessage(r.Context(), memberBearer(r), id, input); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) deleteMessage(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &input); err != nil {
		memberFail(w, err)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		memberFail(w, memberError(400, "INVALID_MESSAGE"))
		return
	}
	if err = a.store.deleteMessage(r.Context(), memberBearer(r), id, input.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) putAttachment(w http.ResponseWriter, r *http.Request) {
	var input memberInvitePackage
	if _, err := decodeMemberJSON(w, r, 3*1024*1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.putAttachment(r.Context(), memberBearer(r), r.PathValue("id"), r.PathValue("attachment"), input); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 201, map[string]bool{"ok": true})
}
func (a *membershipAPI) attachment(w http.ResponseWriter, r *http.Request) {
	packet, author, err := a.store.attachment(r.Context(), memberBearer(r), r.PathValue("id"), r.PathValue("attachment"))
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]any{"packet": packet, "authorProfileId": author})
}
func (a *membershipAPI) joinVoice(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ChannelID string `json:"channelId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &input); err != nil {
		memberFail(w, err)
		return
	}
	cfg := a.cfg
	if local, ok := r.Context().Value(mediaURLKey{}).(string); ok {
		cfg.LivekitURL = local
	}
	result, err := a.store.joinVoice(r.Context(), memberBearer(r), input.ChannelID, cfg)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}
func (a *membershipAPI) leaveVoice(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if _, err := decodeMemberJSON(w, r, 64, &input); err != nil {
		memberFail(w, err)
		return
	}
	room, identity, err := a.store.leaveVoice(r.Context(), memberBearer(r))
	if err != nil {
		memberFail(w, err)
		return
	}
	a.removeMedia(r.Context(), room, identity)
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) voiceHeartbeat(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if _, err := decodeMemberJSON(w, r, 64, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.voiceHeartbeat(r.Context(), memberBearer(r)); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *membershipAPI) patchProfile(w http.ResponseWriter, r *http.Request) {
	var input memberProfilePatch
	if _, err := decodeMemberJSON(w, r, 20000, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.patchProfile(r.Context(), memberBearer(r), input); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *membershipAPI) reorderChannels(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Kind      string             `json:"kind"`
		RequestID string             `json:"requestId"`
		Items     []channelOrderItem `json:"items"`
	}
	if _, err := decodeMemberJSON(w, r, 100000, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.reorderChannels(r.Context(), memberBearer(r), input.Kind, input.RequestID, input.Items); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
