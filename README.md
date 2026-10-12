# apple-bridge

Make an iPhone and iCloud work with Arch Linux the way they work with a Mac:
**Notes, Calendar and Reminders apps** that look and behave like the macOS
ones and stay in sync with your iPhone, plus Contacts, a one-tap clipboard,
file transfer, AirDrop and USB, behind one command, `abridge`.

| Notes | Calendar | Reminders |
|---|---|---|
| ![Notes](docs/screenshots/notes-light.png) | ![Calendar](docs/screenshots/calendar-week-light.png) | ![Reminders](docs/screenshots/reminders-today-light.png) |
| ![Notes, dark](docs/screenshots/notes-dark.png) | ![Calendar, month](docs/screenshots/calendar-month-light.png) | ![Reminders, details](docs/screenshots/reminders-info-dark.png) |

Apple publishes no Linux API for most of this. apple-bridge doesn't add more
reverse engineering. It wires together the open-source projects that already
did that work and are maintained today (October 2026), pins versions known to
work together, and covers the parts they leave to you: setup, storing
passwords, a sync timer, git safety nets for Notes and a VTODO mirror for
Reminders. [docs/how-it-works.md](docs/how-it-works.md) explains each
protocol.

## What works

| | How | Direction | You need |
|---|---|---|---|
| **Calendar** | iCloud CalDAV ([vdirsyncer], [khal]) | two-way | an app-specific password |
| **Contacts** | iCloud CardDAV ([vdirsyncer], [khard]) | two-way | the same password |
| **Reminders** | private CloudKit API ([pyicloud]) | read and write with `abridge rem`; read-only mirror for [todoman] | Apple ID password + 2FA; the session lasts about 2 months |
| **Notes** | private CloudKit API ([icloud-md]) | two-way, as Markdown files in git | a browser sign-in; Advanced Data Protection **off** |
| **AirDrop** | AWDL via [OWL] + patched [OpenDrop] ([airdrop-mt7921]) | both ways, ~40–67 kB/s | a MediaTek MT7921/MT7922 Wi-Fi card; AirDrop set to *Everyone* |
| **Fast file transfer** | [LocalSend] (open protocol, same Wi-Fi) | both ways, full speed | the free LocalSend app on the iPhone |
| **USB** | [libimobiledevice], [ifuse] | photos and videos to Linux, backups, file browsing | a cable; tap *Trust* once |
| **Desktop apps** | Electron, macOS-style UI over the above | Notes, Calendar, Reminders: read, write, sync | `pacman -S electron` |
| **Clipboard** | `abridge clip` + two iPhone Shortcuts | both ways, text and images, one tap (Back Tap) | same Wi-Fi |

What is **not** possible today, and why:

- **AirDrop "Contacts Only"**: the phone checks an identity record signed by
  Apple, and nobody outside Apple can produce one. *Everyone for 10 Minutes*
  works.
- **AirDrop on most laptops**: Intel and most Realtek cards can't do the
  monitor-mode frame injection that AWDL needs. Use LocalSend, or add an
  Atheros AR9271 USB adapter.
- **Notes with Advanced Data Protection on**: the note bodies are then
  end-to-end encrypted. Use `abridge usb backup` and an offline parser
  instead (see the docs).
- **Note attachments**: they download, but edits to notes that contain them
  are refused rather than risk corrupting the note.
- **Creating Reminders lists**: Apple's web API has no call for it. Create
  them on the phone.
