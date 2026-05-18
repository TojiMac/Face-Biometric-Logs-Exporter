# 🔐 Biometric Sync

A lightweight Node.js dashboard for extracting and exporting access logs from generic Chinese face recognition / biometric devices (Dahua-based firmware) that use the `CmdGeneral` API.

## The Problem

These devices push attendance data to a server in real-time via HTTP Reverse Register — but when the network goes down (e.g. power outages), logs are only stored on the device locally. There's no easy way to bulk-extract those missed records without manually downloading from the device's web UI one day at a time.

This tool solves that by:
- Connecting directly to the device API
- Fetching logs for any date range you choose
- Storing them locally per-device
- Exporting to CSV matching the device's own export format

---

## Features

- 📥 **Fetch from device** — pull logs for any date range directly from the biometric device
- 📊 **Export as CSV** — download logs in the same format as the device's built-in Backup export
- 🔍 **Filter & search** — filter logs by name, ID, access result, date, and mask detection
- 🖥️ **Multi-device support** — add, edit, switch between, and remove multiple devices
- 🗄️ **Per-device log files** — each device gets its own local log file
- 🗑️ **Clear logs** — wipe local logs per device without touching the device itself
- 🔒 **No hardcoded credentials** — device credentials stored in browser localStorage

---

## Requirements

- [Node.js](https://nodejs.org) v16 or higher
- Network access to the biometric device (same LAN or routed network)
- Device must use the `CmdGeneral` / `CmdLogin` API (Dahua-based firmware)

---

## Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/biometric-sync.git
cd biometric-sync

# Install dependencies
npm install

# Start the server
node server.js
```

Then open your browser at `http://localhost:3000`.

---

## Usage

### Adding a Device
1. Click **＋ Add Device** in the top right
2. Enter the device name, IP address, port (default: 80), username, and password
3. The app will test the connection before saving
4. The device is now available in the switcher dropdown

### Fetching Logs
1. Select the device from the dropdown
2. Under **Download from Device**, set your date range
3. Click **Fetch & Store** — this replaces the currently stored logs for that device

### Exporting as CSV
1. Under **Export as CSV**, set your date range
2. Click **Download CSV**
3. The file will be named `DeviceName_YYYY-MM-DD_to_YYYY-MM-DD.csv`

### Filtering Logs
Use the filter bar above the Access Logs table to search by:
- **Name** — partial match on employee name
- **ID** — employee/person code
- **Access** — Granted or Denied
- **Date** — specific day
- **Mask** — With Mask or Without Mask

---

## Project Structure

```
biometric-sync/
├── server.js           # Express server + device API client
├── package.json
├── public/
│   └── index.html      # Dashboard UI (single file)
└── logs/               # Per-device log files (gitignored)
    ├── device_XXX.jsonl
    └── state_XXX.json
```

---

## Device Compatibility

Tested on:
- **STD-5MA0721-E-JD05** (Software v1.404.04.21.T)

Should work on any device that uses:
- `POST /CmdLogin` with Digest auth (`auth-int` with firmware-hardcoded bodyHash)
- `POST /CmdGeneral` with `accessRecord.find` method

The firmware uses a non-standard Digest auth variant where the bodyHash in `authInfo` is a hardcoded constant (`98265b79323f2b0b270a70d48202b996`) rather than being computed from the request body.

---

## CSV Export Format

Matches the device's own Backup export exactly:

| Index | Timestamp | ID | Name | Access Granted | Body Temperature | Mask Detection | Details |
|-------|-----------|----|----|----------------|-----------------|----------------|---------|
| 1 | 5/6/2026, 8:28:51 AM | 831962 | Juan Dela | Yes | 36.6 | Without Mask | Access Success |

---

## Security Notes

- Device credentials are stored in **browser localStorage** — do not use on a shared/public computer
- The `logs/` directory is gitignored — log files containing employee data are never committed
- Keep the server on your local network only — do not expose port 3000 to the internet

---

## License

MIT
