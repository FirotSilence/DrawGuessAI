# Security Policy

## Supported versions

Security fixes are provided for the latest tagged release on the default branch.

## Reporting

Use the repository's [private vulnerability report](https://github.com/FirotSilence/DrawGuessAI/security/advisories/new). Do not include exploit details, credentials, room links, or user data in a public issue. If private vulnerability reporting is unavailable, open a public issue that asks the maintainers to establish a private contact channel without describing the vulnerability.

Include reproduction steps, affected versions, potential impact, and any suggested mitigation. The maintainers will acknowledge a complete report as soon as practical and coordinate disclosure after a fix is available.

DrawGuessAI never intentionally sends browser-configured provider credentials to its Worker, room peers, analytics, logs, or replay files. A malicious browser extension, injected script, or provider endpoint can still access credentials used in that browser. Use a dedicated, limited provider key and review the endpoint before connecting.

Deployment-owned provider keys must use Worker Secrets. For multiple server profiles, keep only an `apiKeyRef` variable name in `SERVER_AI_PROFILES_JSON`; never commit an inline key or `.prod.vars`. The public configuration endpoint exposes sanitized schema paths and error codes only.
