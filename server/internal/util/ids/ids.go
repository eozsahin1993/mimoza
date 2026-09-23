// Package ids says what the relay accepts as a client-minted id.
//
// These become sort keys and object keys, so the shape matters. Clients
// use a content hash, which is what makes a cover or avatar URL safe to
// cache forever; the relay never computes one, and only checks that an
// id is safe to put in a key.
package ids

// MaxLength fits any digest in use with room to spare.
const MaxLength = 128

// Valid reports whether an id is safe as a key segment: nothing that
// could carry a slash into a key, start with a dot, or arrive empty.
func Valid(id string) bool {
	if id == "" || len(id) > MaxLength || id[0] == '.' {
		return false
	}
	for i := range len(id) {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-', c == '_', c == '.':
		default:
			return false
		}
	}
	return true
}
