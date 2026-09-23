// Package fcm delivers one notification to one Android phone through
// Firebase Cloud Messaging.
package fcm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"mimoza-relay/internal/notify"
)

type Sender struct {
	ProjectID string
	Client    *http.Client
	tokens    *tokenSource
}

func New(account *ServiceAccount) *Sender {
	// One client for both the token exchange and the sends: the
	// token source dials Google's OAuth endpoint itself.
	client := &http.Client{Timeout: 10 * time.Second}
	return &Sender{
		ProjectID: account.ProjectID,
		Client:    client,
		tokens:    &tokenSource{account: account, client: client},
	}
}

// Send delivers one message to one device token. The text is
// localization keys, which Android resolves against the app's own
// strings.xml.
func (s *Sender) Send(ctx context.Context, deviceToken string, message notify.Message) error {
	accessToken, err := s.tokens.accessToken(ctx)
	if err != nil {
		return err
	}

	payload := map[string]any{
		"token": deviceToken,
		"data":  message.Data,
		"android": map[string]any{
			// High priority, or Doze defers a data-only message
			// indefinitely and a notification arrives hours late.
			"priority": "high",
		},
	}
	if !message.Silent {
		payload["android"].(map[string]any)["notification"] = map[string]any{
			"title_loc_key":  message.TitleKey,
			"title_loc_args": message.Args,
			"body_loc_key":   message.BodyKey,
			"body_loc_args":  message.Args,
		}
	}

	body, err := json.Marshal(map[string]any{"message": payload})
	if err != nil {
		return err
	}

	url := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", s.ProjectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.Client.Do(req)
	if err != nil {
		return fmt.Errorf("send push: %w", err)
	}
	defer resp.Body.Close()

	// The body can name the device token, so only the status is
	// reported. A 404 or 400 usually means a stale token; nothing prunes
	// them yet, and a dead token costs one failed send per notification.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("send push: %s", resp.Status)
	}
	return nil
}
