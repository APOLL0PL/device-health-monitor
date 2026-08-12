# DHM Agent (Go)

Experimental rewrite of the DHM agent in Go. **Linux only.**

A single static binary with no runtime dependencies — metrics (CPU, RAM, disk,
temperature, uptime, network) are read directly from `/proc` and `/sys`.
No `npm install`, no Node.js needed on the target machine.

## Build

```
CGO_ENABLED=0 go build -ldflags "-s -w" -o dhm-agent .
```

Produces a ~6 MB statically linked ELF.

## Run

```
SERVER_URL=http://<server-IP>:4000 DEVICE_NAME=Laptop DEVICE_TYPE=laptop REGISTER_TOKEN=<token> ./dhm-agent
```

Env vars: `SERVER_URL`, `DEVICE_NAME`, `DEVICE_TYPE`, `REPORT_INTERVAL`
(seconds, default 60 / phone 300), `REGISTER_TOKEN`.

Flags: `-once` (single report, then exit), `-register-only` (register and exit).

The API key is saved to `.api_key` next to the binary (mode 600).
The agent re-registers automatically when the server rejects the key (401/403).

## vs the Node agent

Measured on the same server, 10 s interval, 60 s window:

|       | RSS    | CPU (1 core) | Size                  | Dependencies      |
|-------|--------|--------------|--------------------===|-------------------|
| Go    | ~10 MB | 0.07 %       | ~6 MB (1 file)        | none              |
| Node  | ~78 MB | 1.83 %       | 0.9 MB + node_modules | systeminformation |

~7x less RAM, ~26x less CPU.

## Status

Prototype. Linux only — Windows is not implemented (would need gopsutil
or a separate implementation).

Happy to hear if someone will use this on server/or smf.

anyways no one will read this probably
