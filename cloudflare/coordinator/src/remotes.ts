// Which repository URLs may carry a coordinator-minted credential: a Cloudflare Artifacts remote, or a
// Smith-hosted repository on this coordinator (<origin>/git/<project>.git). Everything else is cloned with
// the machine's own Git login. One predicate, so the Worker, the project code and the tests cannot drift.
import { isArtifactsRemote } from './artifacts-repos';
import { smithRemoteRepo } from './git-host';

export function isCredentialedRemote(url: string, origin: string): boolean {
  return isArtifactsRemote(url) || smithRemoteRepo(url, origin) !== null;
}
export { isArtifactsRemote, smithRemoteRepo };
