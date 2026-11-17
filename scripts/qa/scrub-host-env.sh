# Sourced, never run. Strips the host's electron-vite dev env the QA rig would otherwise inherit.
# A Frink Dev agent shell carries the launcher env electron-vite set for the OPERATOR's dev app:
# ELECTRON_RENDERER_URL makes the QA main process load the host's dev server instead of out-qa/renderer,
# and an inherited NODE_ENV=development makes `electron-vite build` emit a dev bundle. Both are silent.
# The names below are exactly what electron-vite assigns (node_modules/electron-vite/dist), not every
# ELECTRON_*: operator download settings (ELECTRON_MIRROR, cache dirs) must still reach
# ensure-electron-binary.mjs. Vite-prefixed keys go wholesale; callers re-read the worktree's .env after.
# Platform-independent on purpose (env.sh exits on non-Darwin), so build.sh and the tests can source it.
qa_scrub_host_dev_env() {
  local v
  for v in $(compgen -e); do
    case "$v" in
      ELECTRON_RENDERER_URL | ELECTRON_RUN_AS_NODE | ELECTRON_EXEC_PATH | ELECTRON_CLI_ARGS | \
        ELECTRON_ENTRY | ELECTRON_MAJOR_VER | NODE_ENV | NODE_ENV_ELECTRON_VITE | NO_SANDBOX | \
        REMOTE_DEBUGGING_PORT | VITE_* | MAIN_VITE_* | RENDERER_VITE_* | PRELOAD_VITE_*)
        unset "$v"
        ;;
    esac
  done
}
