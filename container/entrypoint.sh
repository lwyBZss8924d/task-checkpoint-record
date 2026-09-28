#!/bin/sh
set -eu
umask 077
# Startup does not initialize a database, authenticate or start a model/worker.
case "${1:---help}" in
  codex)
    shift
    exec /opt/codex-runtime/bin/codex "$@"
    ;;
  *) exec /opt/task-checkpoint-record/bin/task-checkpoint-record "$@" ;;
esac
