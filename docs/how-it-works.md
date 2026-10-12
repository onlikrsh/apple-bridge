# How it works

What each piece of apple-bridge talks to, and why it is built the way it is.
Most of this was reverse-engineered by the upstream projects named in each
section; this page collects what they found, checked against their source as
of October 2026.

## Calendar and Contacts: plain CalDAV and CardDAV

The only parts with a public, documented protocol.

| | Endpoint | Auth |
|---|---|---|
| Calendar | `https://caldav.icloud.com/` | Apple ID + app-specific password (HTTP Basic) |
| Contacts | `https://contacts.icloud.com/` | the same |

vdirsyncer discovers each calendar and address book from those roots and
mirrors them into vdirs: one `.ics` or `.vcf` per item, plus `displayname`
and `color` files per collection. khal and khard read those folders.
Changes either side are synced both ways. `conflict_resolution = "b wins"`
means the iPhone's copy wins when both sides changed the same item.

The calendar storage is limited to `item_types = ["VEVENT"]` because of
Reminders (next section).

vdirsyncer won't sync a calendar whose every event is gone from one side
("was completely emptied"), so a wiped folder can't wipe iCloud. That also
stopped the last event of a calendar from ever being deleted. The Calendar
app now lists each event it removes in the calendar folder's
`.abridge-removed`, and `abridge sync` lets the deletion through when every
event vdirsyncer last saw there is on that list (`--force-delete` for that
calendar only). Any other emptying is reported by name with both ways out:
`abridge sync calendar --delete-emptied NAME` or `--restore NAME`.

## Reminders: CloudKit, not CalDAV

Until iOS 13, reminders were VTODOs on the same CalDAV server. The "upgraded"
Reminders app ([HT210220]) moved them into a CloudKit database. The upgrade
can't be undone. What is left on CalDAV is a stub list holding two items
titled *"Where are my reminders?"*. Every CalDAV-based Linux task app hits
this wall.

CloudKit's web service is what icloud.com's Reminders page uses:

```
POST https://p<NN>-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private/records/query
                                                      container           environment  database  operation
```

- **Container** `com.apple.reminders`, private database, custom zone
  **`Reminders`**.
- **Operations**: `records/query` (with `continuationMarker` paging),
  `records/lookup`, `records/modify`, and `changes/zone` with a `syncToken`
  for incremental sync.
- **Auth**: a session from Apple's web sign-in (`idmsa.apple.com`, SRP-6a and
  then 2FA). pyicloud implements that flow. The session cookies
  (`X-APPLE-WEBAUTH-TOKEN` among them) are kept in its session directory and
  last about two months. App-specific passwords are rejected here.

The record fields pyicloud maps (from `services/reminders/_mappers.py`):

| Field | Meaning |
|---|---|
| `TitleDocument`, `NotesDocument` | text, as a CRDT: base64 → zlib (or gzip) → `versioned_document.Document` protobuf, whose versions hold a `topotext.String` (text plus per-character ids and vector clocks, the same structure Notes uses) |
| `DueDate`, `StartDate`, `CompletionDate` | milliseconds since the epoch |
| `AllDay` | 1 = the date is literal: stored as **00:00 UTC** on that date, with no time zone |
| `TimeZone` | IANA name, set only on timed reminders |
| `Priority` | 0 none, 1 high, 5 medium, 9 low. These are the iCalendar `PRIORITY` values too, so they copy across unchanged |
| `Completed`, `Flagged`, `Deleted` | flags (`Deleted` = in Recently Deleted) |
| `List`, `ParentReminder` | references; subtasks are reminders with a parent |
| `Color` (on lists) | JSON such as `{"ckSymbolicColorName":"blue","daHexString":"#1BADF8"}` |
| `AlarmIDs`, `HashtagIDs`, `AttachmentIDs`, `RecurrenceRuleIDs` | links to separate records |

`libexec/abridge-reminders` uses pyicloud's Python API rather than its CLI
for one reason: in the CLI, `--limit` both truncates the result and sets
CloudKit's page size, so a full listing needs a huge page size. The library
pages through 200 records at a time.

