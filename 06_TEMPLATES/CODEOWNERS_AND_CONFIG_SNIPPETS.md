# CODEOWNERS and Config Snippets

## `.github/CODEOWNERS`
```text
*                           @qe-workspace/maintainers
/packages/broker-core/      @qe-workspace/maintainers @org/security-reviewers
/packages/policy/           @qe-workspace/maintainers @org/security-reviewers
/packages/secrets/          @qe-workspace/maintainers @org/security-reviewers
/packages/rbac/             @qe-workspace/maintainers @org/security-reviewers
/apps/connection-broker/    @qe-workspace/maintainers @org/security-reviewers
/deploy/                    @qe-workspace/maintainers @org/platform
/.github/workflows/         @qe-workspace/maintainers @org/platform
```

## `.env.example` (dev only — placeholder values)
```ini
NODE_ENV=development
PORT=8080
DATABASE_URL=postgres://qews:devonly@127.0.0.1:5432/qews
PUBLIC_ORIGIN=http://localhost:8080
ALLOWED_ORIGINS=http://localhost:8080
AUTH_MODE=oidc
OIDC_ISSUER=http://localhost:8081/realms/qe
OIDC_CLIENT_ID=qe-workspace
OIDC_CLIENT_SECRET=<dev-placeholder>
RUNTIME_PROVIDER=docker
BROKER_INTERNAL_URL=http://localhost:8082
SECRET_PROVIDER=file_dev
```

## Dev compose services (outline)
`postgres`, `keycloak` (realm import), `vault` (dev mode + SSH engine init script), `control-plane`,
`connection-broker`, `ssh-target-1` (OpenSSH, known host key, trusts dev user CA), `ssh-target-evil`
(different host key, for mismatch tests), `otel-collector` (file exporter). All ports bound to `127.0.0.1`.

## `renovate.json`
```json
{ "extends": ["config:recommended", "helpers:pinGitHubActionDigests", "docker:pinDigests"],
  "packageRules": [{ "matchPackagePatterns": ["^@theia/"], "groupName": "theia",
                     "schedule": ["before 6am on the first day of the month"] }] }
```
