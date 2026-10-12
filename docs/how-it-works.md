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

Two-way sync through the mirror was left out on purpose. Writing back means
merging CRDT text and matching change tags, which pyicloud already handles
for single records. `abridge rem add/done/rm` uses exactly that path.

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
