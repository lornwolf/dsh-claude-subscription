# Repository Guidelines

## Project Structure & Module Organization

This package connects Claude subscriptions to DeepSeek Harness (DSH). `lib/index.js` registers the plugin, provider, and tools; `lib/client.js` implements the settings panel. Authentication and account storage live in `oauth.js`, `login.js`, and `accounts.js`. Request adaptation lives in `context.js`, `fingerprint.js`, `persona.js`, `text-filter.js`, and `empty-response.js`; RPC, profile, and quota handling have separate modules.

`test/` contains offline tests and host integration helpers. `cordis.patch.yml` registers the bundle. `README.md` documents installation and configuration. There is no separate asset directory or generated source tree.

## Build, Test, and Development Commands

- `npm test`: runs `node --test test/*.test.mjs`.
- `node --test test/accounts.test.mjs`: runs one focused suite.
- `npm pack`: creates the plugin archive for installation in a DSH profile; generated `*.tgz` files are ignored.
- `node --loader ./test/host-loader.mjs ./test/plugin-smoke.mjs`: runs host integration checks after setting `DSH_TEST_HOST_ROOT` to a disposable or read-only installed DSH package root.

There is no build step or standalone development server. Run the plugin through DSH with compatible peer dependencies listed in `package.json`.

## Coding Style & Naming Conventions

Use JavaScript ES modules, explicit `.js` relative imports, double quotes, and semicolons. Match nearby indentation: most library files use tabs; some tests use two spaces. Use camelCase for functions and variables, PascalCase for classes, and UPPER_SNAKE_CASE for constants. Keep filenames lowercase with hyphens. No formatter or linter is configured.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name suites `*.test.mjs` and describe observable behavior in test names. Mock network responses and use disposable storage with fake credentials. Cover affected cancellation, concurrency, error sanitization, and request contracts. No numerical coverage threshold is configured.

Real SDK suites skip when pi-ai is unavailable. Set `PI_AI_PACKAGE_ROOT` to require them; an invalid explicit path fails the suite.

## Commit & Pull Request Guidelines

The available history contains one commit, `feat: dsh-claude-subscription 0.1.4`. Follow its type-prefixed style with concise, descriptive subjects. PRs should explain behavior changes, link relevant issues, report test results and skips, and include screenshots for settings-panel changes.

## Security & Configuration

Keep OAuth tokens and account storage in the host process. Never commit credentials or expose tokens, raw upstream error bodies, or private account data through browser RPC or logs. Preserve vault transaction serialization when changing account operations.
