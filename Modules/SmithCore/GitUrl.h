// GitUrl.h - validate a user-entered git repository URL / path before the
// coordinator tries to clone it, so an obvious typo (e.g. a stray leading '/'
// before an scp-style URL) is rejected up front with a clear message instead of
// failing deep inside `git clone`. Pure + unit-testable.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>

namespace Smith
{
    // Returns "" when the URL looks acceptable, else a human-readable reason.
    // Recognises: scheme URLs (http/https/ssh/git/file), scp-style user@host:path,
    // Windows drive paths, UNC paths, and lenient bareword/relative local paths.
    std::string ValidateGitUrl(const std::string& url);

    // --- GitHub token auth (used when the coordinator has a configured PAT so that
    // agents can check out private repos without per-host SSH keys) ---

    // True if `url` targets github.com (scp-style git@, ssh://, or http/https).
    bool IsGitHubUrl(const std::string& url);

    // The HTTPS form of a GitHub URL (scp/ssh -> https) so it can be cloned with a
    // token via an HTTP Authorization header. Any userinfo is dropped; the token is
    // never placed in the URL. Non-GitHub URLs are returned unchanged.
    std::string ToHttpsGitHubUrl(const std::string& url);

    // The header value for `git -c http.https://github.com/.extraheader=<...>` that
    // authenticates to GitHub with a personal-access token (HTTP Basic, user
    // "x-access-token"). "" when token is empty. Keeping the token in a -c header
    // (not the URL) keeps it out of .git/config, the remote, and the build logs.
    std::string GitHubExtraHeader(const std::string& token);
}
