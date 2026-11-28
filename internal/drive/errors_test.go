package drive

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"testing"

	"golang.org/x/oauth2"
	"google.golang.org/api/googleapi"
)

func TestClassify(t *testing.T) {
	invalidGrant := &oauth2.RetrieveError{
		Response:  &http.Response{StatusCode: http.StatusBadRequest},
		ErrorCode: "invalid_grant",
	}
	tokenServerDown := &oauth2.RetrieveError{Response: &http.Response{StatusCode: http.StatusServiceUnavailable}}
	offline := &url.Error{Op: "Get", URL: "https://www.googleapis.com/drive/v3/files", Err: &net.OpError{Op: "dial", Err: errors.New("connection refused")}}
	rateLimited := &googleapi.Error{Code: 403, Errors: []googleapi.ErrorItem{{Reason: "userRateLimitExceeded"}}}

	tests := []struct {
		name string
		err  error
		want ErrorKind
	}{
		{"nil", nil, KindUnknown},
		// The exact shape Drive calls produce when the refresh token is revoked:
		// oauth2.Transport returns a RetrieveError wrapped in *url.Error, and
		// client.go wraps that again with fmt.Errorf("...: %w").
		{"invalid_grant through transport", fmt.Errorf("list files: %w", &url.Error{Op: "Get", URL: "x", Err: invalidGrant}), KindAuth},
		{"invalid_grant bare", invalidGrant, KindAuth},
		{"googleapi 401", fmt.Errorf("get: %w", &googleapi.Error{Code: 401}), KindAuth},
		{"token endpoint 503 is transient", &url.Error{Op: "Post", URL: "x", Err: tokenServerDown}, KindOffline},
		{"token endpoint 429 is transient", &oauth2.RetrieveError{Response: &http.Response{StatusCode: 429}}, KindOffline},
		{"token endpoint 403 without error code keeps the token", &oauth2.RetrieveError{Response: &http.Response{StatusCode: 403}}, KindUnknown},
		{"network error", fmt.Errorf("list files: %w", offline), KindOffline},
		{"dns error", &url.Error{Op: "Get", URL: "x", Err: &net.DNSError{Err: "no such host", Name: "www.googleapis.com"}}, KindOffline},
		{"deadline", fmt.Errorf("x: %w", context.DeadlineExceeded), KindOffline},
		{"drive 500", &googleapi.Error{Code: 500}, KindOffline},
		{"forbidden", fmt.Errorf("trash: %w", &googleapi.Error{Code: 403, Errors: []googleapi.ErrorItem{{Reason: "insufficientFilePermissions"}}}), KindForbidden},
		{"rate limit is not forbidden", rateLimited, KindUnknown},
		{"not found", fmt.Errorf("get: %w", &googleapi.Error{Code: 404}), KindNotFound},
		{"bad request", &googleapi.Error{Code: 400}, KindUnknown},
		{"flattened invalid_grant string", errors.New(`Refresh failed: oauth2: "invalid_grant" "Token has been expired or revoked."`), KindAuth},
		{"plain error", errors.New("something odd"), KindUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Classify(tt.err); got != tt.want {
				t.Errorf("Classify() = %v, want %v", got, tt.want)
			}
		})
	}
}
