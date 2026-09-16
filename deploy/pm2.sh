#!/bin/sh
GPU_MONITOR_ROOT="$HOME/.local/share/gpu-monitor"
export PM2_HOME="$GPU_MONITOR_ROOT/pm2"
if [ -x "$GPU_MONITOR_ROOT/node/bin/node" ]; then
    export PATH="$GPU_MONITOR_ROOT/node/bin:$PATH"
fi
exec node "$GPU_MONITOR_ROOT/runtime/node_modules/pm2/bin/pm2" "$@"
