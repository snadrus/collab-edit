#!/bin/sh
# Deploy FilRegistry. Calibration runs when PRIVATE_KEY is set. Mainnet is refused.
set -eu
cd "$(dirname "$0")"
net="${1:-calibration}"
if [ "$net" = "mainnet" ]; then
  echo "Refusing to deploy FilRegistry to Filecoin mainnet." >&2
  exit 1
fi
if [ "$net" != "calibration" ]; then
  echo "Usage: ./deploy.sh [calibration]" >&2
  exit 1
fi
if [ -z "${PRIVATE_KEY:-}" ]; then
  echo "PRIVATE_KEY is not set. Skipping the Calibration deploy." >&2
  exit 0
fi
forge script script/DeployCalibration.s.sol --rpc-url calibration --broadcast --private-key "$PRIVATE_KEY"
