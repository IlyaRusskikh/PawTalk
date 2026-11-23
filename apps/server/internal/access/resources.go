package access

import (
	"context"
	"maps"
	"slices"
	"unicode"
	"unicode/utf8"
)

type MoveAccess string

const (
	PreserveAccess    MoveAccess = "preserve"
	SynchronizeAccess MoveAccess = "synchronize"
	KeepChildren      MoveAccess = "keep_children"
	DeleteChildren    MoveAccess = "delete_children"
)

type ChannelSettings struct {
	Name            string
	Description     string
	SlowmodeSeconds uint32
	VoiceCapacity   uint32
}

func (s ChannelSettings) valid(kind string) bool {
	if !validResourceName(s.Name) || !utf8.ValidString(s.Description) {
		return false
	}
	return kind == "text" && s.VoiceCapacity == 0 && s.SlowmodeSeconds <= 6*60*60 ||
		kind == "voice" && s.SlowmodeSeconds == 0
}

func validResourceName(name string) bool {
	length := utf8.RuneCountInString(name)
	if length < 1 || length > 64 || !utf8.ValidString(name) {
		return false
	}
	for _, char := range name {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

type ChannelDefinition struct {
	Kind     string
	Settings ChannelSettings
}

func (s *Store) CreateCategory(ctx context.Context, revision int64, actorID, id string) (int64, error) {
	return s.change(ctx, revision, actorID, func(state *State) error {
		return state.createCategory(actorID, id)
	})
}

func (s *State) createCategory(actorID, id string) error {
	if result := s.CheckGrant(s.Members[actorID], Scope{}, "channel.create", 0); result != Allowed {
		return result
	}
	if _, exists := s.Categories[id]; id == "" || exists {
		return InvalidPolicy
	}
	if s.Categories == nil {
		s.Categories = make(map[string]ACL)
	}
	s.Categories[id] = ACL{}
	if s.CategoryCreators == nil {
		s.CategoryCreators = make(map[string]string)
	}
	s.CategoryCreators[id] = actorID
	return nil
}

func (s *State) renameCategory(actorID, id, name string) error {
	acl, exists := s.Categories[id]
	actor := s.Members[actorID]
	if !exists || !s.categoryVisible(actor, id) {
		return ChannelRestricted
	}
	if result := s.CheckGrant(actor, Scope{Kind: "category", Local: &acl}, "channel.edit", 0); result != Allowed {
		return result
	}
	if !validResourceName(name) {
		return InvalidPolicy
	}
	s.setCategoryName(id, name)
	return nil
}

func (s *State) setCategoryName(id, name string) {
	if s.CategoryNames == nil {
		s.CategoryNames = make(map[string]string)
	}
	s.CategoryNames[id] = name
}

func (s *State) copyCategory(actorID, id, source, name string) error {
	acl, exists := s.Categories[source]
	actor := s.Members[actorID]
	if !exists || !s.categoryVisible(actor, source) {
		return ChannelRestricted
	}
	if !validResourceName(name) {
		return InvalidPolicy
	}
	empty := Scope{Kind: "category", Local: &ACL{}}
	if result := s.CheckGrant(actor, empty, "channel.access.edit", 0); result != Allowed {
		return result
	}
	if err := s.checkACLChange(actor, empty, Scope{Kind: "category", Local: &acl}, false); err != nil {
		return err
	}
	if err := s.createCategory(actorID, id); err != nil {
		return err
	}
	s.Categories[id] = ACL{Roles: maps.Clone(acl.Roles), Profiles: maps.Clone(acl.Profiles)}
	s.setCategoryName(id, name)
	return nil
}

func (s State) canPopulateCategory(actor Subject, id string) bool {
	if s.categoryVisible(actor, id) {
		return true
	}
	if actor.ID != s.CategoryCreators[id] {
		return false
	}
	for _, channel := range s.Channels {
		if channel.CategoryID == id {
			return false
		}
	}
	return true
}

func (s State) canCreateChannel(actor Subject, id, categoryID string) error {
	if _, exists := s.Channels[id]; !validRotationID(id) || exists || s.RetiredChannels[id] || len(s.Channels) >= 1000 {
		return InvalidPolicy
	}
	scope := Scope{}
	if categoryID != "" {
		acl, exists := s.Categories[categoryID]
		if !exists || !s.canPopulateCategory(actor, categoryID) {
			return ChannelRestricted
		}
		scope = Scope{Kind: "category", Local: &acl}
	}
	if result := s.CheckGrant(actor, scope, "channel.create", 0); result != Allowed {
		return result
	}
	return nil
}

func (s *State) addChannel(id string, channel Channel) {
	channel.NextPosition = 1
	if s.Channels == nil {
		s.Channels = make(map[string]Channel)
	}
	s.Channels[id] = channel
}

func (s *State) createChannel(actorID, id, category string, definition ChannelDefinition, acl *ACL) error {
	actor := s.Members[actorID]
	if err := s.canCreateChannel(actor, id, category); err != nil {
		return err
	}
	if !definition.Settings.valid(definition.Kind) {
		return InvalidPolicy
	}
	channel := Channel{Kind: definition.Kind, CategoryID: category, Synchronized: category != "", Settings: &definition.Settings}
	if acl != nil {
		before := s.scope(channel)
		if result := s.CheckGrant(actor, before, "channel.access.edit", 0); result != Allowed {
			return result
		}
		if !s.validACL(*acl, channel.Kind) {
			return InvalidPolicy
		}
		channel.Synchronized, channel.ACL = false, *acl
		if err := s.checkACLChange(actor, before, s.scope(channel), false); err != nil {
			return err
		}
	}
	s.addChannel(id, channel)
	return nil
}

func (s *State) copyChannel(actorID, id, source string) error {
	channel, exists := s.Channels[source]
	actor := s.Members[actorID]
	if !exists || s.CheckGrant(actor, s.scope(channel), ChannelView, 0) != Allowed {
		return ChannelRestricted
	}
	if err := s.canCreateChannel(actor, id, channel.CategoryID); err != nil {
		return err
	}
	s.addChannel(id, channel)
	return nil
}

func (s *State) editChannel(actorID, id string, settings ChannelSettings) error {
	channel, exists := s.Channels[id]
	if !exists {
		return ChannelRestricted
	}
	if result := s.CheckGrant(s.Members[actorID], s.scope(channel), "channel.edit", 0); result != Allowed {
		return result
	}
	if !settings.valid(channel.Kind) {
		return InvalidPolicy
	}
	channel.Settings = &settings
	s.Channels[id] = channel
	return nil
}

func (s *State) removeChannel(id string) {
	delete(s.Channels, id)
	s.ChannelOrder = slices.DeleteFunc(s.ChannelOrder, func(ordered string) bool { return ordered == id })
	delete(s.VoiceRestrictions, id)
	if s.RetiredChannels == nil {
		s.RetiredChannels = make(map[string]bool)
	}
	s.RetiredChannels[id] = true
}

func (s *State) deleteChannel(actorID, id string) error {
	channel, exists := s.Channels[id]
	if !exists {
		return ChannelRestricted
	}
	if result := s.CheckGrant(s.Members[actorID], s.scope(channel), "channel.delete", 0); result != Allowed {
		return result
	}
	s.removeChannel(id)
	return nil
}

func (s *Store) MoveChannel(ctx context.Context, revision int64, actorID, id, categoryID string, mode MoveAccess) (int64, error) {
	return s.change(ctx, revision, actorID, func(state *State) error {
		return state.moveChannel(actorID, id, categoryID, mode)
	})
}

func (state *State) moveChannel(actorID, id, categoryID string, mode MoveAccess) error {
	channel, exists := state.Channels[id]
	if !exists {
		return ChannelRestricted
	}
	actor := state.Members[actorID]
	before := state.scope(channel)
	if result := state.CheckGrant(actor, before, "channel.edit", 0); result != Allowed {
		return result
	}
	destination, hasCategory := state.Categories[categoryID]
	if categoryID != "" {
		scope := Scope{Kind: "category", Local: &destination}
		if !hasCategory || !state.categoryVisible(actor, categoryID) ||
			state.CheckGrant(actor, scope, "channel.edit", 0) != Allowed {
			return ChannelRestricted
		}
	}
	channel.CategoryID = categoryID
	switch mode {
	case PreserveAccess:
		channel.Synchronized, channel.ACL = false, channelRules(*before.effectiveACL(), channel.Kind)
	case SynchronizeAccess:
		if !hasCategory {
			return InvalidPolicy
		}
		if result := state.CheckGrant(actor, before, "channel.access.edit", 0); result != Allowed {
			return result
		}
		channel.Synchronized, channel.ACL = true, ACL{}
		if err := state.checkACLChange(actor, before, state.scope(channel), false); err != nil {
			return err
		}
	default:
		return InvalidPolicy
	}
	state.Channels[id] = channel
	return nil
}

func (s *Store) DeleteCategory(ctx context.Context, revision int64, actorID, categoryID string, deleteChildren bool) (int64, error) {
	return s.change(ctx, revision, actorID, func(state *State) error {
		return state.deleteCategory(actorID, categoryID, deleteChildren)
	})
}

func (state *State) deleteCategory(actorID, categoryID string, deleteChildren bool) error {
	acl, exists := state.Categories[categoryID]
	actor := state.Members[actorID]
	if !exists || !state.categoryVisible(actor, categoryID) {
		return ChannelRestricted
	}
	if result := state.CheckGrant(actor, Scope{Kind: "category", Local: &acl}, "channel.delete", 0); result != Allowed {
		return result
	}
	for id, channel := range state.Channels {
		if channel.CategoryID != categoryID {
			continue
		}
		if deleteChildren {
			if result := state.CheckGrant(actor, state.scope(channel), "channel.delete", 0); result != Allowed {
				return result
			}
			state.removeChannel(id)
			continue
		}
		if channel.Synchronized {
			channel.ACL = channelRules(acl, channel.Kind)
		}
		channel.CategoryID, channel.Synchronized = "", false
		state.Channels[id] = channel
	}
	delete(state.Categories, categoryID)
	delete(state.CategoryCreators, categoryID)
	delete(state.CategoryNames, categoryID)
	state.CategoryOrder = slices.DeleteFunc(state.CategoryOrder, func(ordered string) bool { return ordered == categoryID })
	return nil
}

func (s State) categoryVisible(actor Subject, id string) bool {
	if actor.Active && (s.owner(actor) || s.baseGrant(actor, Administrator)) {
		return true
	}
	for _, channel := range s.Channels {
		if channel.CategoryID == id && s.CheckGrant(actor, s.scope(channel), ChannelView, 0) == Allowed {
			return true
		}
	}
	return false
}