- **Automatic Universal Clipboard, Handoff, iMessage, calls**: iOS reserves
  these for Apple's own devices.
  [docs/pairing.md](docs/pairing.md#what-cant-be-paired-from-linux) lists
  what comes closest.

## The apps

Three separate apps, one codebase (`apps/`), in your app menu as **Notes**,
**Calendar** and **Reminders**. They follow your desktop's light or dark
theme.

- **Notes**: folders, the date-grouped list (Today, Previous 7 Days, …) and a
  rich-text editor with Title/Heading/Subheading/Body/Monostyled, lists,
  round checklists, tables, block quotes and links. Edits save as you type
  and reach the iPhone a few seconds later. Drag notes onto folders; search
  covers note text. Notes with attachments are view-only, because icloud-md
  can't write them back safely.
- **Calendar**: Day, Week, Month and Year views, a mini month, calendar
  colours and visibility, and the event inspector (title, location,
  all-day, times, repeat, alert, calendar, notes, URL). Double-click or
  drag to create; drag to move; drag the bottom edge to resize. Repeating
  events ask before changing the series, and can drop a single date.
- **Reminders**: Today / Scheduled / All / Flagged / Completed and your
  lists, circle checkboxes, priorities, flags, overdue dates in red,
  subtasks, inline add, and the (i) details popover.

The look is rebuilt from macOS's published metrics and colours. Apple's own
assets are not copied: Apple licenses SF Pro, SF Symbols and its app icons
for Apple platforms only. The apps use **Inter**, the open font closest to
SF Pro (and SF Pro itself if you've installed it), **Lucide** icons, and
original app icons.

Keyboard shortcuts are the Mac ones with Ctrl for ⌘: Ctrl+N new,
Ctrl+F search, Ctrl+R sync, Ctrl+W close, Ctrl+1–4 for Calendar views,
Ctrl+T today, and in Notes Ctrl+Shift+T/H/J/B/M for paragraph styles and
Ctrl+Shift+L for a checklist.

## Install

```sh
git clone https://github.com/onlikrsh/apple-bridge.git ~/src/apple-bridge
cd ~/src/apple-bridge
./install.sh            # or: ./install.sh --only calendar,reminders
```

It installs, with `pacman --needed`: vdirsyncer, khal, khard, todoman, nodejs,
npm, chromium, libimobiledevice, usbmuxd, ifuse, rsync, libheif, libsecret,
electron and inter-font (the apps), and wl-clipboard, xclip, qrencode and
libnotify (the clipboard). The apps are prebuilt in `apps/dist`, so they need
no npm install.
pyicloud goes into its own venv and icloud-md into its own npm prefix, both
under `~/.local/share/apple-bridge`, so nothing touches the system Python or
global npm. It links `~/.local/bin/abridge`. LocalSend comes from the AUR
(`paru`/`yay`) or Flathub if you have either.

Run `./install.sh` again after every `git pull`.

## Set up (once)

On the iPhone first:

1. **Settings → [your name] → iCloud**: turn on Calendars, Contacts,
   Reminders and Notes.
2. Same screen, **Advanced Data Protection**: must be **off** for Notes (or
   at least turn on *Access iCloud Data on the Web*).
3. Create an **app-specific password** at <https://account.apple.com> →
   Sign-In and Security → App-Specific Passwords. Calendar and Contacts use it.

Then on Arch:

```sh
abridge init                 # your Apple ID and the folder for notes (~/Notes)
abridge setup calendar       # asks for the app-specific password; --no-contacts to skip contacts
abridge setup reminders      # Apple ID password + the 6-digit code from your phone
abridge setup notes          # a browser window opens on icloud.com: sign in there
abridge timer on             # sync every 15 minutes in the background
abridge pair                 # what's paired; then: abridge pair clipboard, abridge pair usb
abridge doctor               # check everything
```

Then open **Notes**, **Calendar** and **Reminders** from your app menu
(`abridge apps install` adds them if the installer didn't). Pairing the
clipboard, USB and the rest is in [docs/pairing.md](docs/pairing.md).

Reminders and Notes keep **separate** sessions. pyicloud signs in with SRP and
2FA; icloud-md uses a real browser. When either expires, `abridge doctor`
says so and names the command to run.

## Use it

The apps are the everyday way. Everything is also available from the
terminal:

```sh
abridge app notes                     # or calendar, reminders (same as the app menu)
abridge pair clipboard                # scan the QR code with the iPhone, build two Shortcuts
abridge sync                          # everything, now (or: abridge sync calendar)
abridge cal                           # next 7 days
abridge cal list 2026-10-15 30d       # any khal command
abridge cal printcalendars           # your iCloud calendar names
abridge cal new -a Home 2026-10-20 10:00 11:00 Dentist   # on the iPhone after the next sync
abridge contacts                      # any khard command, e.g. `abridge contacts show Ada`

abridge rem ls                        # open reminders, by list
abridge rem ls shop -a                # one list (name or prefix), including completed
abridge rem add Shopping "Oat milk" -d tomorrow -p high
abridge rem add Work "Standup" -d "2026-10-21 09:30" -n "room 4"
abridge rem done ab12                 # the short id from `rem ls`
abridge todo                          # the same reminders in todoman (read-only)

abridge notes pull                    # iCloud -> ~/Notes, committed to git
$EDITOR ~/Notes/"Grocery list.md"
abridge notes status                  # what a push would do
abridge notes push                    # ~/Notes -> iCloud

abridge airdrop check                 # can this Wi-Fi card do it?
abridge airdrop install               # once; asks before adding a sudo rule
abridge airdrop receive               # phone: share sheet -> this laptop
abridge airdrop send --to "iPhone" photo.jpg

abridge usb pair                      # once, phone unlocked
abridge usb photos ~/Pictures/iPhone  # only new files are copied
abridge usb encrypt && abridge usb backup ~/iphone-backup
```

For everyday file transfer, use LocalSend: open it on both devices, on the
same Wi-Fi, and pick the other device. It's much faster than AirDrop on Linux,
and your Wi-Fi stays connected.

## Be careful with

- **Notes and Reminders go through private, undocumented Apple APIs.** They
  have worked for years and both upstream projects are active, but Apple can
  change them at any time. Versions are pinned in `lib/common.sh`; upgrade on
  purpose.
- **`abridge notes push` writes to your live notes.** Every pull and push is
  wrapped in git commits in `~/Notes`, so `git log` / `git revert` undo
  anything, and `icloud-md history` / `revert` can restore a note on the
  server. Try a push on a throwaway note first.
- **Reminders needs your real Apple ID password**, because CloudKit rejects
  app-specific passwords. When pyicloud asks "Save password in keyring?",
  answer **n** unless gnome-keyring or KeePassXC is running. Without one,
  Python's keyring can fall back to a plain-text file.
- **The reminders mirror is one-way.** The next sync overwrites edits made in
  todoman. Change reminders with `abridge rem`.
- **AirDrop takes your Wi-Fi card** for the transfer (you're offline for a
  minute), and its installer adds `/etc/sudoers.d/zz-airdrop` after asking.
  Read [its security notes][airdrop-mt7921] first.

## Where things live

| | |
|---|---|
| `~/.config/apple-bridge/config` | Apple ID, notes folder (`abridge init`) |
| `~/.config/apple-bridge/*.conf` | generated vdirsyncer, khal, khard, todoman configs |
| keyring, or `~/.config/apple-bridge/app-password` (0600) | the app-specific password |
| `~/.local/state/apple-bridge/pyicloud/` | Reminders session (pyicloud's default, `/tmp`, is wiped at every reboot on Arch) |
| `~/.config/icloud-md/accounts/` | Notes session |
| `~/.local/share/apple-bridge/{calendars,contacts,reminders}/` | synced data, as vdirs of .ics/.vcf |
| `~/Notes/` | your notes, as Markdown in a git repo |
| `~/.local/share/apple-bridge/{venv,node,src}/` | pyicloud, icloud-md, airdrop-mt7921 |
| `~/.config/apple-bridge-{notes,calendar,reminders}/` | the apps' window state and caches |
| `~/.config/apple-bridge/clip.json` (0600) | the clipboard token and port |

## Troubleshooting

- **First step is always `abridge doctor`.**
- **Background sync logs**: `journalctl --user -u abridge-sync -e`
- **vdirsyncer says 401 Unauthorized**: the app-specific password was revoked
  or mistyped. Run `abridge secret set`.
- **Reminders: "not signed in"**: the ~2-month session expired. Run
  `abridge setup reminders`.
- **Notes: "sign-in has expired"**: run `abridge notes reauthenticate`.
- **Notes sign-in browser won't start**: install `chromium` (abridge uses
  `/usr/bin/chromium` when it exists) or run `abridge notes install-browser`.
- **`abridge usb …` finds no phone**: unlock it, replug, tap *Trust*, then
  `abridge usb pair`. Check `systemctl status usbmuxd`.
- **HEIC photos don't open**: install `libheif` (installed with the usb part),
  or set the phone's Camera → Formats → *Most Compatible*.
- **An app won't open**: run it from a terminal to see why, e.g.
  `abridge app notes`. Is `electron` installed?
- **Clipboard: "no graphical session"**: start it from your desktop session
  once with `abridge clip on`. That passes your display to the service.
- **Clipboard Shortcut fails**: same Wi-Fi? Firewall open on TCP 47100? Did
  the laptop's IP change? (See [docs/pairing.md](docs/pairing.md#2-clipboard).)
- **AirDrop finds nothing**: for receiving, keep the phone's share sheet
  **open**. For sending, keep it **closed** and the phone unlocked. AirDrop
  must be on *Everyone for 10 Minutes*, which switches itself off.

## Development

```sh
python -m pytest tests/                   # unit + end-to-end tests, no Apple account needed
shellcheck install.sh bin/abridge lib/common.sh

cd apps
npm ci                                    # dev only: Electron, esbuild, TipTap, ical.js, Lucide
node build.mjs --minify                   # rebuild apps/dist (committed)
node --test test/*.test.js                # backends; with DISPLAY set also drives the real apps
node test/screenshots.js /tmp/shots       # the screenshots above, from a demo account
```

The app tests run Electron through Playwright against a generated demo
account (`apps/test/make-fixture.js`), with a fake `abridge`. They check
that opening a note never rewrites it, that every demo note round-trips
byte for byte, and that edits, new events, drags and ticks produce exactly
the expected file changes and `abridge rem` calls.

`tests/test_cli.py` runs `bin/abridge` in a throwaway `$HOME` against a fake
pyicloud. With the real vdirsyncer, khal, khard and todoman available (on
`PATH`, or in a venv named by `ABRIDGE_TEST_TOOLS`), it also checks that they
accept the generated configs. vdirsyncer even fetches the password through
`abridge secret get`.

## Credits

All the hard work is upstream:
[pyicloud] (timlaing), [icloud-md] (coddingtonbear),
[OWL] and [OpenDrop] (SEEMOO lab, TU Darmstadt),
[Electron], [TipTap] and [tiptap-markdown], [ical.js], [Lucide] icons, the [Inter] font,
[airdrop-mt7921] (jedbillyb), [vdirsyncer], [khal], [khard] and [todoman]
(pimutils), [libimobiledevice], [LocalSend].

[pyicloud]: https://github.com/timlaing/pyicloud
[icloud-md]: https://github.com/coddingtonbear/icloud-md
[OWL]: https://github.com/seemoo-lab/owl
[OpenDrop]: https://github.com/seemoo-lab/opendrop
[airdrop-mt7921]: https://github.com/jedbillyb/airdrop-mt7921
[vdirsyncer]: https://github.com/pimutils/vdirsyncer
[khal]: https://github.com/pimutils/khal
[khard]: https://github.com/lucc/khard
[todoman]: https://github.com/pimutils/todoman
[libimobiledevice]: https://libimobiledevice.org
[ifuse]: https://github.com/libimobiledevice/ifuse
[LocalSend]: https://localsend.org
[Electron]: https://www.electronjs.org
[TipTap]: https://tiptap.dev
[tiptap-markdown]: https://github.com/aguingand/tiptap-markdown
[ical.js]: https://github.com/kewisch/ical.js
[Lucide]: https://lucide.dev
[Inter]: https://rsms.me/inter/
