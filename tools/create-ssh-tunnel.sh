#!/bin/bash

INSTANCE=$1
# When using Ubuntu's multipass, the SSH key file can be found at this location. 
# SSH_KEY_FILE="/var/root/Library/Application Support/multipassd/ssh-keys/id_rsa"
SSH_KEY_FILE=rsa

. ./tools/common.sh

# Shutdown any existing tunnel.
shutdown_tunnel

# Pipe to /dev/null so that this lingering process doesn't keep stdout open.
(set -o xtrace; ssh \
    -f \
    -S "${SSH_CONTROL_SOCKET}" -M \
    -o 'StrictHostKeyChecking=no' \
    -o 'ExitOnForwardFailure=yes' \
    -o "IdentitiesOnly=yes" \
    -i "${SSH_KEY_FILE}" \
    -L "9000:127.0.0.1:9000" \
    -L "8084:127.0.0.1:8084" \
    "ubuntu@$INSTANCE" \
    "sleep $((60*60))" >/dev/null
) || {
    echo "---"
    echo "$(tput bold)$(tput setaf 1)Couldn't create SSH tunnel.$(tput sgr0)"
    echo "Something else might be listening on port 9000 or 8084."
    exit 1
}
