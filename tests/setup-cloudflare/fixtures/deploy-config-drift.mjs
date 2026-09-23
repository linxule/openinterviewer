// The real deploy.mjs precondition functions. The setup tests check every
// generated installation config against the exact rules deploy.mjs runs.
export { configDrift as realConfigDrift, missingInstallationVars } from '../../../scripts/cloudflare/deploy.mjs';
