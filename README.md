# Daily Operations Report

A morning checklist app for the rendering plant. Tap through the checks, type the
readings, attach photos, and it produces a professional PDF plus the two
WhatsApp messages for Leighton and Hafiz.

Works with no signal. Nothing is uploaded anywhere — all data stays on the phone.

---

## What it does

| | |
|---|---|
| **Checklist** | All 40 checks, grouped exactly as the current report. Tap OK / Monitor / Fault / Not done. |
| **Readings** | Type the number; the app decides the status from your trigger levels. |
| **Photos** | Camera or gallery, any number per check. Auto-shrunk so the PDF stays small. |
| **Auto flagging** | pH out of range, chemicals running low, samples falling behind — flagged without you thinking about it. |
| **Action summary** | Faults and warnings collected at the top of the report, per manager. |
| **Trends** | Each reading is compared with your last saved report (`-500 vs last`). |
| **PDF** | A4, page numbers, coloured status pills, photo appendix. |
| **WhatsApp** | Two ready-to-paste messages, one per manager. |
| **Autosave** | Everything is saved as you type. Closing the app loses nothing. |

---

## Two ways to use it

### 1. As a phone app, no APK needed (fastest)

The `www/` folder is a complete installable web app.

1. Put `www/` on any web host with HTTPS. GitHub Pages is free:
   repository **Settings → Pages → Deploy from a branch**, then point it at the folder.
2. Open the address in Chrome on your phone.
3. Menu **⋮ → Add to Home screen**.

It now behaves like an installed app: own icon, no browser bars, works offline,
and **Save & make PDF** opens the normal Android share sheet so you can send
straight to WhatsApp.

This is the easiest path and the easiest to update — change a file, and the phone
picks it up next time it has signal.

### 2. As a real APK

The sandbox this was built in has no Android SDK and no internet, so the APK has
to be compiled by GitHub Actions.

1. Push this repository to GitHub.
2. Open the **Actions** tab. The **Build APK** workflow runs automatically.
3. When it finishes, open the run and download the **OpsReport-apk** artifact.
4. Unzip it, copy the `.apk` to your phone, and tap it.
   Android will ask you to allow installing from that source — that is normal for
   an app that does not come from the Play Store.

To get a permanent download link instead, create a **Release** in GitHub and the
workflow attaches the APK to it.

---

## Setting your trigger levels

This is the one thing worth doing before you rely on it. Tap the **gear icon**.

Every limit is editable, and the defaults are only sensible guesses:

| Setting | Default fault | Default monitor |
|---|---|---|
| pH | at/below 6.0, at/above 9.0 | at/below 6.5, at/above 8.5 |
| Chemical in-use tank | 200 L | 500 L |
| Chemical backup drum | 100 L | 400 L |
| Boiler chemical | 50 L | 100 L |
| Saturator pressure | below 350 / above 800 kPa | below 450 / above 700 kPa |
| Flow rate | below 5 / above 40 m³/h | below 10 / above 30 m³/h |
| Biofilter humidity | below 30 / above 85 %RH | below 40 / above 75 %RH |
| Sample lag | 15 days | 8 days |

**Check the pH numbers against the site's trade waste licence.** That one has
real compliance consequences and the default is a guess.

Tapping a status button always overrides the automatic one — so a broken gauge
can be reported as a fault with no reading entered.

---

## Repository layout

```
www/                     the app itself (this is the whole product)
  index.html
  styles.css
  config.js              the checklist and the trigger levels
  report.js              PDF layout + WhatsApp text
  pdf.js                 PDF writer, written from scratch, no libraries
  app.js                 screen, photos, storage
  sw.js                  offline cache
android/                 thin WebView wrapper that turns it into an APK
  app/src/main/java/.../MainActivity.kt
tools/                   build and test scripts
  make_icons.py          draws the launcher icons
  make_test_jpeg.py      writes a real baseline JPEG for testing
  build_test_pdf.js      renders a sample report
  verify_pdf.py          checks the PDF structure is valid
  smoke_test.js          33 logic tests
.github/workflows/       CI that builds the APK
```

There are **no dependencies**. No npm install, no libraries. The PDF writer is
about 300 lines of plain JavaScript that emits PDF bytes directly, which is why
the app works with no internet and will not break when some package updates.

---

## Running the tests

```sh
node tools/smoke_test.js

python3 tools/make_test_jpeg.py 640 480 /tmp/a.jpg
node tools/build_test_pdf.js /tmp/report.pdf /tmp/a.jpg
python3 tools/verify_pdf.py /tmp/report.pdf /tmp/a.jpg
```

`verify_pdf.py` checks the things a PDF reader would reject: cross-reference
offsets, stream lengths, page tree consistency, and that embedded photos survive
byte-for-byte.

---

## Changing the checklist

Everything lives in `www/config.js`, in the `CHECKLIST` array. To add a check,
add one line to the right group:

```js
{ id: 'new_check', label: 'What it is called', type: 'status' }
```

`type` is one of `status`, `number`, `pair` (in use / backup) or `date`.
The form, the PDF and the WhatsApp text all update automatically — there is
nothing else to edit.
