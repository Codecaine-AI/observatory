# Observatory

Observatory is a local development UI for browsing agent catalogs, prompts,
and kernel traces across registered Codecaine projects. It reads trace SQLite
databases directly and proxies catalog requests to each project's running
harness.

Viewer functionality follows the [viewer layering policy](docs/VIEWER-LAYERING.md).

## Run

```sh
bun install
bun run dev
```

Open <http://127.0.0.1:4891>. The API listens on
<http://127.0.0.1:4890>.

On startup, each project with `autoLaunch: true` is health-checked and its
harness is started when offline. Opening Observatory is therefore enough to
bring the registered Canvas, Simple Research, and Prompt Kit harnesses online;
no harness terminals are required.

## Register a project

Edit the machine-local `registry.json` and add an entry to `projects`:

```json
{
  "id": "my-project",
  "name": "My Project",
  "kernelRoot": "../my-project/.agent-kernel",
  "dbPath": null,
  "catalogRoots": ["../my-project/src/agent-catalog"],
  "readApiBaseUrl": "http://127.0.0.1:8788",
  "viewerBaseUrl": null,
  "extensionPackage": null,
  "launchCommand": "bun run --cwd ../my-project api",
  "autoLaunch": true,
  "writable": true
}
```

Relative paths resolve from the directory containing `registry.json`.
`launchCommand` uses the same base: Observatory passes the command to a
non-login system shell with the directory containing `registry.json` as its
working directory and inherits Observatory's environment except for the
generic listener variables `PORT`, `HOST`, and `HOSTNAME`. Set a
harness-specific variable or an inline environment assignment in
`launchCommand` when a project needs a non-default listener. `autoLaunch`
defaults to `false`; when true, Observatory starts the command only if the
project's `/health` endpoint is not already live.

Observatory only stops processes it launched. A harness that was already live
remains unmanaged, and Observatory will never stop or replace it. Harnesses
remain the sole writers of prompt and catalog state; the launcher only owns
their process lifecycle.

`registry.example.json` is a resettable starting point; `registry.json` stays
untracked because its paths and ports are machine-local.
