package invites

import (
	"crypto/rand"
	"math/big"
)

// alphabet leaves out the characters people confuse when reading a code
// aloud or typing it: 0/O, 1/I/l. 32 symbols exactly, so drawing from it
// is unbiased. Matches the client's INVITE_CODE_ALPHABET.
const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// codeLength of 12 over this alphabet is about 60 bits: short enough to
// read out, far too long to guess.
const codeLength = 12

func newCode() string {
	code := make([]byte, codeLength)
	for i := range code {
		// crypto/rand.Int is documented never to fail for a positive max.
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		code[i] = alphabet[n.Int64()]
	}
	return string(code)
}
