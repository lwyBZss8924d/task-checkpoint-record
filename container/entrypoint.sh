#!/bin/sh
set -eu
umask 077
unset BUN_OPTIONS NODE_OPTIONS PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONINSPECT PYTHONUSERBASE PYTHONBREAKPOINT
export PYTHONDONTWRITEBYTECODE=1
# Startup does not authenticate or admit a task. The codex branch verifies the
# baked qualified package; service updates use their separate writable owner root.
case "${1:---help}" in
  codex)
    shift
    exec python3 -I -B /opt/task-checkpoint-record/container/image-ci.py seed-exec -- "$@"
    ;;
  *) exec /opt/task-checkpoint-record/bin/task-checkpoint-record "$@" ;;
esac
