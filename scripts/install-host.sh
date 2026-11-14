#!/usr/bin/env bash
# Install (or uninstall) the Tabbold native messaging host for Chromium browsers.
#
#   scripts/install-host.sh --vault ~/Notes            # install
#   scripts/install-host.sh --vault ~/Notes --no-git   # don't auto-commit
#   scripts/install-host.sh --uninstall
#   scripts/install-host.sh --update                   # after pulling new code (npm run update does this)
#
# Options:
#   --vault PATH          Your markdown vault (e.g. your Tolaria vault). Required to install.
#   --extension-id ID     Override the extension ID (default: fixed ID from the manifest key).
#   --no-git              Don't commit each save to git.
#   --proxy URL           Proxy for AI calls, e.g. http://proxy.example:8080. Default: your shell's
#                         HTTPS_PROXY/HTTP_PROXY if set (Chrome doesn't pass these to the helper).
#   --no-proxy            Don't use a proxy even if your shell has one.
#   --uninstall           Remove the host registration and installed files.
#   --update              Reinstall the helper with your current settings (vault, git), e.g. after an update.
#   --extension-id ID     Also allow this extension ID (e.g. a different build). Repeatable.
#
# The helper always accepts both the developer build ("Load unpacked", fixed ID)
# and the Chrome Web Store build (STORE_EXT_ID below, once published).
set -euo pipefail

HOST_NAME="sg.wansong.tabbold_bridge"
DEFAULT_EXT_ID="coonaopbmjcleifechgadaobndnhifmd"   # developer build (manifest "key")
# The Chrome Web Store assigns its own ID on first upload; put it here once known.
STORE_EXT_ID="${TABBOLD_STORE_EXT_ID:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VAULT=""
EXT_IDS=("$DEFAULT_EXT_ID")
[[ -n "$STORE_EXT_ID" ]] && EXT_IDS+=("$STORE_EXT_ID")
EXT_ID="$DEFAULT_EXT_ID"
GIT_COMMIT=true
UNINSTALL=false
UPDATE=false
PROXY=""
NO_PROXY_FLAG=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) VAULT="$2"; shift 2 ;;
    --extension-id) EXT_IDS+=("$2"); shift 2 ;;
    --no-git) GIT_COMMIT=false; shift ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --no-proxy) NO_PROXY_FLAG=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    --update) UPDATE=true; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -s)" in
  Darwin)
    SUPPORT="$HOME/Library/Application Support"
    INSTALL_DIR="$SUPPORT/Tabbold"
    BROWSER_DIRS=(
      "$SUPPORT/Google/Chrome"
      "$SUPPORT/Google/Chrome Beta"
      "$SUPPORT/Google/Chrome Canary"
      "$SUPPORT/Chromium"
      "$SUPPORT/BraveSoftware/Brave-Browser"
      "$SUPPORT/Microsoft Edge"
      "$SUPPORT/Arc/User Data"
    )
    ;;
  Linux)
    INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tabbold"
    CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSER_DIRS=(
      "$CFG/google-chrome"
      "$CFG/google-chrome-beta"
      "$CFG/chromium"
      "$CFG/BraveSoftware/Brave-Browser"
      "$CFG/microsoft-edge"
    )
    ;;
  *) echo "Unsupported OS: $(uname -s). Windows support is not implemented yet." >&2; exit 1 ;;
esac

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tabbold"

if $UNINSTALL; then
  for dir in "${BROWSER_DIRS[@]}"; do
    rm -f "$dir/NativeMessagingHosts/$HOST_NAME.json"
  done
  rm -rf "$INSTALL_DIR"
  echo "Removed Tabbold bridge. Your config at $CONFIG_DIR and your notes are untouched."
  exit 0
fi

if $UPDATE && [[ -z "$VAULT" ]]; then
  # Reuse what you installed with: vault and git setting from the helper's config.
  [[ -f "$CONFIG_DIR/config.json" ]] || { echo "Tabbold isn't installed yet. Run the installer with --vault /path/to/your/vault" >&2; exit 1; }
  VAULT="$(node -p 'require(process.argv[1]).vault || ""' "$CONFIG_DIR/config.json")"
  [[ "$(node -p 'require(process.argv[1]).gitCommit !== false' "$CONFIG_DIR/config.json")" == "true" ]] || GIT_COMMIT=false
  [[ -n "$VAULT" ]] || { echo "No vault in $CONFIG_DIR/config.json. Run: scripts/install-host.sh --vault /path/to/your/vault" >&2; exit 1; }
fi
[[ -n "$VAULT" ]] || { echo "--vault is required (path to your markdown vault)" >&2; exit 1; }
VAULT="${VAULT/#\~/$HOME}"
[[ -d "$VAULT" ]] || { echo "Vault folder not found: $VAULT" >&2; exit 1; }
VAULT="$(cd "$VAULT" && pwd)"

# Chrome starts hosts with a minimal PATH (no Homebrew/nvm), so pin the node binary.
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "Node.js 20+ is required but 'node' was not found on PATH." >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || { echo "Node.js 20+ required (found $("$NODE_BIN" -v))." >&2; exit 1; }

if [[ -f "$REPO/package.json" ]]; then
  echo "Building bridge…"
  ( cd "$REPO" && npm install --include=dev --no-audit --no-fund --silent && npm run build -w bridge --silent )
