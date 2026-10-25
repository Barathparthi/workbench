# Docker + WSL 2 Setup on Windows (installed on the D: drive)

A step-by-step guide to install **WSL 2** (Windows Subsystem for Linux) and **Docker Desktop** on Windows 10/11,
with everything that grows — the Linux disk, Docker's program files, images and containers — on **D:** instead of
C:. At the end, QE Workspace's Docker-based work runs on your machine: the development database and Keycloak, the
integration tests, and (later) workspace containers.

Written for the project PC (Windows 11 Home, build 26200, hardware virtualisation already on, D: = NTFS) but it
works on any Windows 10 22H2+ / Windows 11 machine.

|           |                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Time**  | 30–45 minutes (most of it downloads and one restart)                                                                                                 |
| **Disk**  | ~15 GB on D: to start (Ubuntu ≈ 1.5 GB, Docker ≈ 3 GB, project images ≈ 3–5 GB); plan for 40 GB+ over time. ~1 GB on C: for the WSL system component |
| **RAM**   | 16 GB recommended (8 GB minimum); Docker's VM is capped in Step 9                                                                                    |
| **Needs** | Administrator rights on the PC; internet access to Microsoft Store/GitHub and docker.com                                                             |

---

## 0. Before you start

### 0.1 Licence check (do this first at work)

**Docker Desktop is free only for** personal use, education, non-commercial open source, and companies with
**fewer than 250 employees _and_ less than USD 10 million annual revenue**. Larger companies need a paid Docker
subscription (Pro/Team/Business).

