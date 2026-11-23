package access

import (
	"maps"
	"slices"
)

func orderedResources[T any](stored []string, resources map[string]T) []string {
	order := make([]string, 0, len(resources))
	seen := make(map[string]bool, len(resources))
	for _, id := range stored {
		if _, exists := resources[id]; exists && !seen[id] {
			order = append(order, id)
			seen[id] = true
		}
	}
	for _, id := range slices.Sorted(maps.Keys(resources)) {
		if !seen[id] {
			order = append(order, id)
		}
	}
	return order
}

// Move only the editable subsequence. Resources outside that subsequence keep
// their exact slots, including hidden resources between the visible anchors.
func moveWithinOrder(order []string, source, anchor string, after bool, editable func(string) bool) ([]string, error) {
	var positions []int
	var moving []string
	for i, id := range order {
		if editable(id) {
			positions = append(positions, i)
			moving = append(moving, id)
		}
	}
	sourceIndex, anchorIndex := slices.Index(moving, source), slices.Index(moving, anchor)
	if sourceIndex < 0 || anchorIndex < 0 {
		return nil, ChannelRestricted
	}
	if source == anchor {
		return nil, InvalidAction
	}
	moving = slices.Delete(moving, sourceIndex, sourceIndex+1)
	index := slices.Index(moving, anchor)
	if after {
		index++
	}
	moving = slices.Insert(moving, index, source)
	for index, position := range positions {
		order[position] = moving[index]
	}
	return order, nil
}

func (s State) editableChannelOrder(actorID, source string, mixed bool) (func(string) bool, error) {
	channel, exists := s.Channels[source]
	if !exists {
		return nil, ChannelRestricted
	}
	actor := s.Members[actorID]
	return func(id string) bool {
		item := s.Channels[id]
		return item.CategoryID == channel.CategoryID && (mixed || channel.CategoryID != "" || channel.Kind == item.Kind) &&
			s.CheckGrant(actor, s.scope(item), "channel.edit", 0) == Allowed
	}, nil
}

func (s *State) reorderChannel(actorID, source, anchor string, after, mixed bool) error {
	editable, err := s.editableChannelOrder(actorID, source, mixed)
	if err != nil {
		return err
	}
	order, err := moveWithinOrder(orderedResources(s.ChannelOrder, s.Channels), source, anchor, after, editable)
	if err == nil {
		s.ChannelOrder = order
	}
	return err
}

func (s *State) reorderCategory(actorID, source, anchor string, after bool) error {
	actor := s.Members[actorID]
	order, err := moveWithinOrder(orderedResources(s.CategoryOrder, s.Categories), source, anchor, after, func(id string) bool {
		acl := s.Categories[id]
		return s.categoryVisible(actor, id) && s.CheckGrant(actor, Scope{Kind: "category", Local: &acl}, "channel.edit", 0) == Allowed
	})
	if err == nil {
		s.CategoryOrder = order
	}
	return err
}
