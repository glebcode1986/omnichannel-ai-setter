# Pilot Host Inventory Checklist

How to collect what a candidate production host actually offers, so it can be compared against
`PILOT_SERVER_REQUIREMENTS.md`.

The host's specifications have not been provided, and Issue #123 forbids guessing them. This checklist
is the sanctioned alternative: it says what to measure and how, and it deliberately contains **no host
address, no credentials and no collected values**.

## Rule for handling the output

The output of these commands is machine-specific operational material. **It does not belong in this
repository, in a GitHub issue or pull request, or in any external service.** Keep it in private
storage. If it must be shared for a sizing decision, remove: hostnames, IP addresses, SSH keys and
fingerprints, user names, database passwords, API keys, tokens, certificate private keys, and the names
of unrelated workloads running on the same host.

A reading to keep in mind while collecting: if the host already runs something else, this product's
footprint is not the only thing that matters — the other workload's guarantees do too.

## A. Platform and capacity

```bash
cat /etc/os-release; uname -srm
```

```bash
nproc; lscpu | sed -n '1,15p'
```

```bash
free -h; swapon --show
```

```bash
df -hT; lsblk -o NAME,SIZE,TYPE,ROTA,MOUNTPOINT
```

`ROTA=1` means a rotational disk. PostgreSQL on rotational storage with an append-only Redis alongside
is a different sizing conversation; record it rather than assuming either way.

## B. What already runs on the host

This matters more than raw capacity. A host at 70% memory is not a host with headroom.

```bash
uptime; cat /proc/loadavg
```

```bash
ss -tulpn | sort -k5
```

```bash
systemctl list-units --type=service --state=running --no-pager | head -40
```

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo "docker absent"
```

Record for each existing workload: is it production for something else, and what resource guarantee
does it rely on? Ports 80, 443, 5432 and 6379 being occupied decides whether this product can use its
defaults or must be bound elsewhere.

## C. Toolchain presence

```bash
node --version; corepack --version 2>/dev/null; pnpm --version 2>/dev/null
```

Node must be 24.x, or pnpm will refuse to install (`devEngines.runtime` with `onFail: "error"`).

```bash
psql --version 2>/dev/null; postgres --version 2>/dev/null
```

```bash
redis-server --version 2>/dev/null
```

```bash
nginx -v 2>&1; nginx -T 2>/dev/null | grep -cE 'server_name|proxy_pass'
```

If PostgreSQL is present, its **major version** decides reusability. Version 16 cannot run this schema,
which needs 17 with the `vector` extension:

```bash
psql -XAtc "SHOW server_version" 2>/dev/null
```

```bash
psql -XAtc "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name='vector'" 2>/dev/null
```

An empty `installed_version` with a non-empty `default_version` means pgvector is available but not
enabled. An empty result for both means the extension is not installed on that server at all.

```bash
psql -XAtc "SHOW max_connections" 2>/dev/null
```

## D. Network, DNS and TLS — observe, do not change

Issue #123 forbids changing live DNS. These are read-only checks.

```bash
dig +short mixamart.com A; dig +short mixamart.com AAAA
```

```bash
curl -sS -o /dev/null -w 'http=%{http_code} tls=%{ssl_verify_result} redirect=%{redirect_url}\n' https://mixamart.com/
```

A non-zero `ssl_verify_result` or a connection failure is information, not a problem to fix from here.
Record what you see. Do not conclude the service is deployed from a `200`: see the two reverse-proxy
traps in `PILOT_SERVER_REQUIREMENTS.md` §6 — verify a browser-facing deployment in a browser.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://mixamart.com/.well-known/openid-configuration
```

Outbound reachability matters as much as inbound, because the product calls Meta, the AI provider and
the mail provider:

```bash
for h in graph.facebook.com api.anthropic.com api.resend.com; do printf '%s ' "$h"; curl -sS -o /dev/null -w '%{http_code}\n' --max-time 8 "https://$h/" || echo unreachable; done
```

## E. Backup capability

The repository implements no backup (see `PILOT_READINESS_AUDIT.md`), so this is entirely a host
question.

- Does the provider take block-level snapshots, at what interval, with what retention?
- Is there space for a local `pg_dump` of the database plus one previous copy?
- Has a **restore** ever been performed? An untested backup is a plan, not a capability.

```bash
which pg_dump pg_restore pg_basebackup 2>/dev/null
```

## F. Supervision and restart behaviour

Two processes must stay alive and must restart gracefully (`PILOT_SERVER_REQUIREMENTS.md` §2).

- What supervises them — systemd units, Docker restart policies, something else?
- Do they come back after a host reboot, unattended?
- Is the shutdown signal a `SIGTERM` with a grace period long enough for the worker's loops to close
  their database and Redis handles? A hard kill is survivable but not free.

```bash
systemctl is-enabled docker 2>/dev/null; systemctl show -p TimeoutStopUSec docker 2>/dev/null
```

## G. Clock

Two scheduled behaviours in the product are time-sensitive, and one class of past defect in this
codebase came from clocks disagreeing.

```bash
timedatectl status 2>/dev/null || date -u
```

Record the timezone and whether NTP is synchronised.

## What to answer once collected

Fill these in privately. Each one is a yes/no the sizing decision needs, and "unknown" is a valid
answer that identifies the next question:

1. Node 24 available, or installable without disturbing an existing workload?
2. PostgreSQL 17 with `vector` available, or installable alongside whatever is already there?
3. Redis 7 available with append-only persistence permitted?
4. Ports for web, PostgreSQL and Redis available, or must they be bound to loopback on
   non-default ports?
5. Enough free memory for a Next.js 16 Turbopack build **and** steady state, or must the build happen
   elsewhere and only the artefact be shipped?
6. TLS termination available for the intended origin, with the two reverse-proxy settings from
   §6 of the requirements applied?
7. Outbound HTTPS to the provider endpoints permitted?
8. A backup that has actually been restored at least once?
9. Unattended restart after reboot, verified?
10. Is this host production for anything else — and if so, who agreed to share it, and under what
    guarantee?
