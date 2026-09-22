// Package s3 is the circles column's blob storage: the encrypted photo
// behind a post, and a circle's cover, in one bucket. Bytes move
// directly between the device and S3 through presigned URLs, so the
// relay never holds a photo and never sees one decrypted.
package s3

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"mimoza-relay/internal/circles"
)

const (
	uploadURLTTL   = 15 * time.Minute
	downloadURLTTL = time.Hour

	// contentType is pinned on every upload. The relay cannot know what
	// the plaintext is, so this is not a detected value but a fixed one
	// the client must echo: without it a client could tag an object as
	// text/html, which would matter the moment a download URL was opened
	// in a browser.
	contentType = "application/octet-stream"
)

type Store struct {
	client        *s3.Client
	presignClient *s3.PresignClient
	bucket        string
	maxBlobSize   int64
	// cdn, when set, serves downloads instead of presigned S3 URLs, and
	// is told about deletions so edge caches do not outlive the bytes.
	// Nil locally: LocalStack has no CloudFront.
	cdn Downloads
}

// Downloads is what this store needs from the CDN. An interface so the
// store does not depend on CloudFront to compile, and so a test can
// assert what was invalidated.
type Downloads interface {
	// Configured is false where no CDN exists — local runs, and any
	// environment before its distribution is created. Downloads then stay
	// on presigned S3 URLs.
	Configured(ctx context.Context) bool
	SignedURL(ctx context.Context, key string, ttl time.Duration) (string, error)
	Invalidate(ctx context.Context, paths ...string) error
}

func New(client *s3.Client, bucket string, maxBlobSize int64) *Store {
	if maxBlobSize <= 0 {
		maxBlobSize = circles.MaxBlobSize
	}
	return &Store{
		client:        client,
		presignClient: s3.NewPresignClient(client),
		bucket:        bucket,
		maxBlobSize:   maxBlobSize,
	}
}

// WithDownloads points reads at the CDN. Uploads are unaffected: they go
// straight to the bucket either way.
func (s *Store) WithDownloads(cdn Downloads) *Store {
	s.cdn = cdn
	return s
}

// PostKey and CoverKey are the only two shapes in the bucket. Both are
// written once and never overwritten — a new cover gets a new id — so a
// cached copy can never be stale and the edge may hold it as long as it
// likes.
func PostKey(circleID, postID string) string { return circleID + "/" + postID }

func CoverKey(circleID, coverID string) string { return circleID + "/cover/" + coverID }

// UploadTarget refuses a key that already holds bytes. Without that
// check any member could ask for a target for someone else's post and
// replace the photo with one that still decrypts, since membership
// proves "a member of this circle", never "the author of this post".
func (s *Store) UploadTarget(ctx context.Context, key string) (circles.UploadTarget, error) {
	_, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err == nil {
		return circles.UploadTarget{}, circles.ErrBlobExists
	}
	var notFound *s3types.NotFound
	if !errors.As(err, &notFound) {
		return circles.UploadTarget{}, err
	}

	// The policy carries a length range and a pinned Content-Type, so S3
	// itself rejects an oversized or mistyped upload rather than the
	// relay discovering it later. ContentType on the input is not picked
	// up by PresignPostObject on its own, hence both.
	request, err := s.presigner(ctx).PresignPostObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, func(o *s3.PresignPostOptions) {
		o.Expires = uploadURLTTL
		o.Conditions = []any{
			[]any{"content-length-range", 1, s.maxBlobSize},
			map[string]any{"Content-Type": contentType},
		}
	})
	if err != nil {
		return circles.UploadTarget{}, err
	}
	request.Values["Content-Type"] = contentType
	return circles.UploadTarget{URL: request.URL, Fields: request.Values}, nil
}

// DownloadURL costs nothing to hand out: it is local signing, with no
// call to S3 and no check that the object is there. Whether a post has a
// photo at all is a field on its row.
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

// Delete reports success whether or not the key was there, so a retried
// deletion is the same outcome rather than an error.
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

// DeleteCircle sweeps a circle's whole prefix, a page at a time rather
// than collecting every key first. The trailing slash matters: without
// it the prefix would also match a circle whose id merely starts with
// this one.
//
// The bucket is unversioned, so these deletes destroy the bytes rather
// than laying delete markers over recoverable versions. Turning
// versioning on would silently stop this deleting anything.
func (s *Store) DeleteCircle(ctx context.Context, circleID string) error {
	paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket),
		Prefix: aws.String(circleID + "/"),
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
		// DeleteObjects reports per-object failures in the response
		// rather than as an error, so a partial failure would otherwise
		// look like a clean sweep.
		if len(out.Errors) > 0 {
			return fmt.Errorf("deleting blobs for %s: %d of %d objects failed, first: %s",
				circleID, len(out.Errors), len(objects), aws.ToString(out.Errors[0].Message))
		}
	}
	// One wildcard rather than a path per object: a wildcard counts as a
	// single invalidation whatever it matches, and the extra misses cost
	// nothing but a re-fetch.
	return s.invalidate(ctx, circleID+"/*")
}

// invalidate is best-effort by design. The bytes are already gone, and
// failing the delete would tell a caller nothing was destroyed when it
// was. A cached copy then survives until its TTL, which is why a signed
// URL is also refused for a deleted post.
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
