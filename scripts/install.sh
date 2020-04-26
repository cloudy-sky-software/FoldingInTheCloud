#!/bin/bash

MAJOR_MINOR_VERSION=7.5
PATCH_VERSION=1
VERSION=${MAJOR_MINOR_VERSION}.${PATCH_VERSION}

echo "Launching FAH installation script..."

>/dev/null 2>/dev/null which FAHClient || {
    echo "FAHClient not detected. Installing..."

    wget "https://download.foldingathome.org/releases/public/release/fahclient/debian-stable-64bit/v${MAJOR_MINOR_VERSION}/fahclient_${VERSION}_amd64.deb" && \
        sudo DEBIAN_FRONTEND=noninteractive dpkg -i --force-depends "fahclient_${VERSION}_amd64.deb" 2>/dev/null && \
        rm "fahclient_${VERSION}_amd64.deb"
}

echo "Stopping FAHClient service..."
sudo /etc/init.d/FAHClient stop

echo "Sleeping for 30s..."
# Sleep for 30 seconds to let FAH complete stopping.
sleep 30

sudo cp ~/scripts/config.xml /etc/fahclient/config.xml

echo "Starting FAHClient service..."
sudo /etc/init.d/FAHClient start

echo "Done."
