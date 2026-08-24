# Security Policy

## Supported versions

| Version line | Security support |
| --- | --- |
| `v2` / `@mdsahilmolla/elia` `0.1.x` | Supported on the `manus` branch and subsequent releases |
| `v1` snapshot | Historical snapshot; no security backports |

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub’s private vulnerability reporting](https://github.com/MdSahilMolla/elia/security/advisories/new) rather than opening a public issue. Do not include API keys, passwords, session cookies, browser profile data, or other real secrets in a report. If private reporting is unavailable, open a minimal issue asking for a private reporting channel without disclosing exploit details.

A useful report includes the affected version or commit, operating system and Bun version, the smallest safe reproduction, expected and observed behavior, and whether the issue affects confidentiality, integrity, availability, or supervision boundaries. Use temporary test directories and synthetic credentials for reproductions.

## Scope and threat model

Elia is a local terminal application. It is **not a hosted multi-tenant sandbox** and does not claim to isolate a process from a user’s operating system, filesystem, browser, network, or credentials. Users must run it with least privilege and must review provider, browser, shell, and communication configuration.

The project treats browser authentication, CAPTCHA completion, external communication, destructive operations, payment or purchase actions, production changes, publishing, and other critical side effects as supervised boundaries. Unattended mode must not authorize those actions. Workspace path checks, protected-file checks, network checks, and restrictive local-state permissions are defense-in-depth controls, not substitutes for OS isolation, identity, secret management, or network segmentation.

## Disclosure expectations

Maintainers will acknowledge valid reports, assess impact, develop a fix or mitigation, add regression coverage where practical, and document any residual limitation. Please allow reasonable time for coordinated remediation before public disclosure.
