// Command lambda is the AWS Lambda entry point — the only place Lambda's
// event/response shapes are allowed to appear. It takes the handler
// internal/app builds and hands it to httpadapter, so the relay and
// everything it depends on has no idea it's running on Lambda at all.
package main

import (
	"context"
	"log"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/awslabs/aws-lambda-go-api-proxy/httpadapter"

	"mimoza-relay/internal/app"
	"mimoza-relay/internal/config"
)

func main() {
	cfg := config.Load()
	app.SetUpLogging(cfg.LogLevel)

	handler, err := app.New(context.Background(), cfg)
	if err != nil {
		log.Fatalf("failed to build the relay: %v", err)
	}

	// NewV2, not New: provision/modules/lambda/lambda_url.tf fronts this with a Lambda
	// Function URL, which uses the same v2.0 Lambda payload format as an
	// API Gateway HTTP API.
	adapter := httpadapter.NewV2(handler)
	lambda.Start(adapter.ProxyWithContext)
}
