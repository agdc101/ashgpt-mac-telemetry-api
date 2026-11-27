# AshGPT macOS telemetry API

This read-only Bun and Hono service runs alongside Ollama on your Mac. It listens only on `127.0.0.1` and defaults to port `3001`. AshGPT can reach it from its Railway server through the existing Cloudflare Tunnel and Cloudflare Access service policy.

## Local setup

Install [Bun](https://bun.sh/) on the Mac, then run these commands from the repository:

```sh
bun install --frozen-lockfile
bun run start
```

To change the defaults, copy `.env.example` to `.env` and edit it. Bun loads `.env` from the project directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port. The bind address is always `127.0.0.1`. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | HTTP(S) origin for Ollama. The service calls `GET /api/ps`. |

Use `bun run dev` for hot reload, `bun run typecheck` for strict TypeScript checking, and `bun run test` for the automated tests.

## API

### `GET /health`

Returns HTTP 200 with the API status, process uptime in seconds, package version, and UTC timestamp. This endpoint works independently of Ollama and system metric collection.

```json
{
  "status": "ok",
  "uptimeSeconds": 12.5,
  "version": "0.1.0",
  "timestamp": "2026-01-01T12:00:00.000Z"
}
```

### `GET /telemetry`

Returns HTTP 200 with the latest snapshot. The server reuses each result for five seconds after collection and shares one collection across concurrent requests. The UTC timestamp records when that collection finished. Unavailable measurements are `null`. Ollama timeout, failure, or invalid responses yield `"reachable": false` and an empty model list while system metrics remain available.

```json
{
  "system": {
    "os": "macOS",
    "version": "26.1",
    "hardwareModel": "Mac16,1",
    "cpuModel": "Apple M4",
    "cpuCores": 10,
    "uptimeSeconds": 3600
  },
  "cpu": {
    "utilisationPercent": 15.2,
    "loadAverage": [1.22, 1.08, 0.96]
  },
  "memory": {
    "totalBytes": 17179869184,
    "usedBytes": 8589934592,
    "availableBytes": 8589934592,
    "utilisationPercent": 50
  },
  "battery": {
    "percent": 87,
    "isCharging": false,
    "acConnected": true,
    "cycleCount": 42
  },
  "storage": {
    "totalBytes": 494384795648,
    "usedBytes": 200000000000,
    "availableBytes": 294384795648,
    "utilisationPercent": 40.45
  },
  "ollama": {
    "reachable": true,
    "models": [
      {
        "name": "qwen2.5:7b",
        "parameterSize": "7.6B",
        "quantisationLevel": "Q4_K_M",
        "sizeBytes": 4860000000,
        "vramBytes": 4860000000
      }
    ]
  },
  "timestamp": "2026-01-01T12:00:00.000Z"
}
```

- CPU utilisation is the sampled percentage across cores. Load averages are for 1, 5, and 15 minutes. The core count is physical cores.
- macOS used memory estimates resident anonymous, wired, and compressed memory after subtracting purgeable pages. Available memory is the remainder of physical RAM, including reclaimable file-backed memory.
- Primary storage measures the macOS Data volume where present or the root filesystem otherwise. Used capacity is total capacity minus the bytes available to the invoking user.
- Ollama reports model size as `sizeBytes` and accelerator allocation as `vramBytes`. Those values describe the model and do not measure total Ollama process memory. Use public names and tags for your Ollama models. The API strips registry and namespace prefixes and discards names that fail its format check.

Unknown routes return HTTP 404 with `{"error":{"code":"NOT_FOUND","message":"Route not found"}}`. Unexpected errors return HTTP 500 with `{"error":{"code":"INTERNAL_ERROR","message":"Unable to complete the request"}}`. The Hono app type is available as the `AppType` export from `src/index.ts` for future RPC clients.

## Cloudflare Tunnel

Add a dedicated public hostname to your existing tunnel. For a dashboard-managed tunnel, set the hostname's service to **HTTP** and its origin to `127.0.0.1:3001`. For a locally managed tunnel, add this rule to the existing ingress list before the catch-all rule:

```yaml
- hostname: telemetry.example.com
  service: http://127.0.0.1:3001
```

Use your configured API port if it differs from `3001`. Protect the telemetry hostname with the existing Cloudflare Access service authentication policy and allow AshGPT's service token. From the Railway server, send `CF-Access-Client-Id` and `CF-Access-Client-Secret` as request headers. Keep those values in Railway's server-side variables.

## macOS background service

The [LaunchAgent template](launchd/com.ashgpt.mac-telemetry.plist) runs Bun directly as your signed-in user. It starts at login, restarts after exit with a ten-second throttle, and writes separate stdout and stderr logs.

1. Install the dependencies and stop any foreground copy of the API.
2. Prepare the local directories and copy the template:

   ```sh
   mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/AshGPTTelemetry"
   cp launchd/com.ashgpt.mac-telemetry.plist "$HOME/Library/LaunchAgents/"
   ```

3. Edit the copied plist. Replace the Bun path with the absolute path from `command -v bun`, replace both repository paths with your checkout paths, and set both log paths to absolute paths under the log directory you created. The paths in the plist must use literal absolute paths because launchd does not expand `~` or `$HOME`.
4. Validate and load it from your signed-in user's Terminal:

   ```sh
   plist="$HOME/Library/LaunchAgents/com.ashgpt.mac-telemetry.plist"
   plutil -lint "$plist"
   launchctl bootstrap "gui/$(id -u)" "$plist"
   curl --fail http://127.0.0.1:3001/health
   ```

| Task | Command |
| --- | --- |
| Status | `launchctl print "gui/$(id -u)/com.ashgpt.mac-telemetry"` |
| Restart | `launchctl kickstart -k "gui/$(id -u)/com.ashgpt.mac-telemetry"` |
| Follow logs | `tail -f "$HOME/Library/Logs/AshGPTTelemetry/stdout.log" "$HOME/Library/Logs/AshGPTTelemetry/stderr.log"` |
| Unload | `launchctl bootout "gui/$(id -u)/com.ashgpt.mac-telemetry"` |

After unloading, delete `~/Library/LaunchAgents/com.ashgpt.mac-telemetry.plist` to remove the service. If you edit the plist after installation, unload it and bootstrap the edited file to apply the changes.