The **mirror** writes one VTODO per reminder into
`~/.local/share/apple-bridge/reminders/<list-id>/<reminder-id>.ics`. All-day
dates become `DUE;VALUE=DATE:…` (never shifted by your time zone). Timed ones
become UTC. Subtasks become `RELATED-TO;RELTYPE=PARENT`. The list name and
*Flagged* become `CATEGORIES`. Files are only rewritten when their content
changes. The mirror deletes only folders that carry its `.abridge-mirror`
marker.

Both the mirror and the list of lists follow `changes/zone` sync tokens
rather than fetching everything each time. Fetching everything is slow:
pyicloud's `lists()` replays the zone's whole change history, one ~1.4 s
request per mostly empty page (about 20 pages for 700 reminders), and a full
mirror downloads every completed reminder again (7 MB for 700). The lists
and their token are cached in `~/.local/state/apple-bridge/reminders-lists.json`,
so every `abridge rem` command starts with one small request. The mirror
keeps its token in `reminders/.abridge-sync.json` and applies only the
reminders that changed. A list that is new or renamed is copied whole,
because every file names its list. Both fetch everything again when
iCloud rejects the token, and once a day in case a token ever misses
something.

Two-way sync through the mirror was left out on purpose. `abridge rem`
writes one record at a time instead, the way Apple's own clients do.
pyicloud's `update()` and `delete()` don't, and the iPhone noticed:

- **Only the fields that changed** are sent, with the record's change tag,
  so a reminder edited elsewhere in the meantime is refused (`CONFLICT`)
  rather than overwritten. pyicloud rewrites every field, and adds an
  empty `NotesDocument` to reminders that have none.
- **`ResolutionTokenMap`** holds one `{counter, modificationTime,
  replicaID}` entry per field; Apple's clients use it to decide which
  change to a field is newest. A write advances the entries of the fields
  it changes (counter + 1, a fresh random `replicaID` as in Apple's own
  records) and keeps the rest. pyicloud replaces the map with counter 1
  for the fields it writes, so to a phone that had counted 238 completions
  of a repeating reminder the change looked older than its own.
- **Titles and notes** are topotext CRDT documents, the same format as a
  note's body. pyicloud writes a brand-new document every time, under one
  fixed replica id with clocks restarting at 0, so a second edit reuses
  character ids the phone already has for other text. abridge edits the
  existing document with icloud-md's editor
  (`libexec/abridge-topotext.mjs`), under a replica id of its own kept in
  `~/.local/state/apple-bridge/reminders-replica`. All 732 title and notes
  documents of a real account round-trip through it byte for byte.
- **Repeating reminders** can't be completed from Linux: the phone
  completes one occurrence and moves the reminder to its next date, which
  needs its recurrence rules. Setting `Completed` would end the series.
- New reminders still go through pyicloud's `create()`, whose record
  matches the iPhone's own first save (every counter 1, a fresh title
  document).

## Notes: CloudKit again, as Markdown

Container `com.apple.notes`, zone **`Notes`**, the same `ckdatabasews`
service and the same operations as Reminders.

- **Content** is in `TitleEncrypted` and `TextDataEncrypted`. Despite the
  names, without Advanced Data Protection these come back readable. They
  are compressed (gzip/zlib), not end-to-end encrypted. Decompressed, they
  are the same protobuf note format that iOS keeps in `NoteStore.sqlite`. With
  ADP on, they *are* end-to-end encrypted and no web client can read them.
- **Auth**: icloud-md doesn't reimplement Apple's login. It opens a real
  browser on icloud.com (Playwright), lets you sign in, and keeps the
  resulting cookies under `~/.config/icloud-md/accounts/<dsid>/`. Its
  author's reasoning: Apple's current web sign-in uses a device-attested 2FA
  step that is hard to replay from plain HTTP. That is also why Notes and
  Reminders have separate sessions here.
