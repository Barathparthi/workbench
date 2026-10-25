# Docker + WSL 2 Setup on Windows (Docker Engine inside Ubuntu, on the D: drive)

A step-by-step guide to install **WSL 2** (Windows Subsystem for Linux) with **Ubuntu on D:**, and **Docker Engine
inside that Ubuntu** — no Docker Desktop. Everything that grows (the Linux disk, Docker's images, containers and
volumes, the repository clone, `node_modules`) lives in one file on **D:**. At the end, QE Workspace's Docker-based
work runs on your machine: the development database and Keycloak, the integration tests, and (later) workspace
containers.

Written for the project PC (Windows 11 Home, build 26200, hardware virtualisation on, D: = NTFS, WSL 3.0.3,
Ubuntu 26.04 with systemd) but it works on any Windows 10 22H2+ / Windows 11 machine.

|           |                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Time**  | 30–45 minutes (most of it downloads and one restart)                                                                      |
| **Disk**  | ~10 GB on D: to start (Ubuntu ≈ 1.5 GB, Docker ≈ 0.5 GB, project images ≈ 3–5 GB, `node_modules` ≈ 1 GB); plan for 40 GB+ |
| **RAM**   | 16 GB recommended (8 GB minimum); WSL's memory is set in Step 6                                                           |
| **Needs** | Administrator rights on Windows; internet access to Microsoft Store/GitHub, `download.docker.com`, Docker Hub and npm     |

---

## 0. Before you start

### 0.1 Why Docker Engine inside Ubuntu

