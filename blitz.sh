#!/bin/bash
# BlitzProxy — universal entry point (Mac/Linux)
# All commands route to cli.js. No arguments = start proxy + launch Claude Code.
node "$(dirname "$0")/cli.js" "$@"
