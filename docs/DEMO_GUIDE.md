# QE Workspace — Demo Guide (manager demo)

A complete, step-by-step script for showing QE Workspace to a manager: what to prepare the day before, what to check
30 minutes before, and the demo itself, with every command, what to click, what to say and what the audience should
see. Total demo time: about **25 minutes** plus questions.

Everything below runs on one Windows 11 PC with WSL Ubuntu and Docker, as set up in
[`GETTING_STARTED.md`](GETTING_STARTED.md). All commands are typed in the **Ubuntu terminal** unless a step says
otherwise; the browser is your normal Windows Chrome or Edge.

**Contents**

1. [The story in one minute](#1-the-story-in-one-minute)
2. [The day before: prepare from scratch](#2-the-day-before-prepare-from-scratch)
3. [30 minutes before the demo](#3-30-minutes-before-the-demo)
4. [The demo, step by step](#4-the-demo-step-by-step)
5. [What is done and what is next](#5-what-is-done-and-what-is-next)
6. [Questions your manager may ask](#6-questions-your-manager-may-ask)
7. [If something goes wrong](#7-if-something-goes-wrong)
8. [After the demo](#8-after-the-demo)

---

## 1. The story in one minute

Read this out at the start, or put it on a slide:

> Today our QE engineers each set up VS Code on their own laptop, with different Python and Java versions, and reach
> lab machines with personal SSH keys stored on those laptops. Onboarding takes days, and nobody can see who connected
> to which lab machine.
>
> **QE Workspace** is one product that gives every engineer the same VS Code-like environment — in the **browser**, or
> as a **desktop app** — with a terminal, test runner and **safe access to lab machines**. Users never hold the lab
> keys: the platform checks who they are, what the lab's policy allows, and records everything in an audit log.

The five things the demo proves:

| #   | Claim                                                                                          | Shown in  |
| --- | ---------------------------------------------------------------------------------------------- | --------- |
| 1   | A full IDE in the browser: editor, terminal, Git, extensions                                   | Part A    |
| 2   | Tests run with one click, with live output, parsed results and reports                         | Part B    |
| 3   | Lab machines are reached safely: no keys for the user, verified identity, confined file access | Part C    |
| 4   | Tests run **on the lab machine** from the same panel                                           | Part D    |
| 5   | The same product works on the laptop (local web / desktop), and everything is audited          | Parts E–F |

---

## 2. The day before: prepare from scratch

Do this the day before, not on the morning of the demo: the first build takes 1–2 hours, mostly downloads.

### 2.1 Machine setup (once)

If the machine is not set up yet, follow [`GETTING_STARTED.md`](GETTING_STARTED.md) Part 2 completely: WSL and Docker
(2.2), build tools (2.3), Node 24.22.0 (2.4), company proxy certificate (2.5), clone and build (2.6). At the end this
must work:

```bash
cd ~/src/workbench
node --version                 # v24.22.0
docker run --rm hello-world    # "Hello from Docker!"
```

### 2.2 Get the latest code and build everything

```bash
cd ~/src/workbench
git fetch origin
git switch phase-11-qe-runner          # the branch with everything up to Phase 11 (until it is merged to main)
git pull
npm ci                                  # 5–15 min
npm run build                           # 10–20 min
QE_VSX_URL=https://open-vsx.org npm run plugins:download
node node_modules/electron/install.js  # the desktop app's Electron program
```

Each must finish without a red `ERR!`. `npm ci` failing with `ETIMEDOUT` or `ECONNRESET` is the proxy: run it again.

### 2.3 Start the database and sign-in server

```bash
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait
```

### 2.4 Configuration files (once)

```bash
cp -n apps/control-plane/.env.example apps/control-plane/.env
cp -n apps/connection-broker/.env.example apps/connection-broker/.env
nano apps/control-plane/.env
```

In `apps/control-plane/.env` these lines must read (remove a leading `#` where there is one; `Ctrl+O`, Enter,
`Ctrl+X` saves and closes nano):

```ini
AUTH_MODE=dev
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8080
DEV_ROLES=qe.admin,qe.user,lab.a.user
INTERNAL_SERVICE_TOKEN=dev-only-internal-service-token-change-me-0123
BROKER_INTERNAL_URL=http://127.0.0.1:8082
BROKER_PUBLIC_URL=http://localhost:8082
```

The broker's `.env` already has the same `INTERNAL_SERVICE_TOKEN`; check with
`grep INTERNAL_SERVICE_TOKEN apps/*/.env` — both lines must show the same value.

### 2.5 Start the broker and the control plane

Open **two more Ubuntu terminals** (call them **T2** and **T3**; the first one is **T1**). In each: `cd ~/src/workbench`.

```bash
# T2 — the connection broker (leave it running)
npm run dev -w @qe/connection-broker

# T3 — the control plane (applies the database migrations, then serves; leave it running)
npm run dev -w @qe/control-plane
```

Check in T1:

```bash
curl -s http://localhost:8080/readyz; echo      # {"status":"ready"}
curl -s http://localhost:8082/readyz; echo      # {"status":"ready","sessions":0}
```

### 2.6 Build the workspace image (15–30 min)

```bash
QE_VSX_URL=https://open-vsx.org DOCKER_BUILDKIT=1 docker build -f images/workspace-runtime/Dockerfile \
  --build-arg QE_VSX_URL -t qews/runtime:dev .
```

Behind the company proxy add
`--secret id=extra_ca,src=/usr/local/share/ca-certificates/<company-ca>.crt`. If it fails with `ETIMEDOUT`, run the
same command again — finished steps are cached.

### 2.7 Helper commands for the API

Paste this into **T1**. It defines two short helpers used below (they last until you close the terminal; paste them
again in a new one):

```bash
cd ~/src/workbench
api() { curl -s -X "$1" "http://localhost:8080/api/v1$2" -H 'origin: http://localhost:8080' \
  -H 'content-type: application/json' ${3:+-d "$3"}; }
jid() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id??s))'; }
```

### 2.8 The lab machine and its registration (once)

Skip this if `api GET /targets` already lists `lab-a-dev` with `"status":"active"` **and**
`docker exec qews-lab-a python3 -m pytest --version` prints a pytest version.

```bash
# The broker's development key (never used for anything else)
KEYS=apps/connection-broker/dev-keys
mkdir -p $KEYS && chmod 700 $KEYS
[ -f $KEYS/qe-lab-a_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C qe-lab-a-dev -f $KEYS/qe-lab-a_ed25519

# The lab machine: OpenSSH + Python + pytest, fixed address 172.30.0.10
docker network create --subnet 172.30.0.0/24 qews-lab 2>/dev/null || true
docker build -q -t qews-lab-openssh:dev packages/test-utils/openssh
docker create --name qews-lab-a --network qews-lab --ip 172.30.0.10 --restart unless-stopped qews-lab-openssh:dev
docker cp $KEYS/qe-lab-a_ed25519.pub qews-lab-a:/etc/ssh/authorized_keys/qe
docker start qews-lab-a
docker exec qews-lab-a sh -c 'chown root:root /etc/ssh/authorized_keys/qe && chmod 644 /etc/ssh/authorized_keys/qe'
HOSTKEY=$(docker exec qews-lab-a cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)

# Registration through the admin API: policy, credential reference, target, approved host key, then active
POLICY=$(api POST /policies '{"name":"lab-a-dev","allowedRoles":["lab.a.user"],"allowedCidrs":["172.30.0.0/24"],"allowedPorts":[22],"capabilities":["terminal","file_read","file_write","exec"]}' | jid)
CRED=$(api POST /credential-refs '{"provider":"file_dev","method":"vault_key","providerPath":"qe-lab-a_ed25519"}' | jid)
TARGET=$(api POST /targets "{\"name\":\"lab-a-dev\",\"description\":\"Lab A test machine\",\"host\":\"172.30.0.10\",\"port\":22,\"os\":\"linux\",\"principalTemplate\":\"qe\",\"remoteRoot\":\"/home/qe\",\"policyId\":\"$POLICY\",\"credentialRefId\":\"$CRED\",\"tags\":[\"dev\",\"lab-a\"]}" | jid)
api POST /targets/$TARGET/host-keys "{\"publicKey\":\"$HOSTKEY\"}" >/dev/null
api PATCH /targets/$TARGET '{"status":"active"}'; echo
```

The last line prints the target with `"status":"active"`.

If the policy already existed without `exec`, add it:

```bash
POLICY=$(api GET /policies | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items.find(p=>p.name==="lab-a-dev").id))')
api PATCH /policies/$POLICY '{"capabilities":["terminal","file_read","file_write","exec"]}'; echo
```

### 2.9 Your own SSH host entry (for the local part of the demo)

The local web and desktop apps list the hosts in your own `~/.ssh/config`. Add the lab machine there as **lab-a**,
using the same development key:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cp apps/connection-broker/dev-keys/qe-lab-a_ed25519 ~/.ssh/qe-lab-a && chmod 600 ~/.ssh/qe-lab-a
cat >> ~/.ssh/config <<'EOF'

Host lab-a
  HostName 172.30.0.10
  User qe
  IdentityFile ~/.ssh/qe-lab-a
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh lab-a 'echo connected as $(whoami)'     # answer "yes" to the host key question once; prints "connected as qe"
```

### 2.10 The demo workspace and the demo project

Create (or find) the hosted workspace:

```bash
api GET /workspaces | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const w of JSON.parse(s).items)console.log(w.id,w.name,w.state)})'
```

If none is listed, create one:

```bash
WS=$(api POST /workspaces '{"name":"demo","templateId":"tpl_python_pytest"}' | jid); echo $WS
```

Otherwise set `WS=<the id from the list>`. Start it and wait for `RUNNING`:

```bash
api POST /workspaces/$WS/start '{}' >/dev/null
until api GET /workspaces/$WS | grep -q '"state":"RUNNING"'; do sleep 3; done; echo running
echo "http://localhost:8080/w/$WS/"          # the demo address: write it down
```

Put the sample test project into the workspace **and** onto the lab machine (3 tests pass, 1 fails on purpose, 1 is
skipped — so every kind of result shows):

```bash
C=qews-ws-$WS
docker exec -u 1000 $C sh -c 'mkdir -p /home/qe/project/tests'
for f in calculator.py pytest.ini tests/conftest.py tests/test_calculator.py; do
  docker exec -i -u 1000 $C sh -c "cat > /home/qe/project/$f" < tests/fixtures/sample-pytest-repo/$f
  docker exec -i -u qe -w /home/qe qews-lab-a sh -c "mkdir -p tests && cat > $f" < tests/fixtures/sample-pytest-repo/$f
done
docker exec -u 1000 $C sh -c 'cd /home/qe/project && rm -rf .qe-runs && ls'
printf 'environment: lab-a\nretries: 2\n' | docker exec -i -u qe -w /home/qe qews-lab-a sh -c 'mkdir -p config && cat > config/env.yaml'
docker exec -u qe -w /home/qe qews-lab-a sh -c 'ln -sf /etc/hostname config/outside-link; rm -rf .qe-runs; ls'
```

### 2.11 Rehearse once

Go through Part 4 once, end to end, the day before. Afterwards reset the sample (the demo edits `calculator.py`):

```bash
docker exec -i -u 1000 qews-ws-$WS sh -c 'cat > /home/qe/project/tests/test_calculator.py' \
  < tests/fixtures/sample-pytest-repo/tests/test_calculator.py
docker exec -u 1000 qews-ws-$WS sh -c 'rm -rf /home/qe/project/.qe-runs'
```

---

## 3. 30 minutes before the demo

### 3.1 Start everything

If the PC was restarted, in **T1**:

```bash
cd ~/src/workbench
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait
docker start qews-lab-a
```

**T2**: `npm run dev -w @qe/connection-broker` · **T3**: `npm run dev -w @qe/control-plane`

If either stops with `EADDRINUSE: address already in use 127.0.0.1:8082` (or `:8080`), an older copy is still
running in the background (for example from a test script). Stop it, then run the command again:

```bash
kill $(ss -ltnp | grep -E ':(8080|8082) ' | grep -oP 'pid=\K[0-9]+')
ss -ltn | grep -E ':(8080|8082) ' || echo "ports free"
```

Then in **T1** paste the helpers from 2.7 again, set `WS=<your workspace id>` and start the workspace (2.10, the
`start` and `until` lines).

### 3.2 Checklist

Run each line in T1 and compare:

| Check               | Command                                                 | Expected                          |
| ------------------- | ------------------------------------------------------- | --------------------------------- |
| Control plane       | `curl -s localhost:8080/readyz`                         | `{"status":"ready"}`              |
| Broker              | `curl -s localhost:8082/readyz`                         | `{"status":"ready",…}`            |
| Workspace           | `api GET /workspaces/$WS \| grep -o '"state":"[A-Z]*"'` | `"state":"RUNNING"`               |
| Lab machine         | `ssh lab-a 'python3 -m pytest --version'`               | `pytest 8.x`                      |
| Lab target          | `api GET /targets \| grep -o '"status":"[a-z]*"'`       | `"status":"active"`               |
| Sample in workspace | `docker exec qews-ws-$WS ls /home/qe/project/tests`     | `conftest.py  test_calculator.py` |

### 3.3 Prepare the screen

1. Open the browser at `http://localhost:8080/w/<WS>/`. Wait for the IDE. Close any old editor tabs and terminals
   (right-click a tab → **Close All**; in the terminal panel, the trash icon).
2. Zoom the browser to 125–150 % (`Ctrl` + `+`) so the manager can read it.
3. Keep **T1** ready behind the browser for the audit query (Part F).
4. Turn off notifications (Windows: Focus assist) and close other programs.

---

## 4. The demo, step by step

Each step says **Do** (what you click or type), **Say** (what to tell your manager) and **See** (what should appear).

### Part A — The IDE in the browser (5 min)

**A1. Open the workspace.**
Do: the browser tab with `http://localhost:8080/w/<WS>/` (refresh it).
Say: "This is a workspace running on our server — nothing is installed on this laptop. Every engineer gets the same
tools, the same Python, the same extensions."
See: the QE Workspace window; bottom-left the status bar says **QE Hosted**.

**A2. Find your way around.**
Do: point at the **activity bar** on the left (Explorer, Search, Git, QE Tests), the editor in the middle and the
status bar. Press **F1** and type `QE`.
Say: "It works like VS Code. F1 lists every action; these are our own QE commands."
See: QE: Show Tests, QE: Run Tests, QE: Connect to Remote System…, QE: Open Remote Folder…

Press `Esc`.

**A3. Edit a file.**
Do: in the Explorer open `calculator.py`. Show the code. Open `tests/test_calculator.py`.
Say: "Normal editing, syntax highlighting, Git integration."

**A4. The terminal.**
Do: `` Ctrl+` `` opens a terminal. Type:

```bash
python3 --version
python3 -m pytest -q
```

See: pytest's live output in the terminal: `1 failed, 3 passed, 1 skipped`.
Do: type `sleep 100`, then press **Ctrl+C**.
Say: "A real terminal on the workspace; Ctrl+C stops programs as on any machine."
See: the prompt comes back at once.

### Part B — Run tests from the QE Tests panel (6 min)

**B1. Open the panel.**
Do: click the **beaker** icon in the activity bar (or F1 → **QE: Show Tests**).
See: `tests/test_calculator.py`; click the arrow next to it to show its 5 tests.
Say: "The panel finds the tests by itself — pytest here, Maven for Java projects."

**B2. Run everything.**
Do: click **Run all**.
See: live output under the run, then the result **3 passed · 1 failed · 1 skipped**.
Say: "Live output while it runs, and the results are read from the standard JUnit report, not guessed from the text."

**B3. Jump to the failure.**
Do: click the failed test **test_add_negative_fails_on_purpose**.
See: `tests/test_calculator.py` opens at **line 21**, the failing assertion.
Say: "One click from the result to the line that failed."

**B4. Fix it and run again.**
Do: on line 21 change `-6` to `-5` (so it reads `assert add(-2, -3) == -5`), press `Ctrl+S`. Click **Run all** again.
See: **4 passed · 1 skipped**.

**B5. Reports and history.**
Do: click **JUnit report** and **Output log** under the run. Scroll down to **Earlier runs** and click the first
(red) run.
Say: "Every run keeps its report, its log and its result; the platform records each run with its counts."

**B6. Cancel (optional, 30 s).**
Do: click **Run all** and, while it shows **Running…**, click **Cancel**.
See: the run stops and is shown as cancelled.
Say: "Cancel stops the test process cleanly first, and forcefully after 10 seconds."

### Part C — Connect to a lab machine (6 min)

**C1. Open a terminal on the lab machine.**
Do: F1 → **QE: Connect to Remote System…**
See: the list shows **Managed systems → lab-a-dev**. Say: "I only see the lab machines my role allows."
Do: pick **lab-a-dev**.
See:

```text
Connecting to lab-a-dev…
Host key verified (ssh-ed25519 SHA256:…).
```

and a prompt on the lab machine.
Say: "I never had an SSH key. The platform checked my role, the lab's policy and the network rules, connected with a
key only the server holds, and verified the machine's identity — if the lab machine were replaced by an impostor, the
connection would be refused."

**C2. Use it.**
Do: type

```bash
hostname; whoami; ls
```

See: the lab machine's name, `qe`, and its files (`config`, `tests`, …).

**C3. Open the lab machine's folder.**
Do: F1 → **QE: Open Remote Folder…** → **lab-a-dev**.
See: a new root **[lab-a-dev]** in the Explorer.
Do: open `config/env.yaml`, change `retries: 2` to `retries: 3`, `Ctrl+S`. In the lab terminal:

```bash
cat config/env.yaml
```

See: `retries: 3`.
Say: "Editing files on the lab machine as if they were local, saved straight to the machine."

**C4. Show the safety limit.**
Do: in the Explorer, double-click `config/outside-link` (a link pointing to `/etc/hostname`, outside the allowed folder).
See: a message that **“outside-link” points outside the remote folder**; no file opens.
Say: "Users can only reach the project folder on a lab machine; the server refuses anything outside, even through
links. It is checked on the server, not in the browser."

**C5.** Close the lab terminal (trash icon).

### Part D — Run the tests on the lab machine (3 min)

**D1.** Do: go back to the **QE Tests** panel. Open the **Run on** list at the top: choose **lab-a-dev**.
Say: "The same tests, now on the lab machine — where the hardware and network actually are."

**D2.** Do: click **Run all**.
See: the output streams from the lab machine, then **3 passed · 1 failed · 1 skipped** (the lab still has the original
test file).

**D3.** Do: click the failure.
See: the file opens **from the lab machine** at line 21.
Say: "Same panel, same results, same one-click to the failure — whether the tests run in the workspace or on a lab
machine."

**D4.** Do: set **Run on** back to **This project**.

### Part E — The same product on the laptop (3 min)

**E1. Start local web.** In **T1**:

```bash
npm run start -w @qe/ide-browser
```

In a fourth terminal (**T4**): `cat ~/.qe-workspace/local-web-url` and open the printed address in a **new browser
tab**.
See: the same IDE, now **QE Local** in the status bar.
Say: "The same product running on my own laptop, for people who want their code locally — or as a desktop app."

**E2. Your own SSH host.**
Do: F1 → **QE: Connect to Remote System…**
See: **Your SSH hosts → lab-a** (from my own `~/.ssh/config`).
Do: pick it. A terminal on the lab machine opens, using my own key — which never leaves my laptop.

**E3. Desktop app (optional).** Stop local web (`Ctrl+C` in T1), then:

```bash
npm run start -w @qe/ide-electron
```

See: a **QE Workspace** desktop window with **QE Desktop** in the status bar; F1 → `QE` shows the same commands.
Say: "Three ways to use it — web, local web and desktop — one product, the same screens and features, proven by the
same automated test suite in all three."

Close it when done.

### Part F — Governance: audit and policy (3 min)

**F1. The audit log.** In **T1** (helpers from 2.7 pasted):

```bash
docker exec qews-dev-postgres-1 psql -U qews -d qews -c "select to_char(occurred_at,'HH24:MI:SS') as time, action, result, coalesce(reason_code,'') as reason from audit_events order by seq desc limit 15"
```

See: the last actions of the demo, newest first, for example:

```text
   time   |         action         | result  |      reason
----------+------------------------+---------+-------------------
 10:24:01 | SSH_SESSION_CLOSED     | success |
 10:24:01 | QE_TEST_FINISHED       | success |
 10:23:58 | QE_TEST_STARTED        | success |
 10:21:12 | ACCESS_DENIED          | denied  | PATH_OUTSIDE_ROOT
 10:20:40 | REMOTE_FILE_WRITE      | success |
 10:19:55 | SSH_SESSION_OPENED     | success |
 10:19:55 | REMOTE_CONNECT_ALLOWED | success |
```

Say: "Every connection, file change on a lab machine, refused access and test run is recorded — with who, when and
the result, never passwords or file contents. The log is hash-chained, so editing or deleting an entry is detected."

**F2. Change the policy: no more test runs on Lab A.**

```bash
POLICY=$(api GET /policies | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items.find(p=>p.name==="lab-a-dev").id))')
api PATCH /policies/$POLICY '{"capabilities":["terminal","file_read","file_write"]}' >/dev/null; echo removed exec
```

Do: in the hosted IDE, QE Tests → **Run on: lab-a-dev** → **Run all**.
See: no run starts; an error notification (bottom right) says **You are not allowed to connect to this system.**
Say: "An admin changes the lab's policy and it applies at once: here, terminals and files are still allowed, test runs
are not."

Re-run the audit query from F1: the refusal is the newest entry (`REMOTE_CONNECT_DENIED`, `denied`,
`capability_not_allowed`).

**Restore the policy right away:**

```bash
api PATCH /policies/$POLICY '{"capabilities":["terminal","file_read","file_write","exec"]}' >/dev/null; echo exec restored
```

**F3. Quality evidence (optional, 1 min).** Show [`docs/phase-gates/PHASE_11.md`](phase-gates/PHASE_11.md):
"1,716 unit tests, 154 integration tests and 9 end-to-end suites, the same scenarios in all three modes; every phase
has a gate record with real test output."

---

## 5. What is done and what is next

| Phase | What                                                                              | State                                                                               |
| ----- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 01–06 | Repository, IDE shell, control plane, roles, workspaces, terminal                 | Done                                                                                |
| 07–09 | Lab machine registry and policies, SSH broker, remote terminal and files          | Done (milestone M2)                                                                 |
| 10    | Desktop app and local web, personal SSH hosts, installers                         | Done; installers unsigned until certificates (D15)                                  |
| 11    | QE test runner and reports, tests on lab machines                                 | Done (milestone **M3**: web + desktop → same project → test run → results + report) |
| 13    | Observability: tracing, metrics, dashboards, alerts                               | **Next**                                                                            |
| 14–15 | Security hardening; signed, scanned releases                                      | After 13                                                                            |
| 12    | Company single sign-on, Vault secrets, short-lived SSH certificates, audit viewer | Last — needs the company identity provider and Vault                                |
| 16–18 | Kubernetes production, performance and recovery, pilot and rollout                | After 12                                                                            |

What the demo used that production replaces (say this if asked "is this production-ready?"):

| Demo                                   | Production                                                |
| -------------------------------------- | --------------------------------------------------------- |
| Development sign-in (`AUTH_MODE=dev`)  | Company single sign-on (Phase 12; Keycloak already works) |
| One development key file in the broker | Short-lived SSH certificates from Vault (Phase 12)        |
| An OpenSSH container as lab machine    | Real lab machines, registered the same way                |
| Docker on one PC                       | Kubernetes (Phase 16)                                     |
| Audit log read with SQL                | Audit viewer with filters and CSV export (Phase 12)       |

Decisions waiting on the organisation (help needed from the manager): see
[`ORG_DECISIONS.md`](ORG_DECISIONS.md) — B1 (company identity provider), D9 (hosted DNS name and certificate), D15
(code-signing certificates), D16 (package identity), D17 (desktop distribution and updates), D18 (where test reports
are stored), D19 (Maven dependency source).

---

## 6. Questions your manager may ask

| Question                                              | Answer                                                                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a user reach any machine?                         | No. Only machines an admin registered, only with the role the policy names, only on the allowed network and port, and only after the machine's identity is verified. |
| Where are the SSH keys?                               | Only in the broker on the server. The browser and the user never receive them. In production they become 10-minute certificates from Vault.                          |
| What if the lab machine is replaced or spoofed?       | Its host key would not match the approved one and the connection is refused before any credential is sent.                                                           |
| Can a user read files outside the project on the lab? | No — every path is checked on the server, links included (shown in C4), and each refusal is audited.                                                                 |
| Can someone inject commands through test names?       | No. Tests are started without a shell; on lab machines every value is quoted by one helper, and the inputs are checked. Tested with hostile inputs.                  |
| Does it work offline / on my laptop?                  | Yes: local web and the desktop app run fully on the laptop and use your own SSH config and keys.                                                                     |
| Which test frameworks?                                | pytest and Maven (JUnit/Surefire) today; others are an adapter each.                                                                                                 |
| How do we know it works the same in every mode?       | One parity test suite runs the same scenarios in hosted, local web and desktop; all green in the Phase 11 gate.                                                      |
| How long to production?                               | Remaining phases: observability, security hardening, release pipeline, SSO + Vault, Kubernetes, performance, pilot. The org decisions in section 5 set the pace.     |
| What does it cost?                                    | Open source components (Eclipse Theia, Node.js, PostgreSQL, Keycloak, OpenSSH libraries); no per-seat licence. Infrastructure: a Kubernetes cluster and Vault.       |

---

## 7. If something goes wrong

Stay calm, say "let me show you this another way", and use the fallback.

| Problem during the demo                                 | Quick fix                                                                                                                       | Fallback                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| The workspace page is blank or says it is not running   | T1: `api POST /workspaces/$WS/start '{}'`, wait 30–60 s, refresh                                                                | Show local web (Part E) first                                                |
| The page shows an error after a restart of the PC       | Check T2 and T3 still run; `curl localhost:8080/readyz`                                                                         | Restart T3 (`Ctrl+C`, then `npm run dev -w @qe/control-plane`)               |
| "The remote system did not answer in time"              | `docker start qews-lab-a`, try again                                                                                            | Skip to Part D's explanation, show the integration test evidence in PHASE_11 |
| "You are not allowed to connect" when it should work    | The policy lost `exec` (F2 not restored): run the restore command from F2                                                       | —                                                                            |
| QE Tests shows "The tests could not be listed…"         | Click the refresh icon in the panel; check the sample files exist (3.2)                                                         | Run `python3 -m pytest -q` in the terminal instead                           |
| Run on lab-a-dev ends with an error and no counts       | pytest is missing on the lab machine: `docker exec qews-lab-a python3 -m pytest --version`; if it fails, recreate the lab (2.8) | Run the tests in the workspace only                                          |
| Too many terminals ("limit of 10 open terminals")       | Close terminals (trash icon); or restart the workspace: `api POST /workspaces/$WS/stop '{}'`, then `start`                      | —                                                                            |
| Local web shows "Forbidden" or nothing                  | Open the link from `cat ~/.qe-workspace/local-web-url` again                                                                    | Show the desktop app                                                         |
| Broker or control plane: `EADDRINUSE … :8082` / `:8080` | An old copy runs in the background: the `kill $(ss …)` command in 3.1, then start T2/T3 again                                   | —                                                                            |
| Everything is slow                                      | Close other programs; `wsl --shutdown` the evening before and start fresh                                                       | —                                                                            |

---

## 8. After the demo

1. Restore anything you changed: the policy's `exec` (F2), and reset the sample if you want to show it again (2.11).
2. Stop the IDEs and services: `Ctrl+C` in T1–T4; then
   ```bash
   api POST /workspaces/$WS/stop '{}'
   docker compose -f deploy/compose/docker-compose.dev.yml stop
   docker stop qews-lab-a
   ```
3. Write down the manager's questions and decisions — especially on the open organisation decisions in section 5 — and
   add them to [`ORG_DECISIONS.md`](ORG_DECISIONS.md).
