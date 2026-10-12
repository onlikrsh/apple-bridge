# Pairing your iPhone with Arch

Between two Apple devices, "pairing" is invisible: both sign in to the same
Apple ID and everything else follows. With Linux it's a few separate
connections, each for a different job. `abridge pair` shows which ones you
have:

```text
$ abridge pair
  ✓ iCloud Calendar        abridge setup calendar
  ✓ iCloud Reminders       abridge setup reminders
  ✓ iCloud Notes           abridge setup notes
  ○ Clipboard              abridge pair clipboard  (then build 2 Shortcuts)
  ○ USB (photos, backups)  plug in, unlock, then: abridge pair usb
  ✓ LocalSend (files)      install LocalSend on both; same Wi-Fi
  ✓ Desktop apps           abridge apps install
```

| Connection | What it gives you | Needs |
|---|---|---|
| iCloud | Calendar, Contacts, Reminders, Notes, both ways, anywhere | your Apple ID (done in setup) |
| Clipboard | copy on one, paste on the other | same Wi-Fi, two Shortcuts |
| LocalSend | files and photos, fast, both ways | same Wi-Fi, the free app |
| USB | photo import, full backups, file browsing | a cable, tap Trust once |
| AirDrop | real AirDrop | a MediaTek MT7921/MT7922 Wi-Fi card (see the README) |

## 1. iCloud: the main one

This is what keeps Notes, Calendar, Contacts and Reminders the same on both
sides, and it works anywhere because it goes through Apple's servers.
`abridge setup calendar`, `setup reminders` and `setup notes` do it once,
and `abridge timer on` keeps everything in sync every 15 minutes. The
desktop apps also sync on their own while they're open.

On the iPhone: **Settings → [your name] → iCloud** → turn on Calendars,
Contacts, Reminders and Notes. Notes also needs **Advanced Data
Protection** off (or *Access iCloud Data on the Web* on).

## 2. Clipboard

Apple's Universal Clipboard works by letting the phone read and write the
clipboard silently in the background. iOS allows that only for Apple's own
software, so no Linux tool can copy it exactly. The closest you can get is
**one tap on the back of the phone**, using two Shortcuts that talk to a
small service on this computer.

1. On Arch, run:
   ```sh
   abridge pair clipboard
   ```
   It starts the service and prints a QR code.
2. Scan the QR code with the iPhone camera. Both devices need to be on
   the same Wi-Fi. A setup page opens with the address and your token,
   each with a Copy button.
3. In the **Shortcuts** app, build **Send to Arch**:
   *Get Clipboard* → *Get Contents of URL* (the address; Method **POST**;
   Header **Authorization** = the header from the page; Request Body
   **File** = *Clipboard*).
4. Build **Get from Arch**:
   *Get Contents of URL* (same address and header, Method **GET**) →
   *Copy to Clipboard*.
5. **Settings → Accessibility → Touch → Back Tap**: Double Tap = *Send to
   Arch*, Triple Tap = *Get from Arch*.

Now:
- **iPhone → Arch:** copy, double-tap the back of the phone, then paste on
  Arch. A notification confirms it arrived.
- **Arch → iPhone:** copy on Arch, triple-tap the phone, then paste.

Images work too. Turn on *Show in Share Sheet* for **Send to Arch** to send
a photo straight from the Photos share sheet.

**Notes:**
- **Keep the token private.** Anyone with it, on your network, can read
  your clipboard. `abridge clip reset` makes a new one; then pair again.
- **Only local-network clients are answered.** That includes home Wi-Fi
  and the iPhone hotspot.
- **If your router gives the laptop a new IP, the Shortcuts stop working.**
  Reserve its IP in the router, or install `avahi`
  (`sudo pacman -S avahi nss-mdns && sudo systemctl enable --now avahi-daemon`)
  and use `http://<hostname>.local:47100` in the Shortcuts instead.
- **With a firewall** (ufw, firewalld), allow TCP port 47100 from your local
  network. `abridge pair clipboard` prints the exact command.

## 3. LocalSend (files)

The quickest way to move files either way, at full Wi-Fi speed, and it
doesn't take your Wi-Fi card away the way AirDrop on Linux does.

- **Arch:** the installer adds it (AUR `localsend-bin` or Flathub).
- **iPhone:** install **LocalSend** from the App Store.
- **Use:** open it on both, on the same Wi-Fi. The other device appears;
  pick it and send. On the iPhone it's also in the share sheet.

## 4. USB

```sh
abridge pair usb                 # unlock the phone, tap "Trust", enter the passcode
abridge usb photos ~/Pictures/iPhone
abridge usb encrypt && abridge usb backup ~/iphone-backup
```

Pairing records live in `/var/lib/lockdown`. Removing one, or tapping
*Reset Location & Privacy* on the phone, undoes the pairing.

## 5. AirDrop

Real AirDrop needs particular Wi-Fi hardware: an Intel card (`iwlwifi`)
can't do it. `abridge airdrop check` tells you. On a MediaTek MT7921 or
MT7922, `abridge airdrop install` sets it up; see the README for what it
changes on your system.

## What can't be paired from Linux

| Apple feature | Why not | Closest here |
|---|---|---|
| Handoff | Apple-signed BLE advertisements and device identities | open the same note or event in the apps; it syncs |
| iMessage / SMS on the computer | needs Apple's servers and device keys | — |
| Phone calls through the computer | Continuity calls use the same private protocols | — |
| Universal Clipboard (automatic) | iOS gives background clipboard access only to Apple | one tap with Back Tap (above) |
| AirDrop "Contacts Only" | needs an Apple-signed identity | AirDrop *Everyone*, or LocalSend |
| Unlock with iPhone / Watch | Apple-only protocol | — |
