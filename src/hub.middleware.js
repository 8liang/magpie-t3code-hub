// Gateway middleware declaration for magpie-t3code-hub.
//
// The hub itself is a Bun HTTP listener started by the request-hooks module
// (src/hooks.ts) in Magpie's plugin host. Declaring this middleware gives the
// plugin its Middleware chip. It runs in moejs inside the gateway and leaves
// every request exactly as it came.
export function onRequest() {
  return undefined;
}
