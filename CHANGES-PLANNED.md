# Change log of agreed work

Nothing is outstanding. New requests go under **Queued** at the foot.

---

# Round 2 — built

## Average daily usage

- [x] Worked out from **submitted reports only** — never from an unsent draft
- [x] Each report carries its own period, so gaps and days off look after themselves
- [x] Skip any period where deliveries were not confirmed
- [x] Default window **14 days**, editable in Settings
- [x] Say **"not enough history yet"** rather than show a figure that cannot be trusted
- [x] Days left comes off the **average**, not a single day
- [x] Boiler table gains an **AVG/DAY** column
- [x] Chemical stock table reports the dose per m³

## Housekeeping

- [x] Archived reports keep the **numbers only** — no photos
- [x] Photos stay with the report on screen so it can be re-sent
- [x] Numbers kept 12 months, then pruned

## Wording

- [x] Boiler tanks always say **REFILL**, never REORDER
- [x] Ovine bag paperwork shows **NEED PRINTS** instead of FAULT
- [x] Any option can carry its own badge wording

---

# Round 3 — built

Everything here came out of the operator testing two reports by hand against
figures worked out separately. Each one was a real fault.

## Measuring the water

- [x] Water and dosing hours measured over the **same** period. They came from
      different ones, so a report could print 505.8 m³ beside "dosing was on
      0.0 hrs".
- [x] A report opens at the **last tank check**, not at the newest reading. A
      reading noted at 6pm used to open the next report at 6pm, and the water
      between the morning round and 6pm fell into no report at all.
- [x] A period can never run **backwards**. The last-check time is carried from
      the previous report, so re-making a report earlier the same day printed
      the readings in reverse, −400 m³, and "0.0 of those −11.5 hrs".
- [x] No negative water or hours, ever
- [x] A reading is found by **day**, not by exact minute, so editing the round
      time cannot strand it
- [x] A missing reading is **named**, instead of printing a block with holes
- [x] A dosing switch at the closing moment belongs to the **next** report
- [x] Re-saving a report no longer counts that day twice in the averages

## Keeping the data safe

- [x] One editable **meter reading list** — add, see and remove readings
- [x] Out-of-order readings refused, wherever they are entered from
- [x] **Put back the recorded readings and reports** in Settings. Submitting a
      report over a recorded date replaced the recorded figures, and there was
      no way back; the measured speed silently dropped from 15.0 to 12.9.
- [x] Warn before setting a report date inside **11 Sep – 2 Oct 2026**
- [x] Warn before saving a second report for a date that already has one
- [x] **Save / load a backup** file, merging two devices. Also the only backup
      there is.

## Reading the report

- [x] Water block as a **two-column table**
- [x] Every moment carries its **date and time**, so "7:30pm" is never ambiguous
- [x] The reading the dosed volume is measured from is printed
- [x] Dose figures said in plain words, not "1.45 L/m³ over 3196 m³"
- [x] **Where the water speed comes from** panel, listing the days that count
      and why the others do not
- [x] **Every dosing entry** listed in full
- [x] Round time carried from the last report, not taken from the clock

## Updates

- [x] Offline cache bypasses the browser's own cache, so a new upload is not
      ignored
- [x] **Check for an update** button that forces a waiting version to take over
- [x] Version shown by class, not id — a duplicate id left one copy reading
      "dev" while another showed the real build
- [x] Build check refuses a duplicate id

---

# Queued

_Nothing outstanding._
