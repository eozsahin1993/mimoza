package apns

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"mimoza-relay/internal/push"
)

const (
	productionHost = "https://api.push.apple.com"
	sandboxHost    = "https://api.sandbox.push.apple.com"
)

// Sender posts to Apple's HTTP/2 provider API. net/http negotiates HTTP/2
// over TLS on its own; nothing here has to ask for it.
type Sender struct {
	Topic      string // apns-topic: the app's bundle id
	Production bool
	Client     *http.Client
	tokens     *tokenSource
}

type sendRequest struct {
	APS aps `json:"aps"`
	// See fcm.Sender.Send for why these three are safe to name.
	PushRoutingID string `json:"pushRoutingId"`
	// Lets the extension pick its own line without decrypting.
	Kind       push.PushKind `json:"kind"`
	KeyVersion int64         `json:"keyVersion"`
	Payload    string        `json:"payload"`
}

type aps struct {
	Alert string `json:"alert"`
	// int, not bool: APNs' own field is 1/0, and Apple's docs give it as
	// a number.
	MutableContent int `json:"mutable-content"`
}

// New builds a Sender from a loaded auth key.
func New(key *AuthKey, topic string, production bool) *Sender {
	return &Sender{
		Topic:      topic,
		Production: production,
		Client:     &http.Client{Timeout: 10 * time.Second},
		tokens:     &tokenSource{key: key},
	}
}

func (s *Sender) host() string {
	if s.Production {
		return productionHost
	}
	return sandboxHost
}

// Send delivers one alert push to one device token.
//
// mutable-content, never content-available: a silent push is budgeted,
// deprioritized in Low Power Mode, and dropped after a force-quit. The
// alert is the kind's fixed line — the
// Notification Service Extension rewrites it after decrypting, since the
// relay cannot compose real text from ciphertext it can't read.
func (s *Sender) Send(ctx context.Context, deviceToken, pushRoutingID string, kind push.PushKind, keyVersion int64, payload []byte) error {
	token, err := s.tokens.providerToken()
	if err != nil {
		return err
	}

	body, err := json.Marshal(sendRequest{
		APS:           aps{Alert: kind.Alert(), MutableContent: 1},
		PushRoutingID: pushRoutingID,
		Kind:          kind,
		KeyVersion:    keyVersion,
		Payload:       base64.StdEncoding.EncodeToString(payload),
	})
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/3/device/%s", s.host(), deviceToken)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "bearer "+token)
	req.Header.Set("apns-topic", s.Topic)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")

	resp, err := s.Client.Do(req)
	if err != nil {
		return fmt.Errorf("send push: %w", err)
	}
	defer resp.Body.Close()

	// The body can name the device token, so only the status is reported.
	// A 400/410 here usually means the token is stale; nothing prunes them
	// yet, same as fcm.Sender.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("send push: %s", resp.Status)
	}
	return nil
}
