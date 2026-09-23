// Package apns delivers one notification to one iPhone through Apple's
// HTTP/2 provider API.
package apns

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"mimoza-relay/internal/notify"
)

const (
	productionHost = "https://api.push.apple.com"
	sandboxHost    = "https://api.sandbox.push.apple.com"
)

// Sender posts to Apple's provider API. net/http negotiates HTTP/2 over
// TLS on its own; nothing here has to ask for it.
type Sender struct {
	Topic      string // apns-topic: the app's bundle id
	Production bool
	Client     *http.Client
	tokens     *tokenSource
}

type sendRequest struct {
	APS aps `json:"aps"`
	// Data rides beside the alert so a tap can open the right screen
	// without unpacking the card.
	Data map[string]string `json:"data,omitempty"`
}

type aps struct {
	Alert *alert `json:"alert,omitempty"`
	// A silent push carries no card: it wakes the app to sync.
	ContentAvailable int `json:"content-available,omitempty"`
}

// alert is localization keys, not text. iOS resolves them against the
// app's own Localizable.strings, which is why no extension is needed to
// make a card readable.
type alert struct {
	TitleLocKey  string   `json:"title-loc-key,omitempty"`
	TitleLocArgs []string `json:"title-loc-args,omitempty"`
	LocKey       string   `json:"loc-key,omitempty"`
	LocArgs      []string `json:"loc-args,omitempty"`
}

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

// Send delivers one message to one device token.
func (s *Sender) Send(ctx context.Context, deviceToken string, message notify.Message) error {
	token, err := s.tokens.providerToken()
	if err != nil {
		return err
	}

	request := sendRequest{Data: message.Data}
	pushType, priority := "alert", "10"
	if message.Silent {
		request.APS.ContentAvailable = 1
		// Apple throttles these and drops them after a force quit, which
		// is why nothing user-visible depends on one arriving.
		pushType, priority = "background", "5"
	} else {
		request.APS.Alert = &alert{
			TitleLocKey:  message.TitleKey,
			TitleLocArgs: message.Args,
			LocKey:       message.BodyKey,
			LocArgs:      message.Args,
		}
	}

	body, err := json.Marshal(request)
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
	req.Header.Set("apns-push-type", pushType)
	req.Header.Set("apns-priority", priority)

	resp, err := s.Client.Do(req)
	if err != nil {
		return fmt.Errorf("send push: %w", err)
	}
	defer resp.Body.Close()

	// The body can name the device token, so only the status is
	// reported. A 400 or 410 usually means a stale token; nothing prunes
	// them yet, same as fcm.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("send push: %s", resp.Status)
	}
	return nil
}
