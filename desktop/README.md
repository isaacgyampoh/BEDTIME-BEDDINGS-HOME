# BEDTIME POS — desktop app

Electron shell around the existing POS. Same UI, same Supabase data; what it
adds is the machine access a browser cannot have on a till.

## Why this exists

The built-in thermal head on these terminals is **not installed as a Windows
printer**. A browser can only print to printers Windows exposes, which is why
the print dialog offered nothing but OneNote, Fax and Save as PDF. This app
writes ESC/POS bytes straight to the printer's COM port — no driver, no print
queue, no dialog.

It also gives you real kiosk mode, launch-on-boot, native second-monitor
placement for the customer screen, and an app shell that opens with no internet.

## Build the Windows installer

Must be run **on Windows** (or Windows CI). A `.exe` cannot be produced from
macOS without Wine.

```bash
git clone <this repo> && cd BEDTIME-BEDDINGS-HOME
npm install
npm run desktop:win
```

Output: `desktop/release/BEDTIME-POS-Setup-1.0.0.exe`

`npm run desktop:win` builds the web app first, then packages it — the UI is
bundled into the installer, so the till does not need the internet to start.

### GitHub Actions alternative

```yaml
runs-on: windows-latest
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: 20 }
  - run: npm install
  - run: npm run desktop:win
  - uses: actions/upload-artifact@v4
    with: { name: installer, path: desktop/release/*.exe }
```

## Run it locally

```bash
npm run desktop        # build the UI, then launch the shell
npm run desktop:dev    # point the shell at the Vite dev server on :3000
```

## Printer setup on the terminal

Install, launch, then **menu → Receipt Printer**. Under *This terminal* it lists
the serial ports it can see, with the most printer-like marked **BEST MATCH**.
It uses that automatically; tap another to override. Then **Print test page**.

If the digits on the test page wrap or get cut off, switch the paper width
between 80mm and 58mm on the same screen.

The app only auto-selects a port it recognises (a printer, or a USB-serial
bridge such as CH340/PL2303/FTDI/CP210x). If nothing is recognisable it asks
rather than guessing, so receipt bytes are never written into an unrelated
device.

## Architecture

```
main.js      windows, kiosk, serial + silent printing, displays, settings
preload.js   contextBridge — the ONLY surface the UI can reach
../dist      the built web app, bundled as a resource
```

`contextIsolation` is on and `nodeIntegration` is off. The renderer has no
`require`, no `process` and no `module`; it reaches the machine only through the
explicitly listed channels in `preload.js`.

The web build detects the shell via `window.posDesktop` and degrades to its
existing browser behaviour when absent, so the same build still runs on
admin.bedtimehome.com unchanged.
