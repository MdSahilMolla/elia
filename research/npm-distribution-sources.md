# Public distribution sources

The release design used official documentation retrieved on 2026-08-24.

## Sources

1. Bun publish documentation: https://bun.com/docs/pm/cli/publish

   Bun documents `bun publish` as publishing to the npm registry. It supports `--dry-run`, `--access public`, package `publishConfig`, and `NPM_CONFIG_TOKEN`. Bun packs the package before publishing and can also publish a tarball produced by `bun pm pack`.

2. npm package.json documentation: https://docs.npmjs.com/cli/v11/configuring-npm/package-json/

   npm documents the required `name` and `version`, the `bin` field for installed executables, the `files` field for package contents, repository metadata, and custom license declarations such as `SEE LICENSE IN LICENSE`. It also documents that a bin target should start with an executable shebang.

3. npm unscoped public package guidance: https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/

   npm recommends reviewing package contents for secrets and unnecessary files, testing installation from a local package path, and authenticating with 2FA or an appropriate access token before publishing. The live publication was intentionally not attempted because the container did not have npm registry authentication.

## Repository verification

- `npm view elia` returned HTTP 404, so the unscoped name appeared available at audit time.
- `npm pack --dry-run` and `bun pm pack` produced an `elia-0.1.0.tgz` package containing 113 entries, including the README, `.env.example`, `bin/elia.ts`, and runtime `src` files, with zero `*.test.ts` files.
- Installing the packed tarball into a temporary npm project succeeded, and `./node_modules/.bin/elia --version` returned `0.1.0`.
- `bun publish --dry-run --access public` ran the `prepublishOnly` verification suite successfully with 500 passing tests, then stopped at the expected missing-authentication error: `missing authentication (run bunx npm login)`.
