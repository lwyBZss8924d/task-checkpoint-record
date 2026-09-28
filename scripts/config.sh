#!/bin/sh
# Installed CLI front door. Never source an environment file or evaluate arguments.
set -eu
exec task-checkpoint-record config "$@"
