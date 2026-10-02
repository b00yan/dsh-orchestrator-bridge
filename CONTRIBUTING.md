# Contributing

Use Node.js 22 or later and Git. This package has no third-party npm dependencies.
Run `npm test`, `npm run selftest`, and `npm pack --dry-run` from the project root.
Syntax-check changed JavaScript with `node --check <file>`.

Keep changes focused and explain the affected contract and validation in your pull
request. Add regressions for lifecycle, ownership, authentication, cancellation
or continuation changes, including refusal cases. Preserve bounded execution,
explicit review, and the single writer rule for each physical checkout.
Do not weaken permissions, silently increase budgets, or replay interrupted jobs.

Tests use fake Harness adapters and temporary repositories. A live smoke needs
an explicitly selected disposable checkout and authenticated Harness, and may
consume provider tokens. Report its exact versions and results separately from
mock tests; never commit session exports, credentials, job state or evidence.
Keep `package.json` and `cordis.patch.yml` package names consistent. Contributions
are provided under the [MIT license](LICENSE).
