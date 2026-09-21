package apns

import (
	"context"
	"log"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"mimoza-relay/internal/push"
)

// NewDispatcher builds a push.Deps.Dispatch backed by APNs — the iOS
// counterpart to fcm.NewDispatcher, same fire-and-forget, lazy-credential
// shape: a push is best-effort, and a failed one must not fail the append
// that triggered it.
func NewDispatcher(awsCfg aws.Config, parameterName, filePath, keyID, teamID, topic string, production bool) func(push.Delivery, int64, []byte) {
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

	return func(delivery push.Delivery, keyVersion int64, payload []byte) {
		if delivery.Platform != "ios" {
			return
		}

		ctx := context.Background()
		once.Do(func() {
			key, err := loader.Load(ctx)
			if err != nil {
				log.Printf("push disabled: %v", err)
				return
			}
			sender = New(key, topic, production)
		})
		if sender == nil {
			return
		}

		if err := sender.Send(ctx, string(delivery.PushToken), delivery.PushRoutingID, delivery.Kind, keyVersion, payload); err != nil {
			log.Printf("failed to deliver a push: %v", err)
		}
	}
}
