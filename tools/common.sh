#!/bin/bash

SSH_CONTROL_SOCKET=~/.spinnaker_halyard_tunnel
shutdown_tunnel() {
    if [ -e "${SSH_CONTROL_SOCKET}" ]; then
        # The control socket may exist but not be connected to anything (for
        # example if ssh was killed manually, or you rebooted your machine). If it
        # is connected, we'll ask the SSH client to exit (which will clean up the
        # control socket file). Otherwise, we'll just blow away the existing
        # control socket file.
        if ssh -S "${SSH_CONTROL_SOCKET}" -O check ignoredhostvalue 2>/dev/null; then
            ssh -S "${SSH_CONTROL_SOCKET}" -O exit ignoredhostvalue
        else
            rm -f "${SSH_CONTROL_SOCKET}"
        fi
    fi
}
