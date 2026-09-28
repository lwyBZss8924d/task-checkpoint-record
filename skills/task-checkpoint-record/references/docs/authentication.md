> Package reference from `docs/authentication.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# Dedicated Codex authentication

Use a dedicated Codex home for service development, testing, evaluations and normal
operation. The suggested location is `~/.codex-task-checkpoint-record`; callers may
select another explicitly isolated directory. Keep its permissions private.

The unified configuration front door is documented in
[configuration.md](configuration.md). Set `codex.executable` and `codex.home` in the
same `task-checkpoint.config.v1` JSON file used by the recorder and helper, then
run `auth plan --config FILE`, inspect its exact `config_text` and `plan_sha256`,
and run `auth setup --config FILE --plan-sha256 REVIEWED_SHA`. Setup creates only a
new profile in an absent or private empty home. Existing profiles are preserved.
`auth login --config FILE` and `auth status --config FILE` execute the official
commands below with an isolated child environment and inherited terminal; the
wrapper does not capture authentication output.

For manual provisioning, inspect `config/codex-service.toml` before installing
those reviewed bytes as a new home's `config.toml`. The configured front door
instead generates the restricted profile from `src/model-policy.ts` and uses the
selected supervisor model/effort. Never overwrite an existing home or
configuration without an exact owned update plan. No credential file is copied
from another profile.

Run the standard login command with the dedicated home selected for that process:

```sh
env CODEX_HOME="$HOME/.codex-task-checkpoint-record" codex login --device-auth
```

Codex prints an authentication URL and a one-time code. The user opens the URL,
selects the intended ChatGPT account and enters that code. The user does not send
an access token, password or authentication-cache contents to an agent. Device-code
login may need to be enabled in the account/workspace security settings.

Confirm through the standard CLI rather than inspecting credential contents:

```sh
env CODEX_HOME="$HOME/.codex-task-checkpoint-record" codex login status
```

The CLI owns persistent credential storage and refresh. This project's code does
not read `auth.json`. Existing default/main/test Codex homes are unchanged.

Production supervisor defaults to `gpt-6-sol` with medium reasoning. Live tests and
evaluations explicitly request `gpt-6-luna` with high reasoning. Record the actual
model and reasoning effort; access and availability must be observed after login.
There is no automatic model/account fallback.

The service owns a `codex app-server` stdio child. This is separate from the Codex
CLI's native daemon bootstrap/install mechanism, which requires a complete Codex
package. The service must not silently bootstrap or replace a global installation.

Model jobs receive prepared synthetic or deliberately redacted artifacts. Local
RAW extraction is deterministic. Read-only sandbox mode does not by itself remove
tools or exclude other files; the adapter separately restricts capabilities and
rejects unsupported server requests or unexpected tool activity.

Sources: [Codex authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices),
[App Server](https://learn.chatgpt.com/docs/app-server),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
