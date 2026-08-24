# End-to-end web deployment workflows

Elia’s Tech and Production workflows can now carry a web project through a governed lifecycle: inspect the repository, implement changes, run the project’s verification commands, build locally, deploy a preview, verify the returned live URL, and—only after an exact approval—deploy to production.

This is an adapter around the project’s explicitly linked Vercel or Netlify CLI project. It is not a project-provisioning system. Elia will not create a provider account, guess a destination, connect a Git repository, modify provider environment variables, manage domains, or claim that a deployment succeeded without provider output and a successful HTTPS check.

## Provider behavior

| Provider | Local link required | Preview behavior | Production behavior | URL evidence |
|---|---|---|---|---|
| Vercel | `.vercel/project.json` | Runs `vercel deploy --yes`; Vercel prints the deployment URL to stdout. | Runs `vercel deploy --prod --yes`; production is a critical external side effect. | HTTPS URL on a Vercel default hostname |
| Netlify | `.netlify/state.json` or a valid `NETLIFY_SITE_ID` | Runs `netlify deploy --json`; this is a draft deploy by default. | Runs `netlify deploy --prod --json`; production is a critical external side effect. | HTTPS URL on a Netlify default hostname |

Vercel documents separate Local, Preview, and Production environments and states that a CLI deployment produces a unique URL; its CLI documentation also distinguishes ordinary deploys from `--prod` deployments.[1] Netlify documents draft deploys as the default for manual deploys and uses `--prod` for a production deploy.[2] Both providers document CLI/API deployment interfaces suitable for automation, but provider authorization and account access remain environment-specific.[1] [2] [3]

## Tool lifecycle

The `deployment` tool accepts four actions:

```json
{"action":"plan","provider":"vercel","target":"preview"}
```

`plan` performs a local readiness check. It reports whether the provider CLI is available, whether the project is explicitly linked, whether a package build script exists, and whether a provider credential is present without exposing its value. It does not make a network request or mutate provider state.

```json
{"action":"build","provider":"vercel"}
```

`build` runs the repository’s declared package-manager build script when one exists. It recognizes pnpm, Yarn, Bun, and npm lockfiles. If no package build script exists, it falls back to the provider’s local build command when the provider CLI is available. Build output is bounded, cancellation-aware, and stored in the local deployment receipt.

```json
{"action":"deploy","provider":"netlify","target":"preview"}
```

A preview deploy is reviewable external work. The provider CLI must be installed and the project must be linked. The tool returns structured status, bounded output, and a deployment URL when the provider reports one.

```json
{"action":"verify","provider":"netlify","url":"https://example.netlify.app"}
```

`verify` performs a bounded HTTPS GET and follows redirects. It accepts only the provider’s default deployment hostnames, rejects credentials in URLs, refuses private or link-local hosts, limits the response body, and reports the HTTP status and bounded response evidence.

## Approval and unattended behavior

Elia’s existing action governor and durable action contracts remain authoritative. Production deployment is classified as **critical**, is non-reversible at the application boundary, requires an exact approval immediately before execution, and requires a deployed-status postcondition. Unattended execution blocks it rather than silently accepting a callback. Preview deployment, local build, planning, and HTTPS verification remain reviewable or bounded steps according to the normal governance mode.

A deployment receipt is appended to `.elia/deployments.jsonl` in the active workspace. The receipt records the provider, action, target, timestamp, command when applicable, status, bounded output, URL evidence, and HTTP status. Credential values are never written to the receipt.

## Recommended end-to-end sequence

For a new or changed web project, Elia should first inspect the repository and run the declared tests, type checks, lint, and build scripts. It should then run `deployment.plan`, repair any missing local prerequisites, run `deployment.build`, and create a preview deployment. After preview verification, the user can inspect or review the live URL. A production deploy must be a separate explicit action with the exact provider and target stated in the approval boundary, followed by a fresh verification of the production URL.

This separation matters because a successful local build is not proof of provider authorization, a successful provider upload is not proof that the live site is healthy, and a preview URL is not the same thing as a production release.

## Current limits

The CLI must be installed and the project must already be linked by the operator. Elia does not perform interactive provider login, create projects, select among multiple account destinations, upload secrets, change deployment settings, attach custom domains, configure continuous deployment, or roll back a production deployment through this first adapter. Those operations can be added later behind separate explicit contracts; they should not be hidden inside a generic deploy action.

The implementation is independently authored TypeScript. It does not copy Vercel, Netlify, or third-party CLI source code. Provider CLIs remain external dependencies installed and managed by the user’s project environment.

## References

[1]: https://vercel.com/docs/deployments "Vercel: Deploying to Vercel"

[2]: https://docs.netlify.com/cli/get-started/ "Netlify: Get started with Netlify CLI"

[3]: https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/ "Netlify: Get started with the Netlify API"
