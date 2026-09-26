// Package fcm delivers one notification to one Android phone through
// Firebase Cloud Messaging.
package fcm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"mimoza-relay/internal/push"
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

// Send delivers one message to one device token, entirely as data: FCM's
// own notification block bypasses the app whenever it isn't in the
// foreground (https://firebase.google.com/docs/cloud-messaging/android/receive),
// and has no field for grouping by circle either, so push-localization/android
// does all of it — resolving the loc keys against the app's own
// strings.xml and grouping — for every app state, not just foreground.
func (s *Sender) Send(ctx context.Context, deviceToken string, message push.Message) error {
	accessToken, err := s.tokens.accessToken(ctx)
	if err != nil {
		return err
	}

	data := message.Data
	if !message.Silent {
		data = androidNotificationData(message)
	}

	payload := map[string]any{
		"token": deviceToken,
		"data":  data,
		"android": map[string]any{
			// High priority, or Doze defers a data-only message
			// indefinitely and a notification arrives hours late.
			"priority": "high",
		},
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

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("send push: %s: %w", resp.Status, push.ErrUnregistered)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("send push: %s", resp.Status)
	}
	return nil
}

// androidNotificationData copies message's data, never mutating it —
// fanout.go shares one Data map across every device, iOS included — and
// adds "body" as JSON, the only path back to content.body on Android.
func androidNotificationData(message push.Message) map[string]string {
	locArgs, _ := json.Marshal(message.Args)
	body, _ := json.Marshal(message.Data)

	data := make(map[string]string, len(message.Data)+4)
	for k, v := range message.Data {
		data[k] = v
	}
	data["titleLocKey"] = androidResourceName(message.TitleKey)
	data["bodyLocKey"] = androidResourceName(message.BodyKey)
	data["locArgs"] = string(locArgs)
	data["body"] = string(body)
	return data
}

// androidResourceName is a loc key as Android's own resource compiler
// will accept it: aapt2 rejects a "." in a string resource's name, so
// the dotted keys compose.go names (push.posted, matching iOS's own
// Localizable.strings convention) have to lose the dots for the name
// Android looks up body_loc_key/title_loc_key against — but only here;
// iOS keeps them as sent.
func androidResourceName(key string) string {
	return strings.ReplaceAll(key, ".", "_")
}
