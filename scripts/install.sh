#!/bin/bash

echo "Launching FAH installation script..."

MAJOR_MINOR_VERSION=7.6
PATCH_VERSION=9
VERSION=${MAJOR_MINOR_VERSION}.${PATCH_VERSION}

install_fah_client() {
    wget "https://download.foldingathome.org/releases/public/release/fahclient/debian-stable-64bit/v${MAJOR_MINOR_VERSION}/fahclient_${VERSION}_amd64.deb"
    sudo DEBIAN_FRONTEND=noninteractive dpkg -i --force-depends "fahclient_${VERSION}_amd64.deb" 2>/dev/null
    rm "fahclient_${VERSION}_amd64.deb"
}

echo "Printing NVIDIA CUDA drivers version info..."
cat /proc/driver/nvidia/version

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

>/dev/null 2>/dev/null systemctl is-active --quiet FAHClient || {
    echo "Starting FAHClient service..."
    sudo /etc/init.d/FAHClient start || exit 1
}

echo "Done."
