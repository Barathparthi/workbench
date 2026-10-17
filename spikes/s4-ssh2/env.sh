#!/usr/bin/env bash
# Spike S4 test environment (Linux, run as root; throwaway):
#   OpenSSH target  127.0.0.1:2222  (key + Vault-CA certificates, forwarding OFF)
#   OpenSSH bastion 127.0.0.1:2223  (may forward ONLY to 127.0.0.1:2222)
#   Vault dev       127.0.0.1:8200  (SSH secrets engine as user CA, ed25519)
# Usage: ./env.sh up | down | certs     Needs: openssh-server, openssh-client, vault (VAULT=/path/to/vault)
# All keys are generated fresh under $ENV_DIR and never leave it. The env dir must be root-owned and not
# group/world-writable (sshd StrictModes), hence /srv rather than /tmp.
set -euo pipefail

ENV_DIR=${ENV_DIR:-/srv/qe-s4}
VAULT=${VAULT:-vault}
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=s4-dev-root

down() {
  for p in target bastion vault; do
    if [ -f "$ENV_DIR/run/$p.pid" ]; then kill "$(cat "$ENV_DIR/run/$p.pid")" 2>/dev/null || true; rm -f "$ENV_DIR/run/$p.pid"; fi
  done
  echo "S4 environment stopped"
}

write_sshd_config() { # name port forwarding-lines...
  local name=$1 port=$2; shift 2
  cat > "$ENV_DIR/$name.sshd_config" <<CFG
Port $port
ListenAddress 127.0.0.1
HostKey $ENV_DIR/keys/${name}_host_ed25519
PidFile $ENV_DIR/run/$name.pid
AuthorizedKeysFile $ENV_DIR/authorized_keys/%u
TrustedUserCAKeys $ENV_DIR/keys/vault_user_ca.pub
AllowUsers qeuser
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
LogLevel VERBOSE
Subsystem sftp internal-sftp
$(printf '%s\n' "$@")
CFG
}

# (Re-)issue the test certificates from the Vault CA; they are short-lived on purpose.
certs() {
  sign() { # out principal ttl
    "$VAULT" write -field=signed_key ssh-client-signer/sign/qe-user \
      public_key=@"$ENV_DIR/client/ephemeral_ed25519.pub" valid_principals="$2" ttl="$3" >"$ENV_DIR/client/$1"
  }
  sign ephemeral_ed25519-cert.pub qeuser 15m
  sign wrong-principal-cert.pub otheruser 15m
  sign short-lived-cert.pub qeuser 5s
}

up() {
  install -d -m 755 "$ENV_DIR" "$ENV_DIR/keys" "$ENV_DIR/client" "$ENV_DIR/authorized_keys" "$ENV_DIR/run" "$ENV_DIR/log"
  install -d -m 755 /run/sshd
  id -u qeuser >/dev/null 2>&1 || useradd -m -s /bin/bash qeuser
  usermod -p '*' qeuser # no password, but not "locked" (sshd refuses locked accounts when UsePAM=no)

  for h in target bastion; do
    [ -f "$ENV_DIR/keys/${h}_host_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "qe-s4-$h" -f "$ENV_DIR/keys/${h}_host_ed25519"
  done
  for k in user ephemeral; do
    [ -f "$ENV_DIR/client/${k}_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "qe-s4-$k" -f "$ENV_DIR/client/${k}_ed25519"
  done
  # Only the long-lived user key is authorized directly; the ephemeral key is trusted via the CA only.
  install -m 644 "$ENV_DIR/client/user_ed25519.pub" "$ENV_DIR/authorized_keys/qeuser"

  "$VAULT" server -dev -dev-root-token-id="$VAULT_TOKEN" -dev-listen-address=127.0.0.1:8200 >"$ENV_DIR/log/vault.log" 2>&1 &
  echo $! >"$ENV_DIR/run/vault.pid"
  for _ in $(seq 1 50); do "$VAULT" status >/dev/null 2>&1 && break; sleep 0.2; done
  "$VAULT" secrets enable -path=ssh-client-signer ssh >/dev/null
  "$VAULT" write -format=json ssh-client-signer/config/ca generate_signing_key=true key_type=ed25519 >/dev/null
  "$VAULT" read -field=public_key ssh-client-signer/config/ca >"$ENV_DIR/keys/vault_user_ca.pub"
  cat >"$ENV_DIR/run/role.json" <<'ROLE'
{ "key_type": "ca", "allow_user_certificates": true, "allowed_users": "qeuser,otheruser",
  "default_user": "qeuser", "allowed_extensions": "permit-pty", "default_extensions": { "permit-pty": "" },
  "ttl": "15m", "max_ttl": "15m" }
ROLE
  "$VAULT" write ssh-client-signer/roles/qe-user @"$ENV_DIR/run/role.json" >/dev/null
  certs

  write_sshd_config target 2222 "AllowTcpForwarding no"
  write_sshd_config bastion 2223 "AllowTcpForwarding local" "PermitOpen 127.0.0.1:2222"
  for s in target bastion; do
    /usr/sbin/sshd -t -f "$ENV_DIR/$s.sshd_config"
    /usr/sbin/sshd -f "$ENV_DIR/$s.sshd_config" -E "$ENV_DIR/log/$s.log"
  done
  echo "S4 environment up in $ENV_DIR (target :2222, bastion :2223, vault :8200)"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  certs) certs && echo "certificates re-issued" ;;
  *) echo "usage: $0 up|down|certs" >&2; exit 2 ;;
esac
