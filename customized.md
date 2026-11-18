# Local customization

## UI and binary workflow

- Keep the existing backend on port `4096` running. For UI work, run `bun dev -- --host 0.0.0.0 --port 4097` from `packages/app` and open `http://localhost:4097`.
- Do not restart the backend or rebuild the binary during UI iteration.
- When UI work is complete, build the standalone binary with:

  ```bash
  PATH=/usr/local/bin:$PATH \
  OPENCODE_CHANNEL=latest \
  OPENCODE_VERSION=2.0.26 \
  bun run --cwd packages/cli build --single --target=opencode-linux-x64 --skip-install
  ```

- Use Bun `1.4.2`. The artifact is `packages/cli/dist/cli-linux-x64/bin/opencode`; do not restart the systemd service without an explicit request.
