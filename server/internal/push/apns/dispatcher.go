package apns

import (
	"context"
	"log/slog"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/notify"
)

// NewSender builds the iOS half of notify.Sender, with the same lazy
// credential as fcm: a relay without a key serves every other route.
func NewSender(awsCfg aws.Config, parameterName, filePath, keyID, teamID, topic string, production bool) notify.Sender {
	loader := &Loader{
		Client:        ssm.NewFromConfig(awsCfg),
		ParameterName: parameterName,
		FilePath:      filePath,
		KeyID:         keyID,
		TeamID:        teamID,
	}
	var (
		once   sync.Once
		sender *Sender
	)

	return func(ctx context.Context, token, platform string, message notify.Message) error {
		if platform != accounts.PlatformIOS {
			return nil
		}
		once.Do(func() {
			key, err := loader.Load(ctx)
			if err != nil {
				slog.WarnContext(ctx, "ios push is off: no credential",
					"reason", "apns_credential_missing", "error", err)
				return
			}
			sender = New(key, topic, production)
		})
		if sender == nil {
			return nil
		}
		return sender.Send(ctx, token, message)
	}
}
