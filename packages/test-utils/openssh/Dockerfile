# Disposable OpenSSH target for integration tests (Phase 08). Development fixture only.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache openssh-server \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh qe \
 # adduser -D locks the account ("!"), and sshd refuses locked accounts even for keys: "*" = no password, not locked.
 && sed -i 's/^qe:!/qe:*/' /etc/shadow \
 && install -d -m 700 -o qe -g qe /home/qe/.ssh \
 # sshd keeps the FIRST value of each keyword and Alpine's config already sets AuthorizedKeysFile, so ours go on top.
 && { printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
      'AllowTcpForwarding no' 'X11Forwarding no' 'AllowAgentForwarding no' 'AuthorizedKeysFile /etc/ssh/authorized_keys/%u'; \
      cat /etc/ssh/sshd_config; } > /tmp/sshd_config \
 && mv /tmp/sshd_config /etc/ssh/sshd_config \
 && sshd -T | grep -qx 'authorizedkeysfile /etc/ssh/authorized_keys/%u' \
 && install -d -m 755 /etc/ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
