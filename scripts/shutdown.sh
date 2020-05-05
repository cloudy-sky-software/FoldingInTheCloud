#!/bin/bash

IS_ACTIVE=$(systemctl is-active FAHClient)
if [ "${IS_ACTIVE}" = "active" ]; then
    echo "Instructing FAHClient to finish all WUs, if any..."
    FAHClient --send-finish || exit 0

    echo "Stopping the FAHClient service..."
    sudo /etc/init.d/FAHClient stop || exit 0
fi
