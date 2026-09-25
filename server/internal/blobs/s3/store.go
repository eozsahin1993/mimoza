// Package s3 is the relay's blob storage. Bytes move directly between
// the device and S3 through presigned URLs; the relay only signs.
//
// It takes keys, not ids: which key a post, a cover or an avatar belongs
// at is the column that owns it deciding.
package s3

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"mimoza-relay/internal/blobs"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	uploadURLTTL   = 15 * time.Minute
	downloadURLTTL = time.Hour

	// Pinned, not detected: an object a client could tag text/html would
	// matter the moment a signed URL was opened in a browser.
	contentType = "application/octet-stream"
)

type Store struct {
	client        *s3.Client
	presignClient *s3.PresignClient
	bucket        string
	maxBlobSize   int64
	// Nil locally: LocalStack has no CloudFront, so downloads fall back
	// to presigned S3 URLs.
	cdn Downloads
}

// Downloads is the CDN, as an interface so this store does not depend on
// CloudFront to compile.
type Downloads interface {
	// False where no distribution exists yet, which is every local run.
	Configured(ctx context.Context) bool
	SignedURL(ctx context.Context, key string, ttl time.Duration) (string, error)
	Invalidate(ctx context.Context, paths ...string) error
}

// DefaultMaxBlobSize is the ceiling when an environment sets none. A
// caller may ask for less, never more.
const DefaultMaxBlobSize = 5 * 1024 * 1024

func New(client *s3.Client, bucket string, maxBlobSize int64) *Store {
	if maxBlobSize <= 0 {
		maxBlobSize = DefaultMaxBlobSize
	}
	return &Store{
		client:        client,
		presignClient: s3.NewPresignClient(client),
		bucket:        bucket,
		maxBlobSize:   maxBlobSize,
	}
}

// WithDownloads points reads at the CDN. Uploads go to the bucket either
// way.
func (s *Store) WithDownloads(cdn Downloads) *Store {
	s.cdn = cdn
	return s
}

// UploadTarget refuses a key that already holds bytes: being allowed to
// upload proves membership, never authorship, so without this any member
// could replace someone else's photo with one that still decrypts.
func (s *Store) UploadTarget(ctx context.Context, key string, maxBytes int64) (blobs.UploadTarget, error) {
	_, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err == nil {
		return blobs.UploadTarget{}, blobs.ErrExists
	}
	var notFound *s3types.NotFound
	if !errors.As(err, &notFound) {
		return blobs.UploadTarget{}, err
	}

	if maxBytes <= 0 || maxBytes > s.maxBlobSize {
		maxBytes = s.maxBlobSize
	}

	// S3 enforces the signed policy itself. ContentType on the input is
	// not picked up by PresignPostObject, so it is set in both places.
	request, err := s.presigner(ctx).PresignPostObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, func(o *s3.PresignPostOptions) {
		o.Expires = uploadURLTTL
		o.Conditions = []any{
			[]any{"content-length-range", 1, maxBytes},
			map[string]any{"Content-Type": contentType},
		}
	})
	if err != nil {
		return blobs.UploadTarget{}, err
	}
	request.Values["Content-Type"] = contentType
	return blobs.UploadTarget{URL: request.URL, Fields: request.Values}, nil
}

// DownloadURL is local signing: no call to S3, and no check that the
// object is there.
func (s *Store) DownloadURL(ctx context.Context, key string) (string, error) {
	if s.cdn != nil && s.cdn.Configured(ctx) {
		return s.cdn.SignedURL(ctx, key, downloadURLTTL)
	}

	request, err := s.presigner(ctx).PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(downloadURLTTL))
	if err != nil {
		return "", err
	}
	return request.URL, nil
}

// Delete succeeds whether or not the key was there.
func (s *Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return err
	}
	return s.invalidate(ctx, key)
}

// DeletePrefix sweeps everything under a prefix. The caller passes the
// trailing slash: without it a circle's prefix also matches a circle
// whose id starts with the same characters.
//
// Turning bucket versioning on would silently stop this deleting
// anything: the deletes would become markers over recoverable versions.
func (s *Store) DeletePrefix(ctx context.Context, prefix string) error {
	paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket),
		Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return err
		}
		if len(page.Contents) == 0 {
			continue
		}

		objects := make([]s3types.ObjectIdentifier, 0, len(page.Contents))
		for _, object := range page.Contents {
			objects = append(objects, s3types.ObjectIdentifier{Key: object.Key})
		}
		out, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(s.bucket),
			Delete: &s3types.Delete{Objects: objects, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return err
		}
		// Per-object failures come back in the response, not as an
		// error: a partial failure would otherwise look like a sweep.
		if len(out.Errors) > 0 {
			return fmt.Errorf("deleting blobs under %s: %d of %d objects failed, first: %s",
				prefix, len(out.Errors), len(objects), aws.ToString(out.Errors[0].Message))
		}
	}
	// One wildcard counts as a single invalidation whatever it matches.
	return s.invalidate(ctx, prefix+"*")
}

// invalidate is best-effort: the bytes are already gone, and failing the
// delete would report nothing destroyed when everything was. A cached
// copy surviving its TTL is why a deleted post is also refused a URL.
func (s *Store) invalidate(ctx context.Context, paths ...string) error {
	if s.cdn == nil || !s.cdn.Configured(ctx) {
		return nil
	}
	if err := s.cdn.Invalidate(ctx, paths...); err != nil {
		slog.ErrorContext(ctx, "cdn invalidation failed, cached copies outlive the blobs",
			"reason", "cdn_invalidation_failed", "error", err, "paths", paths)
	}
	return nil
}