- If your company has a Docker subscription or IT approves it → follow this guide as written.
- If not → use one of the free alternatives in [Appendix A](#appendix-a--free-alternatives-to-docker-desktop)
  (Rancher Desktop, or Docker Engine inside WSL). Steps 1–5 (WSL) are the same; only the Docker part changes.

### 0.2 What goes where

```text
C:  ── WSL system component (part of Windows, ~1 GB) — cannot be moved, does not grow
D:\WSL\Ubuntu\ext4.vhdx         ── Ubuntu's Linux disk (grows with what you put in Linux)
D:\Docker\DockerDesktop\        ── Docker Desktop program files
D:\Docker\wsl-data\...vhdx      ── Docker's images, containers and volumes (grows the most)
D:\Docker\installer\            ── the downloaded installer
```

### 0.3 Check your PC (2 minutes)

Open **PowerShell** (Start → type `PowerShell` → Enter) and run:

```powershell
[System.Environment]::OSVersion.Version
```

Build (third number) must be **19045 or higher** (Windows 10 22H2) or any Windows 11 build. The project PC shows 26200 ✔.

```powershell
(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled
```

Must print **True**. If it prints False: restart into BIOS/UEFI (usually F2, F10 or Del while booting), enable
**Intel VT-x / Virtualization Technology** or **AMD SVM**, save and restart. (The project PC already shows True ✔.)

```powershell
Get-Volume -DriveLetter C,D | Select-Object DriveLetter, FileSystem, @{n='FreeGB';e={[math]::Round($_.SizeRemaining/1GB,1)}}
```

D: must be **NTFS** with **at least 20 GB free** (40 GB+ recommended). C: needs ~3 GB free for the install itself.

### 0.4 How to open an administrator PowerShell

Most steps below need it: **Start → type `PowerShell` → right-click "Windows PowerShell" → Run as administrator →
Yes**. The window title starts with "Administrator:". Use a **new** administrator window whenever a step says so.

---

## Part 1 — WSL 2 with Ubuntu on D:

### Step 1 — Create the folders on D:

In an **administrator PowerShell**:

```powershell
New-Item -ItemType Directory -Force D:\WSL\Ubuntu, D:\Docker\DockerDesktop, D:\Docker\wsl-data, D:\Docker\installer
```

Expected: four lines listing the folders.

### Step 2 — Install WSL (without a Linux distribution yet)

```powershell
wsl --install --no-distribution
```

This turns on the Windows features **Windows Subsystem for Linux** and **Virtual Machine Platform** and installs the
WSL package. Expected: "The requested operation is successful. Changes will not be effective until the system is
rebooted."

> If it prints the help text instead, your Windows is older: run `wsl --install` without options, then continue —
> Step 4b moves Ubuntu to D: afterwards.

### Step 3 — Restart the PC

Save your work and restart (**Start → Power → Restart**). The features only work after a restart.

### Step 4 — Install Ubuntu on D:

After the restart, open a **new administrator PowerShell**:

```powershell
wsl --update
```

Expected: "The most recent version of Windows Subsystem for Linux is already installed." or an update message.

```powershell
wsl --version
```

Expected: `WSL version: 2.x` or newer (the project PC had 3.0.3).

Now install Ubuntu **directly onto D:**:

```powershell
wsl --install -d Ubuntu --location D:\WSL\Ubuntu
```

After a minute a terminal asks:

1. **Enter new UNIX username** — type a short lowercase name (e.g. `barath`) and press Enter. It does not need to
   match your Windows name.
2. **New password** — type a password and Enter (nothing is shown while you type — that is normal). Repeat it.
   **Write it down**: you need it for `sudo` inside Ubuntu.
3. When you see a prompt like `barath@DESKTOP-…:~$`, type `exit` and press Enter.

#### Step 4b — Only if `--location` was refused ("invalid option")

Install normally, then move it:

```powershell
wsl --install -d Ubuntu
```

(complete the username/password questions, then `exit`)

```powershell
wsl --shutdown
wsl --manage Ubuntu --move D:\WSL\Ubuntu
```

### Step 5 — Check WSL

In a normal PowerShell:

```powershell
wsl -l -v
```

Expected:

```text
  NAME      STATE           VERSION
* Ubuntu    Stopped         2
```

**VERSION must be 2.** If it shows 1: `wsl --set-version Ubuntu 2` (takes a few minutes), and
`wsl --set-default-version 2` for the future.

Confirm the Linux disk is on D::

```powershell
Get-ChildItem D:\WSL\Ubuntu
```

Expected: a file named **`ext4.vhdx`**.

Optional — update Ubuntu's packages (enter your Linux password when asked):

```powershell
wsl -d Ubuntu -- sudo apt-get update
wsl -d Ubuntu -- sudo apt-get -y upgrade
```

---

## Part 2 — Docker Desktop on D:

### Step 6 — Download the installer (do not run it by double-click)

1. Go to <https://www.docker.com/products/docker-desktop/> → **Download for Windows – AMD64**.
2. Save it as **`D:\Docker\installer\Docker Desktop Installer.exe`** (in the browser's download dialog choose that
   folder, or move the file there afterwards).

> **Why not double-click?** The normal installer puts everything on C:. Only the command-line install lets you
> choose the program folder and the data folder.

Optional — check the file is the genuine signed installer:

```powershell
Get-AuthenticodeSignature "D:\Docker\installer\Docker Desktop Installer.exe" | Format-List Status, SignerCertificate
```

Expected: `Status : Valid` and a signer subject containing **Docker Inc**.

### Step 7 — Install Docker Desktop onto D:

In an **administrator PowerShell** (one command; it takes 3–5 minutes and shows no progress — wait for the prompt to
return):

```powershell
Start-Process -Wait -FilePath "D:\Docker\installer\Docker Desktop Installer.exe" -ArgumentList 'install','--quiet','--accept-license','--backend=wsl-2','--installation-dir=D:\Docker\DockerDesktop','--wsl-default-data-root=D:\Docker\wsl-data'
```

What each option does:

| Option                                       | Meaning                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `install`                                    | install (rather than uninstall/update)                                                             |
| `--quiet`                                    | no installer window; you wait at the prompt                                                        |
| `--accept-license`                           | accepts the Docker Subscription Service Agreement — **only if your licence check (0.1) allows it** |
| `--backend=wsl-2`                            | use WSL 2 (not Hyper-V, which Windows Home does not have)                                          |
| `--installation-dir=D:\Docker\DockerDesktop` | Docker's program files on D:                                                                       |
| `--wsl-default-data-root=D:\Docker\wsl-data` | Docker's images/containers/volumes disk on D:                                                      |

Check the program landed on D::

```powershell
Test-Path "D:\Docker\DockerDesktop\Docker Desktop.exe"
```

Expected: **True**.

### Step 8 — Sign out and back in, then start Docker Desktop

1. **Start → your account → Sign out**, then sign back in (the installer added you to the `docker-users` group;
   that only takes effect after signing in again). A restart works too.
2. Start **Docker Desktop** from the Start menu.
3. First start:
   - Service agreement screen: accept only if 0.1 allows it.
   - "Sign in / Create account": **Skip** (an account is not needed for this project).
   - Survey: **Skip**.
4. Wait until the whale icon in the taskbar tray stops animating and Docker Desktop shows **"Engine running"**
   (bottom-left, green). The first start takes 1–2 minutes.

### Step 9 — Settings (one time)

In Docker Desktop click the **⚙ gear (Settings)**:

1. **General**
   - ✅ _Use the WSL 2 based engine_ (already on, may be greyed out on Windows Home — that is fine).
   - ✅ _Start Docker Desktop when you sign in_ — optional; turn it **off** if you only use Docker sometimes (saves RAM).
2. **Resources → Advanced**
   - **Disk image location** must show `D:\Docker\wsl-data`. If it shows a C: path: click **Browse**, choose
     `D:\Docker\wsl-data`, **Apply & restart** (Docker moves its disk; wait until it finishes).
3. **Resources → WSL integration**
   - ✅ _Enable integration with my default WSL distro_, and switch **Ubuntu** on.
4. Click **Apply & restart**.

#### Limit memory and CPU for WSL/Docker (recommended)

WSL 2 may use up to half your RAM by default. Create the file **`C:\Users\<your-windows-user>\.wslconfig`**
(for the project PC: `C:\Users\LENOVO\.wslconfig`). Easiest way:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Answer **Yes** to create it, paste the following, save, close:

```ini
[wsl2]
# About half of your RAM; 6GB suits a 12–16 GB PC. The project's dev stack + tests fit in 4–6 GB.
memory=6GB
processors=4
# Return freed memory to Windows.
[experimental]
autoMemoryReclaim=gradual
```

Apply it:

```powershell
wsl --shutdown
```

Then quit Docker Desktop (tray icon → **Quit Docker Desktop**) and start it again.

### Step 10 — Verify everything

In a **normal** PowerShell:

```powershell
docker version
```

Expected: both a **Client** and a **Server** section (Server: Docker Desktop, OS/Arch `linux/amd64`). If you only see
Client and an error about the pipe, Docker Desktop is not running yet — start it and wait for "Engine running".

```powershell
docker compose version
docker run --rm hello-world
```

Expected: `Docker Compose version v2.x` and **"Hello from Docker!"**.

```powershell
wsl -l -v
```

Expected now: `Ubuntu` **and** `docker-desktop`, both VERSION 2.

Confirm the data is on D::

```powershell
Get-ChildItem D:\WSL, D:\Docker -Recurse -Filter *.vhdx -ErrorAction SilentlyContinue |
  Select-Object FullName, @{n='SizeMB';e={[math]::Round($_.Length/1MB)}}
```

Expected: `D:\WSL\Ubuntu\ext4.vhdx` and a `.vhdx` under `D:\Docker\wsl-data\`.

✅ **Docker and WSL are installed.** Part 3 runs the project's Docker-based work.

---

## Part 3 — Use it with QE Workspace

All commands run in a normal PowerShell in the repository folder:

```powershell
cd D:\QE\workbench\QE-Workspace
```

Docker Desktop must be running ("Engine running").

### Step 11 — Start the development stack (PostgreSQL + Keycloak)

```powershell
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait
```

The first run downloads the images (~1 GB, a few minutes). Expected: `Container qews-dev-postgres-1 Healthy` and
`Container qews-dev-keycloak-1 Healthy`.

```powershell
docker compose -f deploy/compose/docker-compose.dev.yml ps
```

Expected: both services `running (healthy)`, ports `127.0.0.1:5432` and `127.0.0.1:8081`.

- Keycloak admin console: <http://localhost:8081> (user `admin`, password `devonly` — **development only**).
- Test users in realm `qe`: `alice`/`dev-alice`, `bob`/`dev-bob`, `admin`/`dev-admin`, `audrey`/`dev-audrey`.

### Step 12 — Run the integration tests locally

These are the suites that so far only ran in GitHub CI (PostgreSQL, Keycloak login, OpenSSH, lifecycle):

```powershell
npm run test:integration
```

Testcontainers starts throwaway containers per test file and removes them afterwards. The first run downloads the
PostgreSQL, Keycloak and Alpine images and builds the OpenSSH test image — allow 5–10 minutes. Expected at the end:
`Test Files  N passed` with no failures.

> Testcontainers finds Docker Desktop automatically through the Windows named pipe. If it reports
> "Could not find a working container runtime strategy", Docker Desktop is not running — start it and retry.

### Step 13 — Run the control plane against the dev stack

```powershell
Copy-Item apps\control-plane\.env.example apps\control-plane\.env
npm run dev -w @qe/control-plane
```

Expected: `migrations: applied …` and the server listening on `http://127.0.0.1:8080`. In another PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/readyz
```

Expected: `status : ready`. Stop the control plane with **Ctrl+C**.

> The `.env` file is git-ignored. It contains development-only values; never reuse them anywhere else.

### Step 14 — Stop / reset

```powershell
docker compose -f deploy/compose/docker-compose.dev.yml down
```

stops the stack and keeps the database. Add `-v` to **delete** the database and start fresh next time:

```powershell
docker compose -f deploy/compose/docker-compose.dev.yml down -v
```

Free disk space used by old images and build cache (safe; removes only unused items):

```powershell
docker system prune
```

### What still needs more than Docker

- **Building the Theia IDE apps locally** (browser/Electron) also needs **Visual Studio Build Tools 2022** with the
  workload **"Desktop development with C++"** for the native modules. Docker is not involved; CI builds them today.
- **Milestone runs (M1/M2)** — start a workspace container, open the IDE through `/w/{id}/`, connect to a lab SSH
  target — get their own walkthrough once Docker is confirmed working.

---

## Troubleshooting

| Symptom                                                       | Cause                                                               | Fix                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wsl --install` prints only help text                         | Old Windows build                                                   | Windows Update to the latest build, or use `wsl --install` + Step 4b                                                                                                                                                    |
| Error **0x80370102** / "virtual machine could not be started" | Virtualisation off in BIOS, or Virtual Machine Platform not enabled | Section 0.3 BIOS step; then `wsl --install --no-distribution` again and restart                                                                                                                                         |
| Error **0x8007019e**                                          | WSL feature not enabled                                             | Admin PowerShell: `dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart` and `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, restart |
| "WSL 2 requires an update to its kernel"                      | Old WSL package                                                     | `wsl --update`, then `wsl --shutdown`                                                                                                                                                                                   |
| `--location` "invalid option"                                 | WSL older than 2.4                                                  | `wsl --update`; or Step 4b                                                                                                                                                                                              |
| Ubuntu shows VERSION 1                                        | Default was WSL 1                                                   | `wsl --set-version Ubuntu 2`                                                                                                                                                                                            |
| Docker Desktop stuck on "Starting the Docker Engine…"         | WSL state stuck                                                     | Quit Docker Desktop, `wsl --shutdown`, start Docker Desktop again; if still stuck: Troubleshoot (🐞 icon) → **Restart**                                                                                                 |
| `docker: error during connect … pipe/docker_engine`           | Docker Desktop not running, or you are not in `docker-users`        | Start Docker Desktop and wait for "Engine running"; sign out and in once after installing                                                                                                                               |
| "Access denied" running `docker`                              | Not in `docker-users` group                                         | Admin PowerShell: `net localgroup docker-users "$env:USERNAME" /add`, then sign out/in                                                                                                                                  |
| Disk image location shows C:                                  | Installer flag missed                                               | Settings → Resources → Advanced → Browse → `D:\Docker\wsl-data` → Apply & restart                                                                                                                                       |
| C: still filling up                                           | Old Docker/WSL data left on C:                                      | Check `%LOCALAPPDATA%\Docker\wsl` and `%LOCALAPPDATA%\Packages\CanonicalGroupLimited*` — only remove after confirming Steps 5 and 10 show D: paths                                                                      |
| Port 5432 or 8081 "already allocated"                         | Another PostgreSQL/Keycloak running                                 | Stop the other service, or change the left side of the port in `deploy/compose/docker-compose.dev.yml` locally (do not commit)                                                                                          |
| Corporate proxy: image pulls time out                         | Proxy needed                                                        | Docker Desktop → Settings → Resources → Proxies → set your proxy; for npm: `npm config set proxy …`                                                                                                                     |
| Antivirus slows Docker heavily                                | Real-time scan of the VHDX files                                    | Ask IT to exclude `D:\WSL\` and `D:\Docker\wsl-data\`                                                                                                                                                                   |
| Integration tests time out on first run                       | Images still downloading                                            | Run `npm run test:integration` again; later runs are fast                                                                                                                                                               |

Collect diagnostics for IT if needed: Docker Desktop → 🐞 **Troubleshoot** → **Get support** → **Gather diagnostics**,
and `wsl --version` output.

---

## Appendix A — Free alternatives to Docker Desktop

Use one of these if the licence check (0.1) rules Docker Desktop out. Do Part 1 (WSL) first either way.

### A.1 Rancher Desktop (closest to Docker Desktop, free)

1. Download from <https://rancherdesktop.io> (Windows `.msi`). During install choose **Install for all users**.
2. First start → **Container engine: dockerd (moby)** (this gives you the normal `docker` and `docker compose`
   commands) → **Kubernetes: off** (not needed now).
3. Its data lives in the `rancher-desktop-data` WSL distribution; move it to D: with:

   ```powershell
   wsl --shutdown
   wsl --manage rancher-desktop-data --move D:\RancherDesktop\data
   ```

4. Verify with Step 10's commands.

### A.2 Docker Engine inside Ubuntu (no Windows app, free)

Everything happens inside Ubuntu (already on D:). Open Ubuntu (Start → **Ubuntu**) and run:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker "$USER"
```

Close the Ubuntu window and open it again, then:

```bash
docker run --rm hello-world
```

Use Docker **from the Ubuntu terminal**: clone or open the repository inside Ubuntu (for speed, keep it in the
Linux home folder, e.g. `~/QE-Workspace`, rather than under `/mnt/d/…`), install Node 24.22.0 there (`nvm`), and run
the Part 3 commands in Ubuntu. Windows PowerShell's `docker` command does not see this engine.

---

## Appendix B — Uninstall (if ever needed)

Docker Desktop:

```powershell
Start-Process -Wait -FilePath "D:\Docker\DockerDesktop\Docker Desktop Installer.exe" -ArgumentList 'uninstall','--quiet'
```

(or Settings → Apps → Installed apps → Docker Desktop → Uninstall). Then delete `D:\Docker` if nothing there is needed.

Ubuntu (deletes everything inside it):

```powershell
wsl --unregister Ubuntu
```

WSL itself (admin PowerShell):

```powershell
wsl --uninstall
```

The Windows features _Windows Subsystem for Linux_ and _Virtual Machine Platform_ can stay; to remove them:
Start → "Turn Windows features on or off" → untick both → OK → restart.

---

## Checklist

- [ ] 0.1 Licence allowed (or Appendix A chosen)
- [ ] 0.3 Build ≥ 19045, virtualisation True, D: NTFS with 20 GB+ free
- [ ] Step 2–3 WSL installed, PC restarted
- [ ] Step 4–5 Ubuntu on D: (`D:\WSL\Ubuntu\ext4.vhdx`), VERSION 2, Linux password noted
- [ ] Step 7 Docker program on D: (`Test-Path` True)
- [ ] Step 8 signed out/in, Docker Desktop "Engine running"
- [ ] Step 9 disk image location `D:\Docker\wsl-data`, WSL integration on, `.wslconfig` limits
- [ ] Step 10 `docker run --rm hello-world` prints "Hello from Docker!"
- [ ] Step 11 dev stack healthy
- [ ] Step 12 `npm run test:integration` all green
