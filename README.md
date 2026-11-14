# Tabbold helper

The small program behind [Tabbold](https://tabbold.ewsme.com), the Chrome extension that sorts your tabs into projects and keeps notes on the pages you read. The extension can't write files on your computer; this helper does. It saves your notes and browsing sessions as plain Markdown in a folder you choose (made for [Tolaria](https://tolaria.md) vaults, works with any Markdown folder).

**Version 0.24.2** · MIT licence · macOS and Linux · Node.js 20+

## Install

Most people should use the one-line installer from the website:

```sh
curl -fsSL https://tabbold.ewsme.com/install.sh | bash -s -- --vault ~/Notes
```

From this repository:

```sh
npm install
scripts/install-host.sh --vault ~/Notes      # builds, installs and registers the helper with Chrome
scripts/install-host.sh --uninstall          # removes it; your notes are untouched
```

## What it can do

- Read and write Markdown files inside the one folder you gave it (paths are checked so nothing escapes it), and commit each change to git if that folder is a git repository.
- Talk only to the Tabbold extension: Chrome starts it through [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) and checks the extension's ID against `allowed_origins`.
- Nothing on the network, unless you turn on AI suggestions and give it an API key; then it contacts only the AI provider you configured, under a per-site policy you control (`config/browser-ai.md` in your vault).
- Delete nothing on its own. The one delete (a project, which you confirm in the extension) moves files to `.tabbold/trash/` in your vault, from where they can be restored.

## Layout

| Path | What |
|---|---|
| `bridge/src/main.ts` | Native messaging host: framing, request loop |
| `bridge/src/ops.ts` | Every operation the extension can ask for |
| `bridge/src/api.ts` | The request and response types (the protocol) |
| `bridge/src/vault/` | Reading, indexing and writing Markdown notes |
| `bridge/src/ai/` | Optional AI suggestions and summaries, and the per-site policy |
| `scripts/install-host.sh` | Installer for macOS and Linux |

## Develop

```sh
npm install
npm test          # unit and end-to-end tests against temporary vaults
npm run typecheck
```

## Security

Please report security issues privately to tabbold@ewsme.com rather than in a public issue.

## Licence

MIT. See [LICENSE](LICENSE). The Tabbold extension and the hosted server are separate and not covered by this repository.
