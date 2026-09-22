package s3

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type presignEndpointKey struct{}

// WithPresignEndpoint makes every URL this store presigns under ctx point
// at endpoint rather than the address the relay itself reaches S3 on. The
// URL is signed for that host, not rewritten after signing, so presigned
// GETs — whose signature covers the host — stay valid. Only cmd/server
// sets it, for LocalStack; see its presignForRequestHost.
func WithPresignEndpoint(ctx context.Context, endpoint string) context.Context {
	return context.WithValue(ctx, presignEndpointKey{}, endpoint)
}

// presigner is the store's own presign client unless ctx carries an
// endpoint override. The override has to live on the client: the SDK
// honours per-call ClientOptions for PresignGetObject but silently
// ignores them for PresignPostObject, so uploads would keep the old host.
func (s *Store) presigner(ctx context.Context) *s3.PresignClient {
	endpoint, ok := ctx.Value(presignEndpointKey{}).(string)
	if !ok {
		return s.presignClient
	}
	return s3.NewPresignClient(s.client, func(o *s3.PresignOptions) {
		o.ClientOptions = append(o.ClientOptions, func(o *s3.Options) { o.BaseEndpoint = aws.String(endpoint) })
	})
}
