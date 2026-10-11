# Putting the app on your phone

You only do this **once**. After that the app is just an icon on your home screen.

Everything you need is in the **`dist`** folder. That is 5 files:

```
index.html
manifest.webmanifest
sw.js
icon-192.png
icon-512.png
```

> **Tip:** this setup is fiddly on a phone screen. If you have a computer handy,
> do steps 1-4 there instead — it takes about five minutes. Then just open the
> link on your phone for step 5. The app itself is built for the phone; only the
> one-time setup is easier on a computer.

---

## Step 1 — Download the 5 files

In the file explorer (the icon at the top right of this page), open the
**`ops-report-app`** folder, then the **`dist`** folder.

Download all 5 files. They will go into your **Downloads**.

---

## Step 2 — Get a GitHub account

Skip this if you already have one.

1. Go to **github.com**
2. Tap **Sign up**
3. Enter your email, pick a password and a username
4. Confirm the code they email you

It is free. You will never need to pay.

---

## Step 3 — Make a place for the app

1. Go to **github.com/new**
2. **Repository name:** type `ops-report`
3. Leave everything else alone, but make sure **Public** is selected
   *(Private will not work with free hosting)*
4. Tap **Create repository**

---

## Step 4 — Upload the files and switch hosting on

**Upload:**

1. On the page you just landed on, tap **uploading an existing file**
   (it is in the line of text near the top)
2. Tap **choose your files**
3. Select **all 5 files** from your Downloads
4. Scroll down and tap **Commit changes**

**Switch hosting on:**

5. Tap **Settings** (top of the page — you may need the **⋯** menu on a phone)
6. In the left-hand list, tap **Pages**
7. Under **Branch**, change **None** to **main**
8. Tap **Save**

Now wait about **2 minutes**. GitHub is building your site.

---

## Step 5 — Open it and add it to your home screen

Your address is:

```
https://YOUR-USERNAME.github.io/ops-report/
```

Replace `YOUR-USERNAME` with the username you chose in step 2.

1. Open that address in **Chrome** on your phone
2. Tap the **⋮** menu (top right)
3. Tap **Add to Home screen**
4. Tap **Install** or **Add**

Done. There is now an **Ops Report** icon on your home screen.

---

## Step 6 — Set it up for your plant (2 minutes, important)

Open the app and tap the **gear icon** at the top right.

1. **Site name** — type your plant's name. It appears on the PDF header.
2. **Trigger levels** — these decide when something gets flagged.

My starting numbers are only sensible guesses. **The pH one matters most** — I
have it set to flag a fault at 6.0 or below. Please check that against your trade
waste licence, because that is the one with real consequences if it is wrong.

Your name is already set to **ARSLAN** and the date is always today, so there is
nothing to fill in there.

---

## Using it each morning

1. Tap the icon
2. Walk the plant and fill it in — it saves as you go, so you can lock your
   phone between checks
3. Tap **📷 Add photo** on anything you want to show
4. Tap **Save & make PDF**
5. Android's share menu opens — pick **WhatsApp**, then pick Leighton or Hafiz

If your bosses prefer text instead of a PDF, tap **WhatsApp text** instead and
copy the two ready-made messages.

It works with **no signal**. Nothing is sent anywhere except the PDF you choose
to share.

---

## Starting a fresh report

**The next day it clears itself.** Open the app and it is already blank, with
your name, site and trigger levels kept.

To clear it sooner — say you made a mess, or you want to do a second one the
same day — tap the **gear icon** and then **Start a new report**. It asks you to
confirm first, and reports you have already saved are never touched.

---

## Chemical levels and IBCs

Each chemical has three boxes:

| Box | What to put in it |
|---|---|
| **In use** | Level in the tank being used right now |
| **Backup** | Level in the backup drum |
| **New IBCs** | How many fresh IBCs arrived today. Leave blank if none. |

The app works out how much was used since your last report, and it accounts for
any IBCs that arrived, so a delivery never looks like negative usage. One IBC is
counted as **1000 L**.

It then shows **how many days of stock are left** at that rate, and flags the
chemical when it is getting close — 7 days is a warning, 3 days is a fault. Both
of those numbers are editable in the gear menu.

If stock goes **up** and you did not record an IBC, the report says so rather
than hiding it, so a missed delivery entry is easy to spot.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| "404" when opening the address | Wait another 2 minutes, then reload. GitHub is still building. |
| Address shows a list of files | The upload put the files inside a folder. Re-upload them so they sit at the top level. |
| No "Add to Home screen" option | You are not in Chrome. Open the address in Chrome. |
| Red "Autosave is not working" banner | You opened a downloaded file instead of the web address. Use the `https://...` link. |
| Photos sideways | Pick the photo from your gallery rather than taking it inside the app. |

---

---

# Updating to a new version

Whenever I change something, do this. It takes about a minute.

Only **2 files** ever change: `index.html` and `sw.js`.

## Step 1 — Download the 2 new files

File explorer → `ops-report-app` → `dist` → download **`index.html`** and **`sw.js`**.

## Step 2 — Upload them over the old ones

1. Go to your repository: `github.com/YOUR-USERNAME/ops-report`
2. Tap **Add file** → **Upload files**
3. Select both files
4. Tap **Commit changes**

GitHub replaces the old versions automatically. It does not ask you to confirm —
same filename means same file.

Wait about **1 minute**.

## Step 3 — Restart the app on your phone

Close the app **completely** (swipe it away from your recent apps), then open it
again.

## Step 4 — Check it worked

Tap the **gear icon** and scroll to the bottom. Under **About** there is a
**Version** number.

If that number matches the one I give you with the update, you have the new
version. If it has not changed, close the app fully and reopen it once more.

> **Why the restart matters:** the app stores a copy of itself on your phone so
> it works with no signal. That copy is only swapped for the new one when the
> app starts fresh. This is also why `sw.js` must be uploaded along with
> `index.html` — it is the file that tells your phone a new version exists.

### If it still shows the old version

In Chrome: **⋮** → **History** → **Clear browsing data** → tick **Cached images
and files** → **Clear**. Then open the app again.

Your saved reports are **not** stored in the cache, so this will not delete
anything you have filled in.

---

## Changing the checklist

Tell me what to add or remove and I will send you a new version, then follow the
update steps above.
