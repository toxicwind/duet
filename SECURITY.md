# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a vulnerability

**Do not open a public issue.** Email the maintainer via the address on
the GitHub profile, or use GitHubs private vulnerability reporting
(Security tab > Report a vulnerability).

Include: affected version, description, reproduction steps, and any
suggested mitigation. Expect an initial response within 7 days.

## Scope

`synx` transfers file contents over SSH. It does not implement its own
cryptography — all transport security comes from SSH. Vulnerabilities in
conflict resolution (data loss) and the failover queue (data integrity)
are in scope.