- **Writes** go through `records/modify`, guarded by each record's change
  tag. A note that changed on the phone since your last pull is reported as a
  conflict, not overwritten. Notes with attachments are kept read-only.

abridge wraps every `pull` and `push` in git commits, and checks
`verify-auth` before a background pull. Otherwise an expired session would
try to open a sign-in window that no one can see.

**Paragraph styles have to be uniform.** Note text carries one attribute run
per stretch of characters, and Apple's text system takes a paragraph's style
from its first character. icloud-md 0.6.2 reads it from the paragraph's
newline, and text a push inserts at a paragraph boundary inherits the
neighbouring paragraph's run. So typing at the start of a checklist item, or
retyping a line next to a table, could upload a paragraph whose characters
say Body with one checklist id while its newline says Checklist with another.
icloud-md's verification accepted it, and Notes on the iPhone hung on it.
`share/patches/icloud-md-0.6.2.patch`, applied by `install.sh`, makes the
reconciler rewrite such paragraphs uniformly and makes `push` refuse any that
remain. `abridge notes push` refuses to run without it. Apple's own notes
do mix an explicit `0` with an unset field, which reads as the same value, so
the check compares effective values.

**Offline fallback (ADP on, or no web access):** an iPhone backup over USB
(`abridge usb encrypt`, then `abridge usb backup DIR`) contains
`NoteStore.sqlite`, the Calendar database and the Reminders stores. Tools
such as [apple_cloud_notes_parser] can read notes from a backup. Encrypted
backups have to be decrypted first.

## AirDrop: BLE + AWDL + HTTPS

AirDrop is three layers, documented by the SEEMOO lab's papers and their
[OpenDrop]/[OWL] implementations:

1. **Bluetooth LE**: a sender advertises Apple manufacturer data (AirDrop
   type) carrying short hashes of its contact identifiers. That wakes nearby
   receivers' Wi-Fi.
2. **AWDL** (Apple Wireless Direct Link): Apple's own peer-to-peer Wi-Fi.
   Devices synchronise availability windows with vendor action frames and hop
   between a social channel (6, 44 or 149) and their infrastructure channel.
   OWL implements it on Linux. It needs a card that can inject frames in
   monitor mode *while* acknowledging them. That is why only some chips
   work.
3. **DNS-SD + HTTPS over AWDL**: the receiver announces `_airdrop._tcp`. The
   sender then makes three HTTPS requests: `POST /Discover` (who are you),
   `POST /Ask` (file names, types, thumbnail; the receiver shows the prompt),
   and `POST /Upload` (a cpio archive, gzip-compressed, or Apple's
   `x-dvzip`).

What stock OpenDrop (last released 2021) gets wrong with iOS 26, per
airdrop-mt7921's patch notes:
- `/Discover` and `/Ask` bodies arrive **chunked**, with no
  `Content-Length`, which crashed the handler before it could reply.
- Photos arrive as **`application/x-dvzip`**, not `x-cpio`: a run of
  length-prefixed blocks (4-byte big-endian header, bit 31 = stored, otherwise
  a zlib stream of up to 128 KiB) that wraps an ODC cpio archive.
- When sending, `/Ask` must declare a **`TransferID`** and `/Upload` must
  repeat it, or the phone rejects the upload before reading the body.
- **mDNS has to be repeated.** A single radio is on the peer's AWDL channel
  for only part of each ~1 s sequence, so one multicast query or
  announcement is usually lost. zeroconf's exponential back-off (1, 2, 4,
  8 s…) left the phone unanswered. The patches re-ask every 1.5 s and
  re-announce every 5 s.
- Received items come wrapped in `NSIRD_AirDrop_*` folders with AppleDouble
  `._` files, which airdrop-mt7921 flattens into your Downloads.

**Contacts Only** requires the sender to present a *validation record*,
signed by Apple and tied to an Apple ID. It can't be produced off Apple
hardware. **Everyone** mode accepts unsigned peers both ways, so that is
what works. Since iOS 16.2, *Everyone* turns itself off after 10 minutes.

