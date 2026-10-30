import type { AuthContext } from '../auth/sessions.js';
import { emailVerificationRequired, type RouteContext } from '../routes/context.js';
import { readSetting } from './settings.js';

/** Independent of billing: self-hosted relay remains free. */
export async function agentRelayCapability(context: RouteContext, auth: AuthContext) {
  const platform = await readSetting(context.db, 'platform');
  return {
    protocol: 1 as const,
    enabled: true,
    canConnect: !emailVerificationRequired(platform) || Boolean(auth.user.email_verified),
    hostLimit: context.config.agentRelay.hostLimit,
  };
}
