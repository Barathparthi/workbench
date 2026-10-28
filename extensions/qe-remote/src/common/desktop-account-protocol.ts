/**
 * The desktop app's sign-in to QE Workspace (PHASE_10 §10.4), as the frontend sees it: a status and two actions. The
 * tokens stay in the Electron backend — none of them ever crosses this service.
 */
export const DESKTOP_ACCOUNT_PATH = '/services/qe-desktop-account';

export type DesktopAccountStatus =
  /** No control plane is configured: managed targets are not offered. */
  | { readonly state: 'not-configured' }
  | { readonly state: 'signed-out' }
  | {
      readonly state: 'signed-in';
      readonly username: string;
      readonly displayName: string;
      /** false: the OS offers no secure storage, so the sign-in lasts until the app closes. */
      readonly remembered: boolean;
    };

export const DesktopAccountService = Symbol('DesktopAccountService');
export interface DesktopAccountService {
  /** The current state; restores a remembered sign-in on first use. */
  status(): Promise<DesktopAccountStatus>;
  /** Opens the system browser at the IdP and resolves once the user is back (or fails, or gives up). */
  signIn(): Promise<DesktopAccountStatus>;
  signOut(): Promise<void>;
}
