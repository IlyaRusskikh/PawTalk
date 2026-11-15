package main

import "net/http"

func (a *membershipAPI) linkRequest(w http.ResponseWriter, r *http.Request, target any) (membershipProof, []byte, error) {
	raw, err := decodeMemberJSON(w, r, 8192, target)
	if err != nil {
		return membershipProof{}, nil, err
	}
	proof, err := a.requestProof(r)
	return proof, raw, err
}
func (a *membershipAPI) startLink(w http.ResponseWriter, r *http.Request) {
	var input memberLinkStart
	proof, raw, err := a.linkRequest(w, r, &input)
	if err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.startLink(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, input)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 201, result)
}
func (a *membershipAPI) proposeLink(w http.ResponseWriter, r *http.Request) {
	var input memberLinkProposal
	proof, raw, err := a.linkRequest(w, r, &input)
	if err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.proposeLink(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, r.PathValue("id"), input)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}
func (a *membershipAPI) approveLink(w http.ResponseWriter, r *http.Request) {
	var input memberLinkApproval
	proof, raw, err := a.linkRequest(w, r, &input)
	if err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.approveLink(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, r.PathValue("id"), input)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}
func (a *membershipAPI) acceptLink(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Signature string `json:"signature"`
	}
	proof, raw, err := a.linkRequest(w, r, &input)
	if err != nil {
		memberFail(w, err)
		return
	}
	targets := a.store.captureLinkMedia(r.Context(), r.PathValue("id"))
	result, err := a.store.acceptLink(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, r.PathValue("id"), input.Signature)
	if err != nil {
		memberFail(w, err)
		return
	}
	a.removeTargets(r.Context(), targets)
	respond(w, 200, result)
}
func (a *membershipAPI) linkStatus(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	proof, raw, err := a.linkRequest(w, r, &input)
	if err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.linkStatus(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, r.PathValue("id"))
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}
func (a *membershipAPI) transferControl(w http.ResponseWriter, r *http.Request) {
	var input memberControlInput
	if _, err := decodeMemberJSON(w, r, 4096, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.transferControl(r.Context(), memberBearer(r), input); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) unlinkDevice(w http.ResponseWriter, r *http.Request) {
	a.endDevice(w, r, false)
}
func (a *membershipAPI) revokeDevice(w http.ResponseWriter, r *http.Request) { a.endDevice(w, r, true) }
func (a *membershipAPI) endDevice(w http.ResponseWriter, r *http.Request, revoke bool) {
	var input struct {
		RequestID string `json:"requestId"`
	}
	proof, raw, err := a.linkRequest(w, r, &input)
	if err != nil {
		memberFail(w, err)
		return
	}
	var targets []memberMediaTarget
	if revoke {
		targets = a.store.captureDeviceMedia(r.Context(), r.PathValue("id"))
	}
	if err = a.store.unlinkDevice(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, r.PathValue("id"), input.RequestID, revoke); err != nil {
		memberFail(w, err)
		return
	}
	if revoke {
		a.removeTargets(r.Context(), targets)
	}
	respond(w, 200, map[string]bool{"ok": true})
}
