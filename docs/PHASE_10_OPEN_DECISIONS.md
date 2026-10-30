# QE Workspace — Open Decisions Before the Desktop Release (Phase 10)

**Date:** 2026-10-30 · **Status:** waiting on the organisation · **Record of decisions:** `docs/ORG_DECISIONS.md`

Phase 10 (the desktop app and the local web mode) is built and tested. Gate 10a passed; gate 10b is conditional on the
four decisions below. Each one is the organisation's to make: they involve company certificates, company identity,
IT distribution policy and company DNS. The software is already built to use the answers from configuration, so no
further development is needed once they are given.

## Summary

| Item                    | What it blocks                                                    | Who decides                              | Urgency                                      |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **D15 — code signing**  | Giving the desktop app to real users at all                       | Security / PKI team, Apple account owner | High — needed for any desktop rollout        |
| **D16 — app identity**  | The first real release (cannot be changed afterwards)             | Product owner / IT naming standards      | High — decide before the first release       |
| **D17 — updates**       | Keeping installed apps patched                                    | IT / desktop management team             | Medium — before a wide rollout               |
| **D9 — webview domain** | Markdown preview and extension panels in the browser (hosted) IDE | Network / DNS and PKI teams              | Medium — by production deployment (Phase 16) |

## D15 — Code-signing certificates (Windows and macOS)

**What it is.** A code-signing certificate is a digital ID, issued to the company by a trusted authority, that is
stamped onto the installer. It tells the operating system who made the program and that nobody has changed it since.

**Why it is needed**

- **Windows:** unsigned installers trigger SmartScreen's "Windows protected your PC — unknown publisher" warning. Many
  corporate machines block unsigned software outright through security policy.
- **macOS:** Apple's Gatekeeper refuses to open apps that are not signed with an Apple Developer ID and notarized
  (scanned and approved by Apple). Users see "cannot be opened because the developer cannot be verified"; on managed
  Macs there is usually no way around it.
- **Security:** a signature proves the installer is the one the company's build produced. Without it, a tampered
  installer looks exactly like a real one.

**Without it.** The installers built today work but are unsigned. They are fine for internal testing and cannot be
given to real users.

**What to ask for**

- **Windows:** an Authenticode code-signing certificate — EV (Extended Validation) preferred, as it clears SmartScreen
  immediately. Usually from the company's PKI or security team, or bought from a certificate authority such as
  DigiCert or Sectigo.
- **macOS:** an Apple Developer Program membership for the company, with a "Developer ID Application" certificate, plus
  an Apple ID and team ID for notarization.
- They are stored as CI secrets (`QE_CSC_LINK`, `QE_CSC_KEY_PASSWORD`, `QE_APPLE_ID`, `QE_APPLE_APP_SPECIFIC_PASSWORD`,
  `QE_APPLE_TEAM_ID`). The build pipeline is already wired to use them.

## D16 — App identity (app id, maintainer email, homepage)

**What it is.** Every installed application carries identity details:

- **App id** — a unique name such as `com.yourcompany.qe-workspace`. Windows and macOS use it to recognise the app
  across updates, store its settings, and tell it apart from other apps.
- **Maintainer email** — Linux packages (`.deb`) must name a responsible contact.
- **Homepage** — shown in package managers and in the app's "About" information.

**Why it is needed**

- **The app id is effectively permanent.** If the app ships with one id and it changes later, the operating system
  treats the new version as a different program: user settings are lost, two copies may end up installed, and
  updates will not replace the old version. It must be right before the first real release.
- The current values are placeholders that let the build work: `corp.qe.workspace`, `qe-workspace@corp.invalid`
  (deliberately not a real address) and the source repository's URL. They are not suitable for shipping.
- Code signing (D15) is tied to this identity, so the two go together.

**What to ask for.** The company's naming convention for app ids (usually its reversed domain name, e.g.
`com.company.qe-workspace`), a support mailbox for the maintainer field, and the product's internal homepage or
documentation URL.

## D17 — How desktop updates reach users

**What it is.** Once people install the desktop app, new versions — bug fixes and security fixes — have to reach them.
There are two standard ways:

|                         | Software centre / MDM                                                                            | Auto-update                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **How it works**        | IT pushes each new version through its management tools (Intune, SCCM, Jamf, Linux repositories) | The app checks a company server, downloads the new version and installs it                                 |
| **Who controls timing** | IT decides when, and for whom                                                                    | Each release reaches all users automatically                                                               |
| **What it needs**       | IT's packaging requirements                                                                      | An internal HTTPS server hosting the releases, and signed builds (D15) — auto-update refuses unsigned ones |

**Why it is needed**

- Without an update channel, every user stays on the version they first installed — including any security bug in it.
  That is not acceptable in production.
- The two options need different engineering work, so the choice must be made before it is built.
- It is an IT policy choice: many companies forbid apps from updating themselves and require the software centre;
  others prefer auto-update. Neither is better in general.

**What to ask for.** "Do we distribute desktop apps through the software centre / MDM, or may the app update itself
from an internal server? If through the software centre: which tool, and which package format?"

## D9 — Hosted DNS name and wildcard webview certificate

**What it is.** The hosted (browser) version of QE Workspace needs a proper web address, such as
`qe-workspace.yourcompany.com`, with a TLS certificate — and also a **wildcard** name and certificate,
`*.webview.qe-workspace.yourcompany.com`.

**Why the wildcard is needed**

- Parts of the IDE — the Markdown preview and many extensions' panels — are _webviews_: small embedded web pages that
  can show content from extensions and files.
- For security, each webview must run on its **own separate web address** (for example
  `abc123.webview.qe-workspace.yourcompany.com`). Browsers isolate different addresses from each other, so a webview
  with malicious or faulty content cannot reach the main IDE's session, cookies or files. VS Code in the browser uses
  the same protection.
- Each webview gets a different random sub-address, so the company's DNS must point all of them to the server
  (wildcard DNS), and one certificate must cover all of them (wildcard TLS certificate).

**Without it.** In the hosted (browser) mode, webviews — the Markdown preview and extension panels — do not work; the
matching automated test is marked "waits on D9". Everything else in hosted mode works: terminals, files, remote
systems. Webviews already work in local web and desktop mode, where `localhost` provides this separation.

**What to ask for.** From the network / DNS team: the production hostname plus a wildcard DNS record
`*.webview.<that hostname>`. From the PKI team: TLS certificates for both. Needed at the latest for the production
deployment (Phase 16).
