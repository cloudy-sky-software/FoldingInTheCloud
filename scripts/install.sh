#!/bin/bash

echo "Launching FAH installation script..."

MAJOR_MINOR_VERSION=7.6
PATCH_VERSION=9
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

>/dev/null 2>/dev/null which FAHClient || {
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

sudo cp ~/config.xml /etc/fahclient/config.xml

sudo /etc/init.d/FAHClient restart || exit 1

IS_ACTIVE=$(systemctl is-active FAHClient)
if [ "${IS_ACTIVE}" = "active" ]; then
    echo "Done."
    exit 0
fi

exit 1