- **Free for any company size.** Docker Engine is open source (Apache 2.0); there is no Docker Desktop subscription
  question. (Docker Desktop remains an option — [Appendix A](#appendix-a--docker-desktop-instead).)
- **Linux-identical.** The same engine, socket and commands as GitHub CI (`ubuntu-latest`), so integration tests
  behave the same.
- **Everything on D:.** Docker's data lives inside Ubuntu's disk, which you put on D: in Step 4.

The one rule to remember: **use `docker`, `npm` and the tests from the Ubuntu terminal.** Windows PowerShell's
`docker` command does not see this engine (and there is none installed on Windows).

### 0.2 What goes where

```text
C:  ── WSL system component (part of Windows, ~1 GB) — cannot be moved, does not grow
D:\WSL\Ubuntu\ext4.vhdx   ── Ubuntu's Linux disk. Inside it:
     /var/lib/docker/          Docker's images, containers, volumes (grows the most)
     ~/QE-Workspace/           your working clone of the repository + node_modules
D:\QE\workbench\QE-Workspace  ── the Windows checkout (unchanged; Ubuntu sees it at /mnt/d/QE/workbench/QE-Workspace)
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

D: must be **NTFS** with **at least 20 GB free** (40 GB+ recommended). C: needs ~2 GB free for the WSL component.

### 0.4 How to open an administrator PowerShell / the Ubuntu terminal

- **Administrator PowerShell:** Start → type `PowerShell` → right-click "Windows PowerShell" → **Run as
  administrator** → Yes. The window title starts with "Administrator:".
- **Ubuntu terminal:** Start → type `Ubuntu` → Enter (or run `wsl -d Ubuntu` in any PowerShell). The prompt looks
  like `barath@DESKTOP-…:~$`. Commands in `bash` blocks below go here.

---

## Part 1 — WSL 2 with Ubuntu on D:

> **Project PC:** Steps 1–4 are done (WSL 3.0.3, Ubuntu 26.04 on WSL 2). Continue at Step 5.

### Step 1 — Create the folder on D:

In an **administrator PowerShell**:

```powershell
New-Item -ItemType Directory -Force D:\WSL\Ubuntu
```

### Step 2 — Install WSL (without a Linux distribution yet)

```powershell
wsl --install --no-distribution
```

It works from any folder — no `cd` needed. This turns on the Windows features **Windows Subsystem for Linux** and
**Virtual Machine Platform** and installs the WSL package (always on C:, ~1 GB). Expected: "The requested operation is
successful. Changes will not be effective until the system is rebooted."

> If it prints the help text instead, your Windows is older: run `wsl --install` without options, then continue —
> Step 4b moves Ubuntu to D: afterwards.

### Step 3 — Restart the PC

Save your work and restart (**Start → Power → Restart**). The features only work after a restart.

### Step 4 — Install Ubuntu on D:

After the restart, open a **new administrator PowerShell**:

```powershell
wsl --update
wsl --version
```

Expected: `WSL version: 2.x` or newer.

Now install Ubuntu **directly onto D:**:

```powershell
wsl --install -d Ubuntu --location D:\WSL\Ubuntu
```

After a minute a terminal asks:

1. **"Would you like to opt-in to platform metrics collection (Y/n)?"** (newer Ubuntu releases) — type **`n`** and
   Enter. It only decides whether anonymous hardware info is sent to Canonical; nothing else changes. Change it later
   with `ubuntu-insights consent`.
2. **Enter new UNIX username** — a short lowercase name (e.g. `barath`). It does not need to match your Windows name.
3. **New password** — type it and Enter (nothing is shown while you type — that is normal), then repeat it.
   **Write it down**: `sudo` asks for it in Part 2.
4. At the prompt `barath@DESKTOP-…:~$`, type `exit`.

#### Step 4b — Only if `--location` was refused ("invalid option")

```powershell
wsl --install -d Ubuntu
```

(complete the questions above, then `exit`)

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

**VERSION must be 2.** If it shows 1: `wsl --set-version Ubuntu 2`, and `wsl --set-default-version 2` for the future.

```powershell
Get-ChildItem D:\WSL\Ubuntu
```

Expected: a file named **`ext4.vhdx`** — Ubuntu (and later all Docker data) is on D:.

### Step 6 — Give WSL enough memory (`.wslconfig`)

By default WSL may get too little memory for Docker plus the tests (the project PC's Ubuntu reported only ~3.5 GB).
Create **`C:\Users\<your-windows-user>\.wslconfig`** (project PC: `C:\Users\LENOVO\.wslconfig`):

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Answer **Yes** to create it, paste, save, close:

```ini
[wsl2]
# 8GB on a 16 GB PC, 4GB on an 8 GB PC. The dev stack + integration tests need about 4–6 GB.
memory=8GB
processors=6
# A little swap so a test spike does not kill containers.
swap=4GB
# Let Windows reach services in Ubuntu at localhost (browser → Keycloak, control plane). Default, stated for clarity.
localhostForwarding=true

[experimental]
# Return freed memory to Windows.
autoMemoryReclaim=gradual
```

### For 8GB RAM and 512 GB Storage

```ini
[wsl2]
# 8 GB PC: 4 GB for Ubuntu + Docker, the rest stays with Windows.
memory=4GB
processors=4
# Extra headroom on disk for test spikes; the swap file goes on D: instead of C:.
swap=6GB
swapFile=D:\\WSL\\swap.vhdx
# Let Windows reach services in Ubuntu at localhost (browser → Keycloak, control plane).
localhostForwarding=true

[experimental]
# Return freed memory to Windows.
autoMemoryReclaim=gradual
```

Apply it and check:

```powershell
wsl --shutdown
wsl -d Ubuntu -- free -h
```

Expected: `Mem: total` close to the value you set.

---

## Part 2 — Docker Engine inside Ubuntu

All commands in this part run in the **Ubuntu terminal**. `sudo` asks for the Linux password from Step 4.

### Step 7 — Check systemd is on

Switch to the Ubuntu terminal. In the same PowerShell window, type:

```bash
wsl -d Ubuntu
```

Docker runs as a systemd service.

```bash
ps -p 1 -o comm=
```

Expected: **`systemd`**. (New Ubuntu installs have it on; the project PC's report says `systemd: used` ✔.)
If it prints `init`: run `sudo nano /etc/wsl.conf`, add

```ini
[boot]
systemd=true
```

save (Ctrl+O, Enter, Ctrl+X), then in PowerShell `wsl --shutdown`, reopen Ubuntu and check again.

### Step 8 — Update Ubuntu

```bash
sudo apt-get update
sudo apt-get -y upgrade
```

Remove any old/unofficial Docker packages (harmless if none are installed — "Unable to locate package" is fine):

```bash
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do sudo apt-get remove -y $pkg; done
```

### Step 9 — Add Docker's official package repository

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

Expected: the last command lists a line from `download.docker.com` without errors.

> **"…does not have a Release file"** for a brand-new Ubuntu release means Docker has not published packages for it
> yet. Use the previous LTS packages (they work on the newer release):
>
> ```bash
> sudo sed -i -E 's#(ubuntu )[a-z]+( stable)#\1noble\2#' /etc/apt/sources.list.d/docker.list
> sudo apt-get update
> ```

### Step 10 — Install Docker Engine and Compose

```bash
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Let your Linux user run `docker` without `sudo`, and start Docker with Ubuntu:

```bash
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker containerd
```

**Close the Ubuntu window and open it again** (the group change only applies to new sessions). If `docker` still
says "permission denied", run `wsl --shutdown` in PowerShell and reopen Ubuntu.

### Step 11 — Verify Docker

```bash
docker version
docker compose version
docker run --rm hello-world
```

Expected: a **Client** and a **Server** section (Server: Docker Engine – Community), `Docker Compose version v2.x`,
and **"Hello from Docker!"**.

Confirm Docker's data is inside Ubuntu's disk (which is on D:):

```bash
docker info --format '{{.DockerRootDir}}'
```

Expected: `/var/lib/docker`.

### Step 12 — Optional: log rotation

Keeps container logs from filling the disk:

```bash
echo '{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

✅ **Docker is installed.** Part 3 sets up the project inside Ubuntu.

---

## Part 3 — Use it with QE Workspace (from Ubuntu)

### Step 13 — Tools for Node and native modules

```bash
sudo apt-get install -y git build-essential python3 pkg-config libsecret-1-dev libx11-dev libxkbfile-dev
```

(`build-essential`/`python3` compile native modules such as `node-pty`; the `lib…-dev` packages are what Theia's
native dependencies need on Linux.)

Install **Node 24.22.0** with `nvm` (the version in `.nvmrc`):

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Close and reopen the Ubuntu terminal, then:

```bash
nvm install 24.22.0
nvm alias default 24.22.0
node --version
npm --version
```

Expected: `v24.22.0` and `11.x`.

Tell Git who you are (same name/e-mail as on Windows):

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global core.autocrlf input
```

### Step 14 — Clone the repository into Ubuntu's home folder

Keep the working copy **inside Linux** (`~/QE-Workspace`), not under `/mnt/d/…`:

- files under `/mnt/d` go through a Windows file-sharing layer and are 5–10× slower for `npm ci` and tests;
- the Windows checkout's `node_modules` holds **Windows** native binaries (esbuild, rollup, node-pty) that do not run
  on Linux.

Clone from the Windows checkout — no GitHub login needed:

```bash
git clone /mnt/d/QE/workbench/QE-Workspace ~/QE-Workspace
cd ~/QE-Workspace
git checkout main
npm ci
```

`npm ci` takes a few minutes the first time.

**Keeping the two copies in step.** The Windows checkout stays the one you commit and push from. After you commit
there (any branch), bring it into Ubuntu with:

```bash
cd ~/QE-Workspace
git fetch origin
git checkout <branch>
git pull
```

(`origin` here is `/mnt/d/QE/workbench/QE-Workspace`. If `package-lock.json` changed, run `npm ci` again.)
Uncommitted Windows changes are not visible to the Ubuntu clone — commit them first.

> Tip: **VS Code** with the **WSL** extension can open `~/QE-Workspace` directly (in Ubuntu: `code .`), if you prefer
> editing inside Ubuntu instead.

### Step 15 — Start the development stack (PostgreSQL + Keycloak)

```bash
cd ~/QE-Workspace
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait
docker compose -f deploy/compose/docker-compose.dev.yml ps
```

The first run downloads the images (~1 GB). Expected: both services `running (healthy)` on `127.0.0.1:5432` and
`127.0.0.1:8081`.

- Keycloak admin console — open in your **Windows** browser: <http://localhost:8081> (user `admin`, password
  `devonly` — **development only**). WSL forwards `localhost` to Ubuntu.
- Test users in realm `qe`: `alice`/`dev-alice`, `bob`/`dev-bob`, `admin`/`dev-admin`, `audrey`/`dev-audrey`.

### Step 16 — Run the tests

Unit tests first (no Docker), then the Docker-based suites that so far only ran in GitHub CI (PostgreSQL, Keycloak
login, OpenSSH, lifecycle):

```bash
npm run test:unit
npm run test:integration
```

Testcontainers finds Docker through `/var/run/docker.sock` automatically. The first integration run downloads the
PostgreSQL, Keycloak and Alpine images and builds the OpenSSH test image — allow 5–10 minutes. Expected:
`Test Files  N passed` with no failures.

### Step 17 — Run the control plane against the dev stack

```bash
cp apps/control-plane/.env.example apps/control-plane/.env
npm run dev -w @qe/control-plane
```

Expected: `migrations: applied …` and the server listening on `http://127.0.0.1:8080`. Check from a second Ubuntu
terminal (`curl -s http://127.0.0.1:8080/readyz`) or from Windows PowerShell
(`Invoke-RestMethod http://127.0.0.1:8080/readyz`). Expected: `ready`. Stop with **Ctrl+C**.

> The `.env` file is git-ignored and holds development-only values; never reuse them anywhere else.

### Step 18 — Stop / reset / free space

```bash
docker compose -f deploy/compose/docker-compose.dev.yml down       # stop, keep the database
docker compose -f deploy/compose/docker-compose.dev.yml down -v    # stop and DELETE the database
docker system prune                                                # remove unused images/containers/cache
```

Stop the whole Ubuntu VM (and Docker) when you are done, to give the memory back to Windows — in PowerShell:

```powershell
wsl --shutdown
```

Docker starts again automatically the next time you open Ubuntu.

**Shrinking the disk.** `ext4.vhdx` grows but does not shrink by itself after `docker system prune`. Turn on sparse
mode once (PowerShell, after `wsl --shutdown`):

```powershell
wsl --manage Ubuntu --set-sparse true
```

### What still needs more than Docker

- **Milestone runs (M1/M2)** — start a workspace container, open the IDE through `/w/{id}/`, connect to a lab SSH
  target — get their own walkthrough once Docker is confirmed working.
- **The Electron desktop app** is built and run on Windows (Visual Studio Build Tools 2022, "Desktop development with
  C++"); CI builds it today.

---

## Troubleshooting

| Symptom                                                       | Cause                                                               | Fix                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wsl --install` prints only help text                         | Old Windows build                                                   | Windows Update to the latest build, or use `wsl --install` + Step 4b                                                                                                                                                    |
| Error **0x80370102** / "virtual machine could not be started" | Virtualisation off in BIOS, or Virtual Machine Platform not enabled | Section 0.3 BIOS step; then `wsl --install --no-distribution` again and restart                                                                                                                                         |
| Error **0x8007019e**                                          | WSL feature not enabled                                             | Admin PowerShell: `dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart` and `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, restart |
| `--location` "invalid option"                                 | WSL older than 2.4                                                  | `wsl --update`; or Step 4b                                                                                                                                                                                              |
| Ubuntu shows VERSION 1                                        | Default was WSL 1                                                   | `wsl --set-version Ubuntu 2`                                                                                                                                                                                            |
| `docker` in **PowerShell**: "not recognized"                  | Expected — Docker is installed in Ubuntu only                       | Run Docker commands in the Ubuntu terminal                                                                                                                                                                              |
| `permission denied … /var/run/docker.sock`                    | Group change not applied yet                                        | Close and reopen Ubuntu; if still failing, `wsl --shutdown` and reopen; `groups` must list `docker`                                                                                                                     |
| `Cannot connect to the Docker daemon`                         | Service not running / systemd off                                   | `sudo systemctl start docker`; check Step 7 (`ps -p 1 -o comm=` must print `systemd`)                                                                                                                                   |
| Docker repo "does not have a Release file"                    | Docker has no packages for this Ubuntu release yet                  | Step 9 note (use `noble`)                                                                                                                                                                                               |
| Containers killed / tests crash with exit 137                 | Out of memory                                                       | Raise `memory=` in `.wslconfig` (Step 6), `wsl --shutdown`                                                                                                                                                              |
| `http://localhost:8081` does not open in the Windows browser  | Stack not running, or localhost forwarding off                      | `docker compose … ps` in Ubuntu; `.wslconfig` `localhostForwarding=true`; `wsl --shutdown`                                                                                                                              |
| `npm ci` fails building `node-pty` / native modules           | Build tools missing                                                 | Step 13 `apt-get install` line                                                                                                                                                                                          |
| `npm ci` very slow, or "invalid ELF header"                   | Running in `/mnt/d/…` or reusing Windows `node_modules`             | Work in `~/QE-Workspace` (Step 14)                                                                                                                                                                                      |
| Image pulls time out behind a corporate proxy                 | Proxy needed                                                        | `sudo systemctl edit docker` → `[Service]` + `Environment="HTTPS_PROXY=http://proxy:port"`, then `sudo systemctl restart docker`; for npm `npm config set proxy …`                                                      |
| DNS failures inside Ubuntu (VPN)                              | VPN changes DNS                                                     | Add `dnsTunneling=true` under `[wsl2]` in `.wslconfig`, `wsl --shutdown`                                                                                                                                                |
| Port 5432 or 8081 "already allocated"                         | Another PostgreSQL/Keycloak running                                 | Stop the other service, or change the left side of the port in `deploy/compose/docker-compose.dev.yml` locally (do not commit)                                                                                          |
| Antivirus slows everything heavily                            | Real-time scan of the VHDX                                          | Ask IT to exclude `D:\WSL\`                                                                                                                                                                                             |
| Integration tests time out on first run                       | Images still downloading                                            | Run `npm run test:integration` again; later runs are fast                                                                                                                                                               |

Diagnostics for IT: `wsl --version`, `wsl -l -v` (PowerShell) and `docker info`, `systemctl status docker` (Ubuntu).

---

## Appendix A — Docker Desktop instead

If you later want Docker Desktop (a Windows app; `docker` then also works in PowerShell): it is free only for
personal use, education, non-commercial open source and companies with **fewer than 250 employees and less than
USD 10 million revenue**. **Do not run both engines** — first remove the Ubuntu one:

```bash
sudo systemctl disable --now docker docker.socket containerd
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Then download the installer to `D:\Docker\installer\` and install onto D: from an administrator PowerShell:

```powershell
New-Item -ItemType Directory -Force D:\Docker\DockerDesktop, D:\Docker\wsl-data, D:\Docker\installer
Start-Process -Wait -FilePath "D:\Docker\installer\Docker Desktop Installer.exe" -ArgumentList 'install','--quiet','--accept-license','--backend=wsl-2','--installation-dir=D:\Docker\DockerDesktop','--wsl-default-data-root=D:\Docker\wsl-data'
```

Sign out and in, start Docker Desktop, and in Settings → Resources → **WSL integration** switch **Ubuntu** on — the
Ubuntu workflow in Part 3 keeps working unchanged.

---

## Appendix B — Uninstall (if ever needed)

Docker Engine (Ubuntu terminal):

```bash
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo rm -rf /var/lib/docker /var/lib/containerd
```

Ubuntu, including Docker data and the clone inside it (PowerShell):

```powershell
wsl --unregister Ubuntu
```

WSL itself (administrator PowerShell):

```powershell
wsl --uninstall
```

The Windows features _Windows Subsystem for Linux_ and _Virtual Machine Platform_ can stay; to remove them:
Start → "Turn Windows features on or off" → untick both → OK → restart.

---

## Appendix C — Change or reset the Ubuntu (sudo) password

`sudo` asks for your own Ubuntu user's password, so changing that password changes the `sudo` password.

**You know the current password** — in the Ubuntu terminal:

```bash
passwd
```

Enter the current password, then the new one twice (nothing is shown while you type — that is normal).

**You forgot it** — reset it from PowerShell (logging in as `root` needs no password):

1. Open Ubuntu as root:

   ```powershell
   wsl -d Ubuntu -u root
   ```

   The prompt changes to `root@DESKTOP-…#`.

2. Find your username if unsure:

   ```bash
   ls /home
   ```

3. Set the new password (replace `barath` with your username) and type it twice:

   ```bash
   passwd barath
   ```

4. Leave the root session:

   ```bash
   exit
   ```

5. Open Ubuntu normally (`wsl -d Ubuntu`) and test it — no error means it worked:

   ```bash
   sudo -v
   ```

---

## Checklist

- [ ] 0.3 Build ≥ 19045, virtualisation True, D: NTFS with 20 GB+ free
- [ ] Steps 2–3 WSL installed, PC restarted
- [ ] Steps 4–5 Ubuntu on D: (`D:\WSL\Ubuntu\ext4.vhdx`), VERSION 2, Linux password noted
- [ ] Step 6 `.wslconfig` memory set, `free -h` shows it
- [ ] Step 7 `ps -p 1 -o comm=` → `systemd`
- [ ] Steps 9–10 Docker Engine + Compose installed, user in `docker` group
- [ ] Step 11 `docker run --rm hello-world` prints "Hello from Docker!" (no `sudo`)
- [ ] Step 13 Node `v24.22.0` in Ubuntu
- [ ] Step 14 `~/QE-Workspace` cloned, `npm ci` done
- [ ] Step 15 dev stack healthy, Keycloak opens at <http://localhost:8081> in Windows
- [ ] Step 16 `npm run test:integration` all green
