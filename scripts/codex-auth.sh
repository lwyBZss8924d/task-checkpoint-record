#!/bin/sh
# Official device authentication is explicit and keeps its output in the terminal.
set -eu
exec task-checkpoint-record auth "$@"
