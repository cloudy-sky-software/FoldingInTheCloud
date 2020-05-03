#!/bin/bash

IS_ACTIVE=$(systemctl is-active FAHClient)
if [ "${IS_ACTIVE}" = "active" ]; then
    echo "Stopping the FAHClient service..."
    sudo /etc/init.d/FAHClient stop
fi

echo "Instructing FAHClient to finish all WUs, if any..."
FAHClient --finish || exit 0