Context: Google shipped AirDrop interoperability on Pixel 10 phones in
November 2025 (Everyone mode only, not open source). The EU's Digital Markets
Act is pushing Apple toward Wi-Fi Aware for peer-to-peer. Either could change
how long AWDL-based tools keep working. LocalSend doesn't depend on any of it.

## USB: usbmuxd, lockdown, AFC, backups

- **usbmuxd** multiplexes TCP connections over the USB cable. On Arch, a
  udev rule starts it when an iPhone is plugged in.
- **lockdownd pairing**: `idevicepair pair` makes the phone ask *Trust this
  computer?*. Pairing records are stored in `/var/lib/lockdown`.
- **AFC** (Apple File Conduit) exposes the media partition: `DCIM/` holds
  photos and videos. `ifuse` mounts it with FUSE, and `abridge usb photos`
  rsyncs only new files out of it.
- **mobilebackup2** (`idevicebackup2`) makes the same full backup Finder or
  iTunes would. Turn encryption on (`abridge usb encrypt`) to include
  Health data, saved passwords and Wi-Fi networks.

[HT210220]: https://support.apple.com/HT210220
[OpenDrop]: https://github.com/seemoo-lab/opendrop
[OWL]: https://github.com/seemoo-lab/owl
[apple_cloud_notes_parser]: https://github.com/threeplanetssoftware/apple_cloud_notes_parser

## The desktop apps

`apps/` is one Electron codebase started as three apps (`--app=notes|calendar|reminders`),
each with its own window state and single-instance lock. Pages run sandboxed
with context isolation. Everything that touches files or iCloud is in the
main process and goes through `abridge`, so the apps, the terminal and the
sync timer share the same sessions, and one lock per service (`flock`)
keeps their syncs from overlapping.

- **Notes** reads and writes the icloud-md vault directly. The editor
  (TipTap) only offers formatting icloud-md can map back to Apple Notes, and
  the frontmatter that carries each note's identity is split off and
  re-attached byte for byte with icloud-md's own rules. icloud-md's
  Markdown has one line per Apple paragraph (an empty line is an empty
  paragraph, consecutive lines are separate paragraphs), which CommonMark
  would merge, so notes cross into the editor and back through
  `ui/notes/lines.js`. A save then changes only the lines that were edited
  (`ui/notes/merge.js`): the editor's own way of writing tables, spacing
  and escapes never reaches the file, provided the merged text reads back
  exactly as the editor shows it. A note is written only when it really
  changed, and a write is refused if a pull changed the file in the
  meantime. Edits are pushed 4 seconds after you stop typing.
- **Calendar** reads and writes vdirsyncer's `.ics` files with ical.js,
  then runs `abridge sync calendar`. Edits keep every property they don't
  show (attendees, Apple's `X-` properties), keep an event's time zone when
  moving it, and bump `SEQUENCE`. Removing or moving an event out of a
  calendar is noted in `.abridge-removed` (see Calendar and Contacts above).
- **Reminders** calls `abridge rem dump/add/edit/done/rm`, one at a time.

## The clipboard bridge

`libexec/abridge-clipd` is a small HTTP service (stdlib Python, TCP 47100)
run as a systemd user service:

| Request | Does |
|---|---|
| `POST /clipboard` (body = text or `image/*`) | sets this computer's clipboard (`wl-copy` / `xclip`) and shows a notification |
| `GET /clipboard` | returns this computer's clipboard: text, or an image when that's all there is |
| `GET /ping` | checks the token |
| `GET /pair?code=NNNNNN` | the setup page; the code comes from `abridge clip pair` and lasts 10 minutes |

Requests need `Authorization: Bearer <token>`, except `/pair`, which needs
its code. The service answers only private, loopback and link-local
addresses. The iPhone side is plain Shortcuts (*Get Clipboard* + *Get
Contents of URL*, and the reverse), so no app has to be installed. Back Tap
makes each one a single gesture.
