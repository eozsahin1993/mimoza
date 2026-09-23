// Package cdn signs blob download URLs for CloudFront, and invalidates
// them when the bytes behind them are deleted.
//
// Downloads move here from presigned S3 URLs so every member of a circle
// fetches one cached object rather than one S3 read apiece — see
// docs/INFRASTRUCTURE.md. Uploads are untouched: they stay presigned S3
// POSTs straight to the bucket, since CloudFront isn't in that path.
package cdn

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/cloudfront/sign"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	cftypes "github.com/aws/aws-sdk-go-v2/service/cloudfront/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

// settings is what modules/cdn writes to SSM once the blob distribution
// exists. Absent until then, which is how the relay knows to keep
// presigning S3 URLs — the local/LocalStack case, and any environment
// where blob_domain isn't set.
type settings struct {
	BaseURL        string `json:"baseUrl"`
	KeyPairID      string `json:"keyPairId"`
	DistributionID string `json:"distributionId"`
}

// Config names the two SSM parameters this reads. Both paths are derived
// from RESOURCE_PREFIX, so nothing about the CDN reaches the relay through
// its environment — see internal/config.
type Config struct {
	// SettingsParameter holds baseUrl/keyPairId/distributionId as JSON,
	// written by Terraform because it created them.
	SettingsParameter string
	// KeyParameter holds the RSA private key, created by hand so its value
	// never enters Terraform state — same arrangement as the FCM and APNs
	// keys. No local-file escape hatch, unlike those two: without a
	// settings parameter the relay never signs, so it never reads this.
	KeyParameter string
}

// Signer mints signed URLs and invalidates deleted paths.
type Signer struct {
	cfg        Config
	ssm        *ssm.Client
	cloudfront *cloudfront.Client

	once sync.Once
	// Held rather than returned so a failed first load doesn't retry on
	// every request — a missing parameter is a deploy problem, not a
	// transient one.
	loaded *settings
	key    *rsa.PrivateKey
	err    error
}

func New(cfg Config, awsCfg aws.Config) *Signer {
	return &Signer{
		cfg:        cfg,
		ssm:        ssm.NewFromConfig(awsCfg),
		cloudfront: cloudfront.NewFromConfig(awsCfg),
	}
}

// Configured reports whether this environment serves blobs from
// CloudFront at all. False leaves downloads on presigned S3 URLs.
//
// Answered from SSM rather than configuration: the settings appear when
// Terraform creates the distribution, and the relay picks them up on its
// next cold start with nothing to redeploy.
func (s *Signer) Configured(ctx context.Context) bool {
	cfg, _, err := s.load(ctx)
	return err == nil && cfg != nil
}

// SignedURL returns a URL for one blob key, valid for ttl.
//
// The signature covers the path and the expiry, so it can't be moved to
// another object or replayed later. It says nothing about the bytes: they
// are ciphertext the relay never sees.
func (s *Signer) SignedURL(ctx context.Context, key string, ttl time.Duration) (string, error) {
	cfg, privateKey, err := s.load(ctx)
	if err != nil {
		return "", err
	}
	if cfg == nil {
		return "", errors.New("no blob cdn configured")
	}

	raw, err := url.JoinPath(cfg.BaseURL, key)
	if err != nil {
		return "", fmt.Errorf("build blob url: %w", err)
	}
	signed, err := sign.NewURLSigner(cfg.KeyPairID, privateKey).Sign(raw, time.Now().Add(ttl))
	if err != nil {
		return "", fmt.Errorf("sign blob url: %w", err)
	}
	return signed, nil
}

// Invalidate drops cached copies of the given blob keys.
//
// Deleting a blob is meant to destroy the bytes, and an edge cache would
// otherwise keep serving them until the TTL expires — the one case where
// caching works against the design rather than for it.
//
// A wildcard counts as one path however many objects it matches, so
// sweeping a whole circle costs the same as deleting one photo. The first
// 1,000 paths a month are free, account-wide.
func (s *Signer) Invalidate(ctx context.Context, paths ...string) error {
	if len(paths) == 0 {
		return nil
	}

	cfg, _, err := s.load(ctx)
	if err != nil {
		return err
	}
	if cfg == nil {
		return nil
	}

	items := make([]string, 0, len(paths))
	for _, path := range paths {
		items = append(items, "/"+strings.TrimPrefix(path, "/"))
	}

	_, err = s.cloudfront.CreateInvalidation(ctx, &cloudfront.CreateInvalidationInput{
		DistributionId: aws.String(cfg.DistributionID),
		InvalidationBatch: &cftypes.InvalidationBatch{
			// Unique per call, and CloudFront treats a repeat as a
			// reference to the existing invalidation rather than an error.
			CallerReference: aws.String(fmt.Sprintf("%d-%s", time.Now().UnixNano(), items[0])),
			Paths:           &cftypes.Paths{Quantity: aws.Int32(int32(len(items))), Items: items},
		},
	})
	if err != nil {
		return fmt.Errorf("invalidate %d path(s): %w", len(items), err)
	}
	return nil
}

// load fetches both parameters once per process. A nil settings with no
// error means this environment has no blob CDN, which is a normal state,
// not a failure.
func (s *Signer) load(ctx context.Context) (*settings, *rsa.PrivateKey, error) {
	s.once.Do(func() {
		raw, err := s.read(ctx, s.cfg.SettingsParameter, false)
		if err != nil {
			// The parameter appears when Terraform creates the
			// distribution; until then there is nothing to serve from.
			var missing *ssmtypes.ParameterNotFound
			if errors.As(err, &missing) {
				return
			}
			s.err = err
			return
		}

		var loaded settings
		if err := json.Unmarshal(raw, &loaded); err != nil {
			s.err = fmt.Errorf("parse %s: %w", s.cfg.SettingsParameter, err)
			return
		}
		if loaded.BaseURL == "" || loaded.KeyPairID == "" || loaded.DistributionID == "" {
			s.err = fmt.Errorf("%s is missing a field", s.cfg.SettingsParameter)
			return
		}

		keyPEM, err := s.read(ctx, s.cfg.KeyParameter, true)
		if err != nil {
			s.err = err
			return
		}
		key, err := parseKey(keyPEM)
		if err != nil {
			s.err = err
			return
		}
		s.loaded, s.key = &loaded, key
	})
	return s.loaded, s.key, s.err
}

// decrypt is what makes a read a KMS operation: SSM decrypts under the
// caller's identity, which is why the Lambda's policy needs kms:Decrypt
// even though nothing here imports a KMS client. Only the key needs it.
func (s *Signer) read(ctx context.Context, name string, decrypt bool) ([]byte, error) {
	out, err := s.ssm.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(name),
		WithDecryption: aws.Bool(decrypt),
	})
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	return []byte(aws.ToString(out.Parameter.Value)), nil
}

// Never wraps the underlying parse error: those quote the input, and the
// input is a private key.
func parseKey(raw []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("cloudfront signing key is not PEM")
	}

	// CloudFront requires RSA-2048. openssl writes PKCS#1 ("RSA PRIVATE
	// KEY"); other tools write PKCS#8 ("PRIVATE KEY"), so both are read.
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("cloudfront signing key is not an RSA private key")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("cloudfront signing key is not RSA")
	}
	return key, nil
}
