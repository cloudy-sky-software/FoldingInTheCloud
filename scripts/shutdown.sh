#!/bin/bash

>/dev/null 2>/dev/null which FAHClient || {
    echo "FAHClient is not installed."
    exit 0
}

FAHClient --finish
