# Getting Started with QE Workspace — a Beginner's Guide

This guide takes you from nothing to using QE Workspace: install it, start it, find your way around the IDE, connect to
a lab machine and run tests. No earlier knowledge of the project is assumed. Follow the parts in order the first time.

If you only want to try the IDE on your own machine, Parts 1–3 are enough (about an hour, mostly downloads). Parts 4–6
add the full "hosted" setup with a lab machine.

**Contents**

1. [What QE Workspace is](#1-what-qe-workspace-is)
2. [One-time setup of your machine](#2-one-time-setup-of-your-machine)
3. [Your first start: the IDE on your machine](#3-your-first-start-the-ide-on-your-machine)
4. [Finding your way around the IDE](#4-finding-your-way-around-the-ide)
5. [Run tests](#5-run-tests)
6. [Connect to another machine](#6-connect-to-another-machine)
7. [The full hosted setup (control plane, broker, lab machine)](#7-the-full-hosted-setup)
8. [Daily routine: start and stop](#8-daily-routine-start-and-stop)
9. [Troubleshooting](#9-troubleshooting)
10. [Words used in this guide](#10-words-used-in-this-guide)
11. [Where to read more](#11-where-to-read-more)

---

## 1. What QE Workspace is

QE Workspace is a code editor and test tool for QE engineers. It looks and works like VS Code. Inside one window you
can:

- edit code,
- open a terminal,
- connect to a lab machine over SSH and work on its files,
- run test suites (pytest, Maven) and see the results.

You can use it in three ways. **They are the same product with the same screens**; only where the code runs differs.

| Mode          | What you open                                 | Where your code and terminal run                    | Needs                                    |
| ------------- | --------------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| **Local web** | A browser tab at `http://127.0.0.1:3000`      | Your own machine                                    | Node.js (Part 2)                         |
| **Desktop**   | A desktop app window                          | Your own machine                                    | Node.js; a desktop session               |
| **Hosted**    | A browser tab at `http://localhost:8080/w/…/` | A container ("workspace") started for you by Docker | Docker, the control plane and the broker |

The status bar at the bottom of the IDE always shows which mode you are in: **QE Local**, **QE Desktop** or
**QE Hosted**.

The pieces, in plain words:

| Piece                                                       | What it does                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **IDE** (`apps/ide-browser`, `apps/ide-electron`)           | The editor you see. Built on Eclipse Theia.                                                                  |
| **Control plane** (`apps/control-plane`, port 8080)         | The server for hosted mode: sign-in, roles, workspaces, lab machines, policies, test-run records, audit log. |
| **Connection broker** (`apps/connection-broker`, port 8082) | Makes the SSH connections to lab machines in hosted mode. Your browser never sees the SSH key.               |
| **PostgreSQL** (port 5432) and **Keycloak** (port 8081)     | Database and sign-in server, run in Docker for development.                                                  |
| **Workspace runtime** (Docker image `qews/runtime:dev`)     | The container that runs your hosted IDE, terminal and tests.                                                 |
| **Lab machine**                                             | Any machine you connect to over SSH. For development, a small OpenSSH container named `qews-lab-a`.          |

---

## 2. One-time setup of your machine

This part is done once per computer.

### 2.1 What you need

- A PC with **16 GB RAM** (8 GB works but is slow) and **40 GB free disk**.
- **Windows 11** with WSL 2 (Ubuntu), or Linux, or macOS. This guide uses **Windows + WSL Ubuntu**, because that is
  how the project is developed. On Linux or macOS, skip the WSL parts and run the same commands in your terminal.

> **Why WSL?** The IDE builds and runs in Linux. On Windows, the Windows copy of the repository is only good for
> typecheck, lint and unit tests. Everything in this guide runs **in the Ubuntu terminal**. You still use your normal
> Windows browser: it can open `http://localhost:…` addresses served from Ubuntu.

### 2.2 Install WSL, Ubuntu and Docker

Follow **[`DOCKER_WSL_SETUP.md`](DOCKER_WSL_SETUP.md)**, Parts 1 and 2 (Steps 1–12). It installs WSL 2, Ubuntu and Docker
Engine inside Ubuntu, step by step. When you are done, this works in the Ubuntu terminal:

```bash
docker run --rm hello-world
```

**How to open the Ubuntu terminal:** press the Windows key, type `Ubuntu` and press Enter. Every command from here
on is typed there unless the guide says otherwise.

### 2.3 Tools for building

In the Ubuntu terminal:

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential python3 python3-pytest \
  libx11-dev libxkbfile-dev libsecret-1-dev xvfb
```

`python3-pytest` lets you run the sample tests on your machine. The others are needed to build the IDE.

### 2.4 Node.js 24.22.0

The project needs exactly this version (`.nvmrc`). Install it with nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# close the terminal and open a new one, then:
nvm install 24.22.0
nvm alias default 24.22.0
node --version          # must print v24.22.0
```

### 2.5 Behind a company proxy (Netskope or similar)

If your company inspects HTTPS traffic, downloads fail with certificate errors until Ubuntu and Node trust the
company's root certificate. Ask IT for the certificate file (a `.crt`), then:

```bash
sudo cp company-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
echo 'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt' >> ~/.bashrc
source ~/.bashrc
```

Skip this step if downloads work.

### 2.6 Get the code and build it

Keep the code **inside Ubuntu's home folder** (`~/src`), not under `/mnt/c` or `/mnt/d`. Builds there are much faster.

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/Barathparthi/workbench.git
cd workbench
nvm use                                         # picks Node from .nvmrc
npm ci                                          # installs exact dependency versions (5–15 min the first time)
npm run build                                   # builds everything (10–20 min the first time)
QE_VSX_URL=https://open-vsx.org npm run plugins:download   # built-in VS Code plugins (Python, Git, …)
```

What success looks like: each command ends without a red `ERR!` line, and `npm run build` ends with
`Finished with 0 errors`.

Optional check that everything is healthy (what CI runs):

```bash
npm run verify          # typecheck, lint, format check, unit tests, build
```

---

## 3. Your first start: the IDE on your machine

### 3.1 Local web (in your browser)

```bash
cd ~/src/workbench
npm run start -w @qe/ide-browser
```

Wait until the terminal says the server is listening on `127.0.0.1:3000`. The IDE does not show anything without its
**sign-in link** (so other programs on the machine cannot open it). The link is written to a file, never printed:

```bash
# in a second Ubuntu terminal
cat ~/.qe-workspace/local-web-url
```

Copy the address it prints and open it in your Windows browser (Chrome or Edge). You need to do this once per browser.
After that, `http://127.0.0.1:3000` is enough.

You now see the **QE Workspace welcome page**, with the status bar showing **QE Local**.

To stop it: press `Ctrl+C` in the terminal where it runs.

### 3.2 Open a project and try it

1. On the welcome page, click **Open project…** (or **File → Open Folder…**).
2. Pick a folder, for example `~/src/workbench/tests/fixtures/sample-pytest-repo`. It is a small sample project with
   5 tests: 3 pass, 1 fails and 1 is skipped on purpose, so you can see every result.
3. The files appear in the **Explorer** on the left. Click `calculator.py` to open it.

Continue with [Part 4](#4-finding-your-way-around-the-ide) to learn the screen, then [Part 5](#5-run-tests) to run
the tests.

### 3.3 Desktop app (optional)

Windows 11 shows Linux app windows from WSL directly, so the desktop app can run from Ubuntu too:

```bash
cd ~/src/workbench
node node_modules/electron/install.js        # once: downloads the Electron program
npm run start -w @qe/ide-electron
```

A window called **QE Workspace** opens, with **QE Desktop** in the status bar. It works exactly like local web.

### 3.4 Local web in a container (optional)

This runs the IDE in Docker instead of directly on your machine. Build the runtime image once (see
[7.4](#74-build-the-workspace-runtime-image)), then:

```bash
scripts/qe-workspace-local ~/src/my-project     # opens my-project; shows the sign-in link in the terminal
scripts/qe-workspace-local --stop               # stops it
```

---

## 4. Finding your way around the IDE

### 4.1 The screen

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Menu bar: File  Edit  Selection  View  Go  Terminal  Help                │
├────┬──────────────────┬──────────────────────────────────────────────────┤
│ A  │ Side panel       │ Editor (your open files, as tabs)                │
│ c  │ (Explorer,       │                                                  │
│ t  │  Search, Git,    │                                                  │
│ i  │  QE Tests …)     │                                                  │
│ v  │                  ├──────────────────────────────────────────────────┤
│ i  │                  │ Bottom panel: Terminal, Problems, Output         │
│ t  │                  │                                                  │
│ y  │                  │                                                  │
├────┴──────────────────┴──────────────────────────────────────────────────┤
│ Status bar:  QE Local / QE Desktop / QE Hosted   ·  branch  ·  line:col  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Activity bar** (the narrow column of icons on the far left): switches the side panel. Hover an icon to see its
  name. The icons you will use most: **Explorer** (files), **Search**, **Source Control** (Git) and **QE Tests**
  (the beaker icon).
- **Side panel**: shows what you picked in the activity bar. Click the same icon again to hide it.
- **Editor**: your open files. `Ctrl+S` saves.
- **Bottom panel**: the terminal and messages. Toggle it with `` Ctrl+` ``.
- **Status bar**: the mode (QE Local / Desktop / Hosted), the Git branch and the cursor position.

### 4.2 The one shortcut to remember: the Command Palette

Press **F1** (or `Ctrl+Shift+P`). A search box opens at the top. Type what you want to do and press Enter. Every
action of the IDE is there.

Type **`QE`** to see all QE Workspace commands:

| Command                           | What it does                                             | Where it works        |
| --------------------------------- | -------------------------------------------------------- | --------------------- |
| **QE: Show Tests**                | Opens the QE Tests panel                                 | All modes             |
| **QE: Run Tests**                 | Runs all tests of the open project                       | All modes             |
| **QE: Connect to Remote System…** | Opens a terminal on a lab machine                        | All modes             |
| **QE: Open Remote Folder…**       | Shows a lab machine's project folder in the Explorer     | All modes             |
| **QE: Add SSH Host…**             | Adds one of your own machines to the list                | Local web and desktop |
| **QE: Sign In to QE Workspace**   | Signs the desktop app in to your company's control plane | Desktop               |
| **QE: Sign Out of QE Workspace**  | Signs it out again                                       | Desktop               |
| **QE: About QE Workspace**        | Version information                                      | All modes             |

### 4.3 Shortcuts worth knowing

| Keys                  | Does                                     |
| --------------------- | ---------------------------------------- |
| `F1` / `Ctrl+Shift+P` | Command Palette                          |
| `Ctrl+P`              | Open a file by typing part of its name   |
| `` Ctrl+` ``          | Show or hide the terminal                |
| `Ctrl+S`              | Save                                     |
| `Ctrl+F` / `Ctrl+H`   | Find / replace in the file               |
| `Ctrl+Shift+F`        | Search in all files                      |
| `Ctrl+B`              | Show or hide the side panel              |
| `Ctrl+,`              | Settings (type `qe.` to see QE settings) |

In the browser, a few keys belong to the browser (for example `Ctrl+W` closes the tab). The desktop app has no such
limits.

### 4.4 The terminal

Open it with `` Ctrl+` `` or **Terminal → New Terminal**. It runs on the machine where your project is:

- local web and desktop: your own machine;
- hosted: your workspace container, not your laptop.

`Ctrl+C` stops the program that is running in it.

### 4.5 Settings

`Ctrl+,` opens Settings. Search for `qe.` to see the QE settings:

| Setting                    | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `qe.runner.framework`      | `auto` (default) finds pytest or Maven by itself; set it to force one      |
| `qe.remote.defaultShell`   | The shell for remote terminals; empty means the lab account's normal shell |
| `qe.help.documentationUrl` | What **Documentation** on the welcome page opens                           |

---

## 5. Run tests

### 5.1 Open the QE Tests panel

Click the **beaker** icon in the activity bar, or press **F1** and run **QE: Show Tests**. The panel lists the tests it
found in the project:

```text
┌ QE Tests ───────────────────────────────────┐
│ [▶▶ Run all] [⟳]  [Run on: This project ▾]  │  ← toolbar
│ ▾ tests/test_calculator.py              ▶   │  ← a file: ▶ runs just it
│     test_add                            ▶   │  ← a test: ▶ runs just it
│     test_divide                         ▶   │
│ ─────────────────────────────────────────── │
│ ✘ All tests                                 │  ← the run you picked
│ 3 passed, 1 failed, 1 skipped               │
│ ✘ test_add_negative_fails_on_purpose        │  ← click to open the failing line
│   tests/test_calculator.py:21  assert …     │
│ JUnit report  Output log                    │  ← the run's files
│ (live output of the run)                    │
│ ─────────────────────────────────────────── │
│ Earlier runs                                │  ← click one to see it again
└─────────────────────────────────────────────┘
```

The panel finds the framework by itself: **Maven** when the project has a `pom.xml`, otherwise **pytest**. The
setting `qe.runner.framework` overrides this.

### 5.2 Run, watch, stop

1. Click **Run all**, or the **▶** next to one file or one test.
2. The output appears live under the run.
3. To stop a run, click **Cancel**. The IDE first asks the test process to stop cleanly (like `Ctrl+C`) and stops it for
   good after 10 seconds. The run is recorded as **CANCELLED**.
4. When it ends you see the counts (passed, failed, skipped, errors).

Shortcut: **F1 → QE: Run Tests** runs everything without opening the panel first.

### 5.3 Read the results

- **Failures**: each failed test shows its name, file, line and the first line of the message. **Click it** to jump
  to that line in the editor.
- **Run files**: **JUnit report** (the XML results), **HTML report** (only if `pytest-html` is installed) and
  **Output log** (everything the run printed). Click one to open it.
- **Earlier runs**: the list at the bottom. Click one to see its results again.

Each run keeps its files in the project, in **`.qe-runs/<run id>/`**. You can delete that folder at any time; add it
to `.gitignore` so it is not committed.

### 5.4 What a project needs

| Framework | Needs                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- |
| pytest    | Python 3 with pytest. A project `.venv` is used when it exists. The hosted image already has pytest. |
| Maven     | The project's own `./mvnw`, or `mvn` installed on the machine. Maven is **not** in the hosted image. |

### 5.5 Run tests on a lab machine ("Run on")

When lab machines are available ([Part 6](#6-connect-to-another-machine)), the toolbar shows a **Run on** list:

- **This project**: runs on the machine where your project is (default).
- **A lab machine**: runs in that machine's project folder. The output streams in the same way, Cancel works the same,
  and clicking a failure opens the file on the lab machine.

For a managed lab machine, your organisation's policy must allow test runs (`exec`). If not, the panel says so.

---

## 6. Connect to another machine

There are two kinds of machines you can connect to:

| Kind                | Where it comes from                                                                          | Login                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Managed systems** | Registered by an admin in the control plane (hosted mode, or a signed-in desktop app)        | Handled by the platform: you never need or see an SSH key  |
| **Your SSH hosts**  | Your own `~/.ssh/config`, plus hosts you add with **QE: Add SSH Host…** (local web, desktop) | Your own SSH keys or ssh-agent, which stay on your machine |

### 6.1 Open a terminal on a lab machine

1. **F1 → QE: Connect to Remote System…** (or **Connect to a remote system…** on the welcome page).
2. Pick a machine from the list (managed systems first, then your SSH hosts).
3. A terminal tab opens and shows:
   ```text
   Connecting to lab-a-dev…
   Host key verified (ssh-ed25519 SHA256:…).
   ```
   followed by the machine's prompt. Type commands as usual.

The session ends when you close the tab, after a time with no activity, or at the maximum session time set by the
admin.

### 6.2 The host key question (your own SSH hosts only)

The first time you connect to one of your own hosts, the IDE shows its **host key fingerprint** and asks:

- **Trust and save**: trust it and remember it (saved in `~/.qe-workspace/known_hosts`; your own
  `~/.ssh/known_hosts` is read but never changed).
- **Trust once**: trust it for this connection only.
- **Cancel**: do not connect.

Compare the fingerprint with the one your machine's owner gives you. If the IDE ever says the **host key changed**,
do not continue: that can mean someone is pretending to be the machine. Ask the machine's owner.

Managed systems never ask: an admin has already approved their keys.

### 6.3 Work on a lab machine's files

1. **F1 → QE: Open Remote Folder…** and pick the machine.
2. Its project folder appears in the **Explorer**, next to your own project.
3. Open, edit and save files as usual. You can only reach files inside that folder; anything outside is refused with
   "Path outside root".

### 6.4 Add one of your own machines (local web and desktop)

1. **F1 → QE: Add SSH Host…**
2. Step 1: type `user@host` or `user@host:port`, for example `qe@192.168.1.20`.
3. Step 2: give it a name.

It is saved in `~/.qe-workspace/ssh_hosts`; your own `~/.ssh/config` is never changed. Hosts already in
`~/.ssh/config` appear by themselves.

---

## 7. The full hosted setup

Hosted mode is the full system: a control plane, a broker, a database, a sign-in server and a workspace container per
user. In development it all runs on your machine. Do Parts 2 and 3 first.

Open **three Ubuntu terminals**. In each one, start with `cd ~/src/workbench`.

### 7.1 Start the database and sign-in server (terminal 1)

```bash
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait
```

This starts PostgreSQL and Keycloak. `--wait` returns when both are healthy. Check:

```bash
docker ps --format '{{.Names}}  {{.Status}}'
# qews-dev-postgres-1  Up … (healthy)
# qews-dev-keycloak-1  Up … (healthy)
```

### 7.2 Configure the control plane and the broker (once)

```bash
cp apps/control-plane/.env.example apps/control-plane/.env
cp apps/connection-broker/.env.example apps/connection-broker/.env
```

Then edit **`apps/control-plane/.env`** (for example with `nano apps/control-plane/.env`) and set these lines (remove
the `#` in front of the commented ones):

```ini
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8080
DEV_ROLES=qe.admin,qe.user,lab.a.user
INTERNAL_SERVICE_TOKEN=dev-only-internal-service-token-change-me-0123
BROKER_INTERNAL_URL=http://127.0.0.1:8082
BROKER_PUBLIC_URL=http://localhost:8082
```

- `DEV_ROLES` are the roles of the pretend user in development mode (`AUTH_MODE=dev`): admin, normal user, and
  access to "lab A".
- `INTERNAL_SERVICE_TOKEN` must be **the same** in both `.env` files. The broker's `.env.example` already has this
  value. Use your own random value of 32+ characters on any shared machine.

These files hold development values only and are never committed (they are git-ignored).

### 7.3 Start the broker (terminal 2) and the control plane (terminal 3)

```bash
# terminal 2
npm run dev -w @qe/connection-broker          # serves http://127.0.0.1:8082

# terminal 3
npm run dev -w @qe/control-plane              # applies database migrations, then serves http://127.0.0.1:8080
```

Leave both running. Check from terminal 1:

```bash
curl http://localhost:8080/readyz             # {"status":"ready"}
curl http://localhost:8082/readyz             # {"status":"ready","sessions":0}
```

### 7.4 Build the workspace runtime image

The hosted IDE runs in this image. Build it once, and again after you change IDE code (15–30 min):

```bash
QE_VSX_URL=https://open-vsx.org DOCKER_BUILDKIT=1 docker build -f images/workspace-runtime/Dockerfile \
  --build-arg QE_VSX_URL -t qews/runtime:dev .
```

Behind a company proxy, add `--secret id=extra_ca,src=/usr/local/share/ca-certificates/company-root-ca.crt` (the file
from step 2.5) so the build can download through it.

### 7.5 Create your workspace and open it

The commands below use a small helper `api` so they are shorter. Paste the whole block into terminal 1:

```bash
api() { curl -s -X "$1" "http://localhost:8080/api/v1$2" -H 'origin: http://localhost:8080' \
  -H 'content-type: application/json' ${3:+-d "$3"}; }
jid() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id??s))'; }

WS=$(api POST /workspaces '{"name":"my-first-workspace","templateId":"tpl_python_pytest"}' | jid)
echo "workspace: $WS"
api POST /workspaces/$WS/start '{}' >/dev/null
echo "open: http://localhost:8080/w/$WS/"
```

Wait about a minute for the container to start (`api GET /workspaces/$WS` shows `"state":"RUNNING"`), then open the
printed address in your Windows browser. The status bar shows **QE Hosted**. Your files are kept in the workspace
between starts.

To list your workspaces later: `api GET /workspaces`. Stop one: `api POST /workspaces/$WS/stop '{}'`. An idle workspace
stops by itself after 60 minutes (`WORKSPACE_IDLE_MINUTES`); start it again with the `start` call.

### 7.6 Add a lab machine (admin, once)

In hosted mode, nobody can connect to a machine an admin has not registered. Registering one has four parts: a
**policy** (who may connect, to which network and port, and what they may do), a **credential reference** (which SSH
key the broker uses), the **target** itself (host, port, account, folder), and its approved **host key**.

For development, a small OpenSSH container serves as the lab machine. Run this once, in terminal 1, from
`~/src/workbench` (the `api` and `jid` helpers from 7.5 must be defined in the same terminal):

```bash
# 1. A development SSH key for the broker (never use it for anything else)
KEYS=apps/connection-broker/dev-keys
mkdir -p $KEYS && chmod 700 $KEYS
[ -f $KEYS/qe-lab-a_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C qe-lab-a-dev -f $KEYS/qe-lab-a_ed25519

# 2. The lab machine: an OpenSSH container that accepts that key for the account "qe"
docker build -q -t qews-test-openssh packages/test-utils/openssh
docker create --name qews-lab-a --restart unless-stopped qews-test-openssh
docker cp $KEYS/qe-lab-a_ed25519.pub qews-lab-a:/etc/ssh/authorized_keys/qe
docker start qews-lab-a
docker exec qews-lab-a sh -c 'chown root:root /etc/ssh/authorized_keys/qe && chmod 644 /etc/ssh/authorized_keys/qe'
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' qews-lab-a)
HOSTKEY=$(docker exec qews-lab-a cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)
echo "lab machine at $IP"

# 3. Policy: role lab.a.user may use port 22 on that network for terminals, files and test runs
POLICY=$(api POST /policies "{\"name\":\"lab-a-dev\",\"allowedRoles\":[\"lab.a.user\"],\"allowedCidrs\":[\"${IP%.*.*}.0.0/16\"],\"allowedPorts\":[22],\"capabilities\":[\"terminal\",\"file_read\",\"file_write\",\"exec\"]}" | jid)

# 4. Credential reference: the key file from step 1 (by name, never its contents)
CRED=$(api POST /credential-refs '{"provider":"file_dev","method":"vault_key","providerPath":"qe-lab-a_ed25519"}' | jid)

# 5. The target, its host key, then switch it on
TARGET=$(api POST /targets "{\"name\":\"lab-a-dev\",\"description\":\"OpenSSH test container\",\"host\":\"$IP\",\"port\":22,\"os\":\"linux\",\"principalTemplate\":\"qe\",\"remoteRoot\":\"/home/qe\",\"policyId\":\"$POLICY\",\"credentialRefId\":\"$CRED\",\"tags\":[\"dev\",\"lab-a\"]}" | jid)
api POST /targets/$TARGET/host-keys "{\"publicKey\":\"$HOSTKEY\"}" >/dev/null
api PATCH /targets/$TARGET '{"status":"active"}'
```

The last command prints the target with `"status":"active"`. The broker reads the key file at each connection, so it
needs no restart.

Now, in your hosted IDE: **F1 → QE: Connect to Remote System… → lab-a-dev**. A terminal on the lab machine opens. In the
**QE Tests** panel, **Run on** now lists **lab-a-dev** too.

What each policy capability allows:

| Capability   | Allows                                        |
| ------------ | --------------------------------------------- |
| `terminal`   | Opening a terminal on the machine             |
| `file_read`  | Browsing and opening its files                |
| `file_write` | Saving, creating, renaming and deleting files |
| `exec`       | Running tests on it from the QE Tests panel   |

Every connection, refusal, test run and admin change is written to the audit log (the `audit_events` table in the
database).

---

## 8. Daily routine: start and stop

### Start (after a restart of the PC)

```bash
cd ~/src/workbench
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait   # database + sign-in server
docker start qews-lab-a                                               # lab machine (if you made one)
npm run dev -w @qe/connection-broker                                  # terminal 2
npm run dev -w @qe/control-plane                                      # terminal 3
```

Then start your workspace again (the `start` call from 7.5) and open `http://localhost:8080/w/<workspace id>/`.

For local web only, `npm run start -w @qe/ide-browser` is all you need.

### Get the latest code

```bash
cd ~/src/workbench
git pull
npm ci && npm run build
```

Rebuild the runtime image (7.4) if you use hosted mode.

### Stop

- IDE, broker, control plane: `Ctrl+C` in their terminals.
- Database and sign-in server: `docker compose -f deploy/compose/docker-compose.dev.yml stop`
- Lab machine: `docker stop qews-lab-a`
- Free memory used by WSL (in Windows PowerShell): `wsl --shutdown`

`docker compose … down -v` **deletes the database**: all workspaces, lab machines and records. Only use it to start
from zero.

---

## 9. Troubleshooting

| What you see                                                     | What to do                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` says "Unsupported engine" or `EBADENGINE`               | Wrong Node version: `nvm use`, then `node --version` must say `v24.22.0`                                                                                |
| Downloads fail with `SELF_SIGNED_CERT_IN_CHAIN` or `ECONNRESET`  | Company proxy: do step 2.5. `ECONNRESET` on a long download: run the command again                                                                      |
| `http://127.0.0.1:3000` shows nothing or "Forbidden"             | Open the sign-in link from `~/.qe-workspace/local-web-url` once (3.1)                                                                                   |
| The desktop app does not open a window                           | You need Windows 11 (WSLg) or a Linux desktop. Run `node node_modules/electron/install.js` once                                                         |
| `curl http://localhost:8080/readyz` fails                        | The control plane is not running or crashed: look at terminal 3. Exit code 78 means a wrong `.env` value; the message names it                          |
| `/readyz` says 503                                               | The database is down: `docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait`                                                            |
| Port 8080 or 8082 "already in use"                               | An old copy is still running: `ss -ltnp \| grep 8080` shows its pid; `kill <pid>`                                                                       |
| Workspace stays `STARTING`, then `FAILED`                        | The runtime image is missing: build it (7.4). Check `docker images qews/runtime`                                                                        |
| "Not allowed to connect"                                         | Your roles do not match the policy (`DEV_ROLES` must include `lab.a.user`), or the target is not `active`                                               |
| "The remote system did not answer in time"                       | The lab container is stopped or changed its address after a restart: `docker start qews-lab-a`; if its IP changed, update the target's `host`           |
| "Host key mismatch"                                              | The machine's key is not the approved one. On a real lab machine: stop and tell the admin. For the dev container: approve its new key again             |
| "Path outside root"                                              | You tried to reach a file outside the machine's project folder; that is refused on purpose                                                              |
| QE Tests: "The tests could not be listed: is pytest installed…?" | Install pytest (`python3 -m pytest --version` must work), or create the project's `.venv` with it. For Maven, check `pom.xml` and `qe.runner.framework` |
| QE Tests: running on a lab machine is refused                    | The machine's policy has no `exec` capability. An admin adds it                                                                                         |
| Maven tests refused                                              | Add `./mvnw` to the project or install `mvn`                                                                                                            |
| Everything is slow                                               | Give WSL more memory (`.wslconfig`, see `DOCKER_WSL_SETUP.md` Step 6), and close other heavy programs                                                   |

---

## 10. Words used in this guide

| Word                | Meaning                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| **Workspace**       | Your own IDE container in hosted mode, with your files and terminal                                |
| **Control plane**   | The central server: users, roles, workspaces, lab machines, policies, test-run records, audit log  |
| **Broker**          | The server that makes SSH connections for hosted users; it holds the keys, your browser never does |
| **Target**          | A lab machine registered by an admin                                                               |
| **Policy**          | Rules for a target: which roles, which networks and ports, which capabilities                      |
| **Capability**      | What a policy allows: `terminal`, `file_read`, `file_write`, `exec`                                |
| **Host key**        | A machine's identity for SSH. The IDE checks it so you know you reached the right machine          |
| **Personal host**   | A machine from your own SSH configuration (local web and desktop)                                  |
| **Run**             | One execution of tests: its output, results and files (`.qe-runs/<run id>/`)                       |
| **JUnit XML**       | The standard results file pytest and Maven write; the panel reads results from it                  |
| **Command Palette** | The search box opened with F1, listing every action                                                |

---

## 11. Where to read more

| You want to…                                        | Read                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Install WSL and Docker in detail                    | [`DOCKER_WSL_SETUP.md`](DOCKER_WSL_SETUP.md)                                                              |
| Develop the project (tests, CI, the phase workflow) | [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md)                                                            |
| Know what is done and what is next                  | [`PROJECT_LOG.md`](PROJECT_LOG.md)                                                                        |
| Know which company decisions are still open         | [`ORG_DECISIONS.md`](ORG_DECISIONS.md)                                                                    |
| Understand the design                               | [`01_ARCHITECTURE/02_SOLUTION_ARCHITECTURE.md`](../01_ARCHITECTURE/02_SOLUTION_ARCHITECTURE.md)           |
| Understand how SSH connections are kept safe        | [`01_ARCHITECTURE/08_REMOTE_CONNECTIVITY_DESIGN.md`](../01_ARCHITECTURE/08_REMOTE_CONNECTIVITY_DESIGN.md) |
| See the full API                                    | [`apps/control-plane/openapi.json`](../apps/control-plane/openapi.json)                                   |
