package access

import (
	"bytes"
	"encoding/binary"
	"errors"
)

func SignatureFrame(fields ...string) ([]byte, error) {
	var out bytes.Buffer
	for _, field := range fields {
		if out.Len()+4+len(field) > 65536 {
			return nil, errors.New("signature frame too large")
		}
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(field)))
		out.Write(length[:])
		out.WriteString(field)
	}
	return out.Bytes(), nil
}
