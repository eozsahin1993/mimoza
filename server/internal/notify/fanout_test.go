package notify

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type fakeCircles struct{ roster []circles.Member }

func (f *fakeCircles) GetCircle(_ context.Context, circleID string) (circles.Circle, error) {
	return circles.Circle{ID: circleID, Name: "Family"}, nil
}

func (f *fakeCircles) ListMembers(context.Context, string) ([]circles.Member, error) {
	return f.roster, nil
}

type fakeAccounts struct{ devices map[string][]accounts.Device }

func (f *fakeAccounts) GetProfile(_ context.Context, accountID string) (accounts.Profile, error) {
	return accounts.Profile{AccountID: accountID, Name: "Sarah"}, nil
}

func (f *fakeAccounts) ListDevices(_ context.Context, accountID string) ([]accounts.Device, error) {
	return f.devices[accountID], nil
}

type sent struct {
	token   string
	message Message
}

func notifierFor(roster []circles.Member, devices map[string][]accounts.Device) (*Notifier, *[]sent) {
	var delivered []sent
	notifier := &Notifier{
		Circles:  &fakeCircles{roster: roster},
		Accounts: &fakeAccounts{devices: devices},
		Send: func(_ context.Context, token, _ string, message Message) error {
			delivered = append(delivered, sent{token: token, message: message})
			return nil
		},
	}
	return notifier, &delivered
}

func member(id, level string) circles.Member {
	return circles.Member{AccountID: id, Role: circles.RoleMember, NotifyLevel: level}
}

func phone(id string) map[string][]accounts.Device {
	return map[string][]accounts.Device{id: {{DeviceID: "phone-1", PushToken: "token-" + id, Platform: accounts.PlatformIOS}}}
}

// A level says what reaches you. Nobody hears about their own doing.
func TestNotify_LevelsDecideWhoHears(t *testing.T) {
	roster := []circles.Member{
		member("actor", circles.NotifyAll),
		member("all", circles.NotifyAll),
		member("comments", circles.NotifyComments),
		member("photos", circles.NotifyPhotos),
		member("none", circles.NotifyNone),
	}
	devices := map[string][]accounts.Device{}
	for _, who := range []string{"actor", "all", "comments", "photos", "none"} {
		for id, list := range phone(who) {
			devices[id] = list
		}
	}

	for kind, want := range map[Kind][]string{
		KindPost:     {"all", "comments", "photos"},
		KindComment:  {"all", "comments"},
		KindReaction: {"all"},
	} {
		notifier, delivered := notifierFor(roster, devices)
		notifier.Notify(context.Background(), Event{Kind: kind, CircleID: "circle-1", ActorID: "actor", EntryID: "post-1"})

		got := map[string]bool{}
		for _, one := range *delivered {
			got[one.token] = true
		}
		if len(got) != len(want) {
			t.Errorf("%s reached %v, want %v", kind, got, want)
		}
		for _, who := range want {
			if !got["token-"+who] {
				t.Errorf("%s did not reach %s", kind, who)
			}
		}
	}
}

// The author of the photo hears about a comment on it whatever else they
// have quietened, short of silencing the circle outright.
func TestNotify_ThePhotosAuthorIsToldAnyway(t *testing.T) {
	roster := []circles.Member{member("actor", circles.NotifyAll), member("author", circles.NotifyPhotos)}
	notifier, delivered := notifierFor(roster, phone("author"))

	notifier.Notify(context.Background(), Event{
		Kind: KindComment, CircleID: "circle-1", ActorID: "actor",
		EntryID: "comment-1", ParentID: "post-1", AuthorID: "author",
	})

	if len(*delivered) != 1 {
		t.Fatalf("expected the author to be told, got %d", len(*delivered))
	}
	message := (*delivered)[0].message
	if message.BodyKey != keyCommentedYours {
		t.Errorf("bodyKey = %q, want the your-photo line", message.BodyKey)
	}
	if message.Data["parentEntryId"] != "post-1" {
		t.Errorf("a tap needs the post it is on: %v", message.Data)
	}
}

// Silencing a circle silences it, even on your own photo.
func TestNotify_SilenceIsSilence(t *testing.T) {
	roster := []circles.Member{member("actor", circles.NotifyAll), member("author", circles.NotifyNone)}
	notifier, delivered := notifierFor(roster, phone("author"))

	notifier.Notify(context.Background(), Event{
		Kind: KindComment, CircleID: "circle-1", ActorID: "actor", AuthorID: "author", ParentID: "post-1",
	})

	if len(*delivered) != 0 {
		t.Fatalf("expected nothing delivered, got %d", len(*delivered))
	}
}

