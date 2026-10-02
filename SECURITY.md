# Security

This bridge is for trusted local development. It is not a sandbox for mutually
untrusted code. Workers execute file and shell tools using Harness permissions.
The adapter pins workspace-write / ask and audits Git-visible ownership; ignored
files and transient edits are outside the Git audit. Shell reads outside the
checkout and unowned writes inside it are not prevented by an owned-path sandbox.
Review changes independently before accepting results.

The HTTP endpoint binds loopback and uses a generated token. Connection descriptors
are mode 0600 on POSIX. Keep the entire state directory private: it contains tokens,
tickets, summaries, patches, paths and review evidence. It is ignored by default.
If state is configured elsewhere, protect and exclude that directory yourself.
The MCP client does not need a new provider key; worker requests use the configured
Harness account and send task/code context to that provider. Budgets bound loop
steps rather than every retry, auxiliary request, token or monetary charge.

Do not put credentials in tickets, prompts or bug reports. If a credential leaks,
stop the bridge and rotate it. Restarting generates a new loopback token; exposed
provider credentials must be revoked through their provider. Never attach raw
connection files, state.json, session exports or unredacted diffs to public issues.

Report vulnerabilities privately through the repository's GitHub Security advisory
feature if its maintainers enable it, or a private maintainer contact listed there.
No private reporting address is configured in this source distribution. Do not
publish exploit details or secrets in a public issue while arranging private contact.
