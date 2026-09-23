package fcm

import (
	"context"
	"log/slog"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/push"
)

// NewSender builds the Android half of push.Sender.
//
// The credential is fetched on the first send rather than at boot, so a
// relay without one still serves every other route: push is the only
// thing that needs it.
func NewSender(awsCfg aws.Config, parameterName, filePath string) push.Sender {
	loader := &Loader{
		Client:        ssm.NewFromConfig(awsCfg),
		ParameterName: parameterName,
		FilePath:      filePath,
	}
	var (
		once   sync.Once
		sender *Sender
	)

	return func(ctx context.Context, token, platform string, message push.Message) error {
		if platform != accounts.PlatformAndroid {
			return nil
		}
		once.Do(func() {
			account, err := loader.Load(ctx)
			if err != nil {
				slog.WarnContext(ctx, "android push is off: no credential",
					"reason", "fcm_credential_missing", "error", err)
				return
			}
			sender = New(account)
		})
		if sender == nil {
			return nil
		}
		return sender.Send(ctx, token, message)
	}
}
