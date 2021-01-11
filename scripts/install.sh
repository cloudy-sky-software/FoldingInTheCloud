#!/bin/bash

echo "Launching FAH installation script..."

# Get the latest version info from https://foldingathome.org/start-folding/.
MAJOR_MINOR_VERSION=7.6
PATCH_VERSION=21
VERSION=${MAJOR_MINOR_VERSION}.${PATCH_VERSION}

install_fah_client() {
    wget "https://download.foldingathome.org/releases/public/release/fahclient/debian-stable-64bit/v${MAJOR_MINOR_VERSION}/fahclient_${VERSION}_amd64.deb" 2>/dev/null
    echo "Downloaded fahclient_${VERSION}_amd64.deb. Installing it..."
    sudo DEBIAN_FRONTEND=noninteractive dpkg -i --force-depends "fahclient_${VERSION}_amd64.deb"
    rm "fahclient_${VERSION}_amd64.deb"
    echo "Removed fahclient_${VERSION}_amd64.deb."
}

echo "Printing NVIDIA CUDA drivers version info..."
cat /proc/driver/nvidia/version || {
    echo "CUDA driver installation not yet complete. Exiting."
    exit 1
}

which >/dev/null 2>/dev/null FAHClient || {
    echo "FAHClient not detected. Installing..."
    install_fah_client
}

INSTALLED_VERSION=$(FAHClient --version)
if [ "${INSTALLED_VERSION}" = "${VERSION}" ]; then
    echo "FAHClient version is ${INSTALLED_VERSION}"
else
    "Installed version v${INSTALLED_VERSION} does not match expected version v${VERSION}. Will install the expected version..."
    install_fah_client
fi

# Stop the FAHClient service before overriding the config and then start it back up.
sudo /etc/init.d/FAHClient stop
sudo cp ~/config.xml /etc/fahclient/config.xml
sudo >/dev/null /etc/init.d/FAHClient start || {
    STATUS=$(sudo /etc/init.d/FAHClient status)
    if [ "${STATUS}" = "fahclient is not running" ]; then
        echo "${STATUS}"
        exit 1
    fi

    echo "Done."
    exit 0
}

IS_ACTIVE=$(systemctl is-active FAHClient)
if [ "${IS_ACTIVE}" = "active" ]; then
    echo "Done."
    exit 0
fi

exit 1
