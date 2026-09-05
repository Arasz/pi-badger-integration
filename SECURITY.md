# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's private vulnerability reporting (the **Security → Report a vulnerability** tab on this repository). If that is unavailable to you, email **araszkiewiczrafal@gmail.com** with `pi-badger-integration security` in the subject.

Include what an attacker can do and what they need in order to do it, the affected file, and a reproduction where possible. Expect acknowledgement within a week; this is a one-maintainer project with no on-call rotation. Fixes ship forward on `main` with no backports.

## Supported versions

Only the latest release is supported. Releases are GitHub releases on this repository (`vX.Y.Z` tags); pulling and re-publishing is the update path (see [Install extensions](docs/howto/install-extensions.md#update) and [Update integrations](docs/howto/update-integrations.md)).

## What this project actually is, security-wise

This repo ships code that runs **inside the pi agent process with the user's full privileges**. Extensions can read the environment (including provider keys), run shell commands the session approves, and write into the user's home directory at install time. The honest threat model follows from that:

| Surface | What it does | Who controls the input |
|---|---|---|
| Installed extensions | Run in every pi session, observe tool calls and model output, switch models | This repo's source plus the user's own settings |
| Provider keys | Read from the environment per call by router-fallback eligibility | The user's shell environment |
| `bun run publish` | Copies files into `~/.pi/agent/extensions/` and, with `--ai-badger`, into an ai-badger checkout | This repo's source and the path argument |
| Notices and cards | Render failure reasons into the session transcript | Failure text from providers, matched by substring only |

The dangerous direction is a key or credential leaving the machine or landing where it should not. That is why the no-secrets rules exist and why they are non-negotiable:

- No key value in logs, notices, cards, or committed files. Reasons name the variable, never its content.
- Sample values in docs and fixtures stay obviously fake.
- Findings that would publish a credential stay redacted; this repository is public, so an unredacted report would publish exactly what it caught.

## Out of scope

- Vulnerabilities in pi itself or in upstream providers (Groq, Google, OpenRouter). Report those to their vendors. What is in scope here is how this repo reads, carries, or renders their credentials and errors.
- The fact that `publish` writes into the home directory and that extensions observe session traffic. That is the product. A report that either writes somewhere it should not, or observes something it should not, is very much in scope.
- Anything requiring you to already have write access to this repository or to the user's machine.
