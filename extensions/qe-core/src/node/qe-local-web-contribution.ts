import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

import {
  BackendApplicationContribution,
  EarlyExpressMiddleware,
} from '@theia/core/lib/node/backend-application';
import { WsRequestValidatorContribution } from '@theia/core/lib/node/ws-request-validators';
import { inject, injectable, type interfaces } from '@theia/core/shared/inversify';

import {
  allowsLocalWebUpgrade,
  listeningProblem,
  localWebMiddleware,
  takeLocalWebSecret,
  writeSignInLink,
  type LocalWebSecret,
} from './qe-local-web-auth';

export const LocalWebSecretToken = Symbol('LocalWebSecret');

/** sysexits.h EX_CONFIG, as for an invalid environment. */
const EXIT_CONFIG_ERROR = 78;

/**
 * Local web mode's guard (qe-local-web-auth.ts): early middleware ahead of everything Theia serves, the same check on
 * every WebSocket and Socket.IO handshake, and a refusal to run on anything but loopback.
 */
@injectable()
export class QeLocalWebContribution
  implements BackendApplicationContribution, WsRequestValidatorContribution
{
  @inject(LocalWebSecretToken) protected readonly secret!: LocalWebSecret;
  @inject(EarlyExpressMiddleware) protected readonly early!: EarlyExpressMiddleware;

  initialize(): void {
    // First of all: ahead of Theia's own connection-token middleware too, which hands its cookie to any request.
    this.early.handlers.unshift(localWebMiddleware(this.secret));
  }

  allowWsUpgrade(request: Parameters<WsRequestValidatorContribution['allowWsUpgrade']>[0]): boolean {
    return allowsLocalWebUpgrade(this.secret, request);
  }

  async onStart(server: HttpServer | HttpsServer): Promise<void> {
    const address = server.address();
    const problem = listeningProblem(address, process.env);
    if (problem !== undefined) {
      console.error(`QE Workspace cannot start. ${problem}`);
      process.exit(EXIT_CONFIG_ERROR);
    }
    const port = address !== null && typeof address === 'object' ? address.port : undefined;
    if (this.secret.provided) {
      console.info('QE Workspace (local web) is ready: open the sign-in link qe-workspace-local showed.');
    } else if (port !== undefined) {
      // Never printed or logged: the link is the run's credential.
      // localhost, not 127.0.0.1: webviews open on their own <id>.webview.localhost origin (qe-local-web-auth.ts).
      const file = await writeSignInLink(`http://localhost:${String(port)}/?token=${this.secret.token}`);
      console.info(`QE Workspace (local web) is ready. Its sign-in link is in ${file}.`);
    }
  }
}

/** Local web mode only: reads (and removes) the run's token from the environment now, at backend load. */
export function bindLocalWebAuth(bind: interfaces.Bind, env: NodeJS.ProcessEnv = process.env): void {
  let secret: LocalWebSecret;
  try {
    secret = takeLocalWebSecret(env);
  } catch (error) {
    console.error(
      `QE Workspace cannot start. ${error instanceof Error ? error.message : 'invalid local web token'}`,
    );
    return process.exit(EXIT_CONFIG_ERROR);
  }
  bind(LocalWebSecretToken).toConstantValue(secret);
  bind(QeLocalWebContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(QeLocalWebContribution);
  bind(WsRequestValidatorContribution).toService(QeLocalWebContribution);
}