// Someone else's photo reads differently from your own, and the relay
// knows which without reading either.
func TestNotify_AnotherPersonsPhotoReadsDifferently(t *testing.T) {
	roster := []circles.Member{member("actor", circles.NotifyAll), member("bystander", circles.NotifyAll)}
	notifier, delivered := notifierFor(roster, phone("bystander"))

	notifier.Notify(context.Background(), Event{
		Kind: KindComment, CircleID: "circle-1", ActorID: "actor", AuthorID: "author", ParentID: "post-1",
	})

	if len(*delivered) != 1 || (*delivered)[0].message.BodyKey != keyCommentedOther {
		t.Fatalf("expected the other-photo line, got %+v", *delivered)
	}
}

// A targeted event reaches the people it names and nobody else: the
// admins who must answer, or the person being admitted.
func TestNotify_TargetedEventsSkipTheRoster(t *testing.T) {
	roster := []circles.Member{member("admin", circles.NotifyAll), member("bystander", circles.NotifyAll)}
	devices := phone("admin")
	devices["bystander"] = phone("bystander")["bystander"]
	notifier, delivered := notifierFor(roster, devices)

	notifier.Notify(context.Background(), Event{
		Kind: KindJoinRequest, CircleID: "circle-1", ActorID: "asker", Only: []string{"admin"},
	})

	if len(*delivered) != 1 || (*delivered)[0].token != "token-admin" {
		t.Fatalf("expected only the admin, got %+v", *delivered)
	}
	if (*delivered)[0].message.BodyKey != keyJoinRequest {
		t.Errorf("bodyKey = %q", (*delivered)[0].message.BodyKey)
	}
}

// A roster change is a nudge to sync, not a card, so a level that
// silences notifications does not silence syncing.
func TestNotify_ARosterChangeIsSilentAndReachesEveryone(t *testing.T) {
	roster := []circles.Member{member("actor", circles.NotifyAll), member("quiet", circles.NotifyNone)}
	notifier, delivered := notifierFor(roster, phone("quiet"))

	notifier.Notify(context.Background(), Event{Kind: KindRoster, CircleID: "circle-1", ActorID: "actor"})

	if len(*delivered) != 1 {
		t.Fatalf("expected the quiet member to be woken, got %d", len(*delivered))
	}
	message := (*delivered)[0].message
	if !message.Silent || message.BodyKey != "" {
		t.Errorf("expected a silent push with no card, got %+v", message)
	}
	if message.Data["circleId"] != "circle-1" {
		t.Errorf("a silent push still has to say which circle: %v", message.Data)
	}
}

// Without credentials the fanout still resolves and reports; it just
// delivers nothing. That is every local run.
func TestNotify_WithoutASenderNothingPanics(t *testing.T) {
	notifier := &Notifier{
		Circles:  &fakeCircles{roster: []circles.Member{member("all", circles.NotifyAll)}},
		Accounts: &fakeAccounts{devices: phone("all")},
	}
	notifier.Notify(context.Background(), Event{Kind: KindPost, CircleID: "circle-1", ActorID: "actor"})
}

// Every fanout says what it did. Without the counts a push that never
// left is indistinguishable from one nobody was owed.
func TestNotify_ReportsWhatItDelivered(t *testing.T) {
	var log bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&log, nil)))
	defer slog.SetDefault(previous)

	roster := []circles.Member{member("actor", circles.NotifyAll), member("one", circles.NotifyAll), member("two", circles.NotifyAll)}
	devices := phone("one")
	devices["two"] = []accounts.Device{
		{DeviceID: "phone-1", PushToken: "token-two-a", Platform: accounts.PlatformIOS},
		{DeviceID: "phone-2", PushToken: "token-two-b", Platform: accounts.PlatformAndroid},
	}

	notifier := &Notifier{
		Circles:  &fakeCircles{roster: roster},
		Accounts: &fakeAccounts{devices: devices},
		Send: func(_ context.Context, token, _ string, _ Message) error {
			if token == "token-two-b" {
				return errors.New("apns said no")
			}
			return nil
		},
	}
	notifier.Notify(context.Background(), Event{Kind: KindPost, CircleID: "circle-1", ActorID: "actor", EntryID: "post-1"})

	line := log.String()
	for _, want := range []string{"recipients=2", "delivered=2", "skipped=1", "circleId=circle-1", "type=post"} {
		if !strings.Contains(line, want) {
			t.Errorf("log is missing %s: %s", want, line)
		}
	}
}
