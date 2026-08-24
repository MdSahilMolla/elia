# Elia Autonomous Engineering for VS Code

This extension is the native VS Code client for Elia’s existing Bun/TypeScript autonomous engineering runtime. It provides a full editor surface without creating a second agent implementation inside VS Code.

## Features

The extension provides an Elia engineering panel with streamed chat and tool activity, current-workspace and selected-code context, autonomous goal runs, task/run/skill tree views, skill and bundle selection, environment readiness inspection, pause/stop/resume controls, live receipts, and governed Vercel/Netlify deployment actions.

The standard workflow is:

> inspect → plan → delegate → edit → review diff → test/typecheck/build → deploy preview → verify live URL → request exact production approval → deploy production → verify again

All model calls and tool actions remain in Elia. The extension only renders context, sends requests, and displays structured results. Existing action governance, worktree isolation, secret redaction, durable run state, action contracts, cancellation, and receipts remain authoritative.

## Requirements

| Requirement | Details |
|---|---|
| VS Code | Version 1.95 or later |
| Elia | The repository’s v2 runtime with `elia bridge` support |
| Runtime | Bun for a TypeScript checkout, or an installed compiled `elia` executable |
| Workspace | An open local workspace; the bridge uses the first workspace folder as its working root |
| Provider | A configured Elia model provider for chat and autonomous work |
| Deployment | An already-linked Vercel or Netlify project and authenticated provider CLI for release actions |

## Development installation

From the Elia repository:

```sh
cd extensions/vscode
pnpm install
pnpm run compile
```

Use VS Code’s **Run Extension** launch flow from a development checkout, or package it with `vsce` after installing the VS Code Extension Manager in the development environment.

By default the extension launches `elia bridge --json` from the configured `elia.cliPath`. For a local checkout, set `elia.cliPath` to the absolute path of `bin/elia.ts`; the extension will launch it with Bun. For a globally installed executable, leave `elia.cliPath` as `elia`.

## Configuration

| Setting | Default | Purpose |
|---|---:|---|
| `elia.cliPath` | `elia` | Elia executable or absolute TypeScript entrypoint |
| `elia.runtime` | `auto` | Runtime selection for a TypeScript entrypoint |
| `elia.autoStartBridge` | `true` | Start the local bridge when the workspace opens |
| `elia.defaultMode` | `dev` | Default editor mode |
| `elia.governanceMode` | `supervised` | Approval behavior for editor chat |
| `elia.profile` | `balanced` | Autonomous run profile |
| `elia.maxRunMs` | `1800000` | Autonomous wall-clock bound |
| `elia.maxActions` | `300` | Autonomous governed-action bound |
| `elia.deploymentProvider` | `auto` | Default Vercel/Netlify provider choice |
| `elia.showThinking` | `false` | Whether to display streamed reasoning deltas |

The extension does not store provider API keys in VS Code settings and does not send them to the webview. Elia’s process reads its normal environment and user configuration.

## Bridge security

The extension uses one JSON object per line over the child process’s stdin/stdout. The bridge runs with the workspace as its working directory and is not a network server. No TCP port is opened. The bridge validates request sizes, IDs, modes, run controls, provider names, deployment URLs, and skill selections. Deployment verification accepts HTTPS provider default hostnames only.

The VS Code webview uses a restrictive content-security policy, does not load remote resources, renders tool output as text rather than HTML, and sends only explicit user actions back to the extension host.

## Release controls

Preview deployment is reviewable external work. Production deployment is a critical action. Elia blocks production release in unattended mode and requires an exact approval request in supervised mode immediately before provider execution. The extension’s production button adds a local confirmation, but that is not a replacement for Elia’s governor; both boundaries remain active.

Elia requires an existing provider link and does not create projects, select accounts, perform interactive login, upload environment variables, change domains, or claim a successful release without provider output and an HTTPS postcondition. Deployment receipts are stored by Elia in `.elia/deployments.jsonl`.

## Current scope

This first full client exposes the real Elia runtime through a stable local bridge. It does not duplicate Elia’s model/provider layer, autonomous planner, specialist system, or governance implementation. Future iterations can add native diff review, a richer task graph, Problems-panel diagnostics, editor code actions, and a webview preview while continuing to use the same bridge contracts.
