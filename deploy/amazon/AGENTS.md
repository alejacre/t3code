# Amazon Tunnel Deployment

This directory packages the web client and server for an Amazon development desktop.

- Build with `T3CODE_INTERNAL_ONLY=1`; never copy `.env` files into the image.
- Bind the application only to `127.0.0.1:3773`.
- Keep runtime state outside `~/.t3/userdata`.
- Do not use T3 Connect, Clerk, PostHog, OTLP, provider update checks, hosted model manifests,
  provider feedback uploads, or hosted T3 origins.
- Do not put pairing credentials in arguments passed to tunnel, PID files, public URL files, or logs.
- Create Amazon Tunnels without `--allow`; that leaves access owner-only.
- Do not use `--rewrite-localhost`, `--https`, `VITE_HTTP_URL`, or `VITE_WS_URL`.
- Stop only PIDs recorded at spawn and verified against their Linux process start time.
