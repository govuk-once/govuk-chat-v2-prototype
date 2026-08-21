#!/usr/bin/env bash

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The path must be absolute: dev-cdk-deploy.sh cds into cdk/ before deploying.
${PROJECT_DIR}/../../scripts/dev-cdk-deploy.sh ExampleAgentStack \
  --outputs-file "${PROJECT_DIR}/agentcore/cdk-outputs.json" \
  "$@"
