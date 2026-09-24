package app

import (
	"log/slog"
	"os"
)

// logCredentialSource says at boot which source a push credential will
// come from — not whether it will actually load, which stays lazy (see
// fcm/apns NewSender) so a relay without one still serves every other
// route. A misconfigured file path is still worth catching immediately
// rather than only on the first send, so a configured file is stat'd —
// cheap and local, unlike validating an SSM parameter would be.
func logCredentialSource(label, filePath, ssmParameter string) {
	if filePath == "" {
		slog.Info(label+": will read from SSM on first send", "parameter", ssmParameter)
		return
	}
	if _, err := os.Stat(filePath); err != nil {
		slog.Warn(label+": configured file is not readable", "reason", "credential_file_unreadable", "path", filePath, "error", err)
		return
	}
	slog.Info(label+": configured", "path", filePath)
}