else
  # A downloaded helper bundle (tabbold.ewsme.com/download): main.js is already built.
  [[ -f "$REPO/bridge/dist/main.js" ]] || { echo "This bundle is missing bridge/dist/main.js" >&2; exit 1; }
fi

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
cp "$REPO/bridge/dist/main.js" "$INSTALL_DIR/main.js"

# Networking for AI calls. Chrome starts the helper with almost no environment,
# so bake in what it needs: your system's certificates (work networks often
# re-sign HTTPS) and a proxy if there is one.
supports() { "$NODE_BIN" "$1" -e 0 >/dev/null 2>&1; }
NODE_FLAGS=""
SYSTEM_CA=no
if supports --use-system-ca; then NODE_FLAGS="$NODE_FLAGS --use-system-ca"; SYSTEM_CA=yes; fi
if ! $NO_PROXY_FLAG && [[ -z "$PROXY" ]]; then PROXY="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"; fi
$NO_PROXY_FLAG && PROXY=""
PROXY_ENV=""
if [[ -n "$PROXY" ]]; then
  if supports --use-env-proxy; then
    NODE_FLAGS="$NODE_FLAGS --use-env-proxy"
    supports --disable-warning=UNDICI-EHPA && NODE_FLAGS="$NODE_FLAGS --disable-warning=UNDICI-EHPA"
    NOPROXY_LIST="${NO_PROXY:-${no_proxy:-}}"
    NOPROXY_LIST="localhost,127.0.0.1,::1${NOPROXY_LIST:+,$NOPROXY_LIST}"
    PROXY_ENV="export HTTPS_PROXY='$PROXY' HTTP_PROXY='$PROXY' NO_PROXY='$NOPROXY_LIST'"
  else
    echo "Warning: your Node ($("$NODE_BIN" -v)) can't send requests through a proxy. Install Node 22.21+ or 24+ for AI behind a proxy." >&2
    PROXY=""
  fi
fi

WRAPPER="$INSTALL_DIR/tabbold-bridge"
cat > "$WRAPPER" <<EOF
#!/bin/sh
$PROXY_ENV
exec "$NODE_BIN"$NODE_FLAGS "$INSTALL_DIR/main.js" "\$@" 2>>"$INSTALL_DIR/bridge.log"
EOF
chmod 755 "$WRAPPER"

# Merge into any existing config so settings like "ai" survive a reinstall.
"$NODE_BIN" -e '
  const fs = require("fs");
  const [file, vault, git] = process.argv.slice(1);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  cfg.vault = vault;
  cfg.gitCommit = git === "true";
  cfg.webFolder = cfg.webFolder || "web";
  cfg.sessionFolder = cfg.sessionFolder || "sessions";
  if (!cfg.ai) cfg.ai = { provider: "off" };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "$CONFIG_DIR/config.json" "$VAULT" "$GIT_COMMIT"

# Every extension ID allowed to talk to the helper (deduplicated, validated).
ORIGINS=$(printf '%s\n' "${EXT_IDS[@]}" | awk '/^[a-p]{32}$/ && !seen[$0]++ { printf "%s\"chrome-extension://%s/\"", (n++ ? ", " : "["), $0 } END { print "]" }')
MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Tabbold browser-to-vault bridge",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": $ORIGINS
}
EOF
)

registered=0
for dir in "${BROWSER_DIRS[@]}"; do
  # Always register for Google Chrome; others only if installed.
  if [[ -d "$dir" || "$dir" == *"Google/Chrome" || "$dir" == *"google-chrome" ]]; then
    mkdir -p "$dir/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
    echo "  registered: $dir"
    registered=$((registered + 1))
  fi
done

# Smoke test: send a framed ping and read the reply.
REPLY="$("$NODE_BIN" -e '
  const { spawn } = require("child_process");
  const c = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "inherit"] });
  const body = Buffer.from(JSON.stringify({ id: 1, op: "ping", args: {} }));
  const h = Buffer.alloc(4); h.writeUInt32LE(body.length);
  c.stdin.write(Buffer.concat([h, body]));
  let buf = Buffer.alloc(0);
  c.stdout.on("data", d => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      console.log(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString()); c.kill(); process.exit(0);
    }
  });
  setTimeout(() => { console.log("{\"ok\":false,\"error\":\"timeout\"}"); c.kill(); process.exit(1); }, 5000);
' "$WRAPPER")"

echo
echo "Bridge installed in $INSTALL_DIR ($registered browser(s))."
echo "Vault: $VAULT"
echo "Network for AI: ${PROXY:+proxy $PROXY, }system certificates: $SYSTEM_CA"
echo "Self-test: $REPLY"
echo
if $UPDATE; then
  echo "Updated. The extension reloads itself to match within a minute, or right away when you open"
  echo "the Tabbold side panel. (Or click ↻ on Tabbold in chrome://extensions.)"
elif [[ -f "$REPO/package.json" ]]; then
  echo "Next: open chrome://extensions, turn on Developer mode, 'Load unpacked' → $REPO/extension/dist"
  echo "Extension ID should be $EXT_ID. Then click the Tabbold toolbar icon (or Alt+T)."
else
  echo "Done. Next: add Tabbold to Chrome (https://tabbold.ewsme.com/download/), then click its toolbar icon."
  echo "If Chrome was already open with Tabbold, reopen the side panel to connect."
fi
