package fcm

import (
	"context"
	"log"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"mimoza-relay/internal/push"
)

// NewDispatcher builds a push.Deps.Dispatch backed by FCM. Lived in
// internal/app before this — app.Deps builds every store from config, but
// this is push delivery logic, not dependency wiring, and belongs beside
// the rest of what this package already owns (Loader, Sender).
//
// The credential is fetched on the first send rather than at boot, so a
// relay without one still serves every other route — push is the only
// thing that needs it. Fire-and-forget by design: a push is best-effort,
// and a failed one must not fail the append that triggered it.
func NewDispatcher(awsCfg aws.Config, parameterName, filePath string) func(push.Delivery, int64, []byte) {
	loader := &Loader{
		Client:        ssm.NewFromConfig(awsCfg),
		ParameterName: parameterName,
		FilePath:      filePath,
	}
	var (
		once   sync.Once
		sender *Sender
	)

	return func(delivery push.Delivery, keyVersion int64, payload []byte) {
		// iOS goes direct to APNs, which isn't built yet.
		if delivery.Platform != "android" {
			return
		}

		ctx := context.Background()
		once.Do(func() {
			account, err := loader.Load(ctx)
			if err != nil {
				log.Printf("push disabled: %v", err)
				return
			}
			sender = New(account)
		})
		if sender == nil {
			return
		}

		if err := sender.Send(ctx, string(delivery.PushToken), delivery.PushRoutingID, delivery.Kind, keyVersion, payload); err != nil {
			log.Printf("failed to deliver a push: %v", err)
		}
	}
}
