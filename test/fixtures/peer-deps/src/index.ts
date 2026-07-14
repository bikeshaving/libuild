// The peer dependency is deliberately NOT installed in node_modules.
// Both the ESM and CJS builds must externalize it rather than resolve it,
// otherwise esbuild fails with "Could not resolve" (the CI failure mode) or
// inlines a second copy of the peer package into the output.
import {greet} from "@fictional-scope/peer-lib";

export function welcome(name: string): string {
  return greet(name);
}
