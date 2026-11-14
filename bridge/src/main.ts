import { loadConfig } from "./config.ts";
import { cancelAll, createHandlers, dispatch } from "./ops.ts";
import { listen } from "./protocol.ts";
import { tolaria } from "./vault/profile.ts";
import { Vault } from "./vault/vault.ts";

// Chrome launches this process and talks over stdin/stdout. Anything written
// to stdout that isn't a framed message corrupts the channel, so all logging
// goes to stderr (visible in chrome://extensions → service worker logs).
console.log = console.error;

try {
  const cfg = loadConfig();
  const vault = new Vault(cfg.vault, tolaria);
  const handlers = createHandlers(vault, cfg);
  listen(process.stdin, process.stdout, (msg, send) => dispatch(handlers, msg, send), () => cancelAll(handlers));
} catch (err) {
  // Report config problems to the extension instead of dying silently.
  const error = (err as Error).message;
  listen(process.stdin, process.stdout, async (msg) => ({
    id: (msg as { id?: number })?.id ?? -1,
    ok: false,
    error,
    code: "INTERNAL",
  }));
}
