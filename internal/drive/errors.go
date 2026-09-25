package drive

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/oauth2"
	"google.golang.org/api/googleapi"
)

// ErrorKind is a coarse classification of a Drive or OAuth failure, used to
// decide how the app reacts (sign out, retry later, explain to the user).
type ErrorKind int

const (
	KindUnknown ErrorKind = iota
	// KindAuth: the stored sign-in no longer works (refresh token revoked or
	// expired, 401). Retrying cannot help; the user must sign in again.
	KindAuth
	// KindOffline: the request never got an answer (no network, DNS, timeout).
	KindOffline
	// KindForbidden: signed in, but not allowed to touch this file or folder.
	KindForbidden
	// KindNotFound: the file or folder does not exist (or is not visible).
	KindNotFound
)

func (k ErrorKind) String() string {
	switch k {
	case KindAuth:
		return "auth"
	case KindOffline:
		return "offline"
	case KindForbidden:
		return "forbidden"
	case KindNotFound:
		return "notfound"
	}
	return "unknown"
}

// Classify inspects an error returned by the Drive client (possibly wrapped)
// and reports what kind of failure it is.
func Classify(err error) ErrorKind {
	if err == nil {
		return KindUnknown
	}

	// Token refresh rejected by Google's OAuth endpoint. invalid_grant is what
	// a revoked or expired refresh token produces (Testing-mode consent screens
	// expire them after 7 days). A 5xx from the token endpoint is transient.
	var re *oauth2.RetrieveError
	if errors.As(err, &re) {
		if re.ErrorCode == "invalid_grant" || re.ErrorCode == "unauthorized_client" || re.ErrorCode == "invalid_client" {
			return KindAuth
		}
		if re.Response != nil && (re.Response.StatusCode == http.StatusBadRequest || re.Response.StatusCode == http.StatusUnauthorized) {
			return KindAuth
		}
		if re.Response != nil && re.Response.StatusCode >= 500 {
			return KindOffline
		}
		return KindAuth
	}

	var ge *googleapi.Error
	if errors.As(err, &ge) {
		switch ge.Code {
		case http.StatusUnauthorized:
			return KindAuth
		case http.StatusForbidden:
			for _, item := range ge.Errors {
				// Quota and rate limits are also 403s but are transient.
				if strings.Contains(strings.ToLower(item.Reason), "ratelimit") {
					return KindUnknown
				}
			}
			return KindForbidden
		case http.StatusNotFound:
			return KindNotFound
		}
		if ge.Code >= 500 {
			return KindOffline
		}
		return KindUnknown
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return KindOffline
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return KindOffline
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return KindOffline
	}
	// Last resort for errors that were flattened to strings along the way.
	msg := err.Error()
	if strings.Contains(msg, "invalid_grant") {
		return KindAuth
	}
	for _, s := range []string{"no such host", "connection refused", "network is unreachable", "i/o timeout", "connection reset"} {
		if strings.Contains(msg, s) {
			return KindOffline
		}
	}
	return KindUnknown
}

// IsNotFound reports whether err means the Drive file does not exist.
func IsNotFound(err error) bool { return Classify(err) == KindNotFound }
