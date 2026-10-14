/* ------------------------------------------------------------------
   App shell: renders the checklist, captures photos, autosaves to
   IndexedDB, and hands the finished report to the PDF writer.
   ------------------------------------------------------------------ */

/* ---------------- storage ---------------- */

const DB_NAME = 'opsreport';
const DB_VER = 1;
const STORE = 'reports';
const DRAFT_ID = 'draft';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    // A lookup that finds nothing still hands back a request object, whose
    // result is undefined. Testing the property rather than its value is what
    // makes "was this record already there?" answerable.
    tx.oncomplete = () => resolve(
      out && typeof out === 'object' && 'result' in out ? out.result : out);
    tx.onerror = () => reject(tx.error);
  });
}

const store = {
  put: (rec) => dbTx('readwrite', s => s.put(rec)),
  putMany: (recs) => dbTx('readwrite', s => { recs.forEach(r => s.put(r)); }),
  get: (id) => dbTx('readonly', s => s.get(id)),
  del: (id) => dbTx('readwrite', s => s.delete(id)),
  all: () => dbTx('readonly', s => s.getAll())
};

/* ---------------- state ---------------- */

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let state = blankState();
let saveTimer = null;
let meterSaveTimer = null;
/* The service worker registration, kept so Settings can ask for an update on
   demand rather than leaving it to chance. */
let swReg = null;
let swReloading = false;
/* The most recent saved report before today's, used for chemical usage. */
let previousReport = null;
/* Submitted reports, newest last. Feeds the average usage figures. */
let submittedReports = [];
/* DAF start/stop events. Shared by every report, so adding a past event
   corrects the figures for earlier days too. */
let dosingEvents = [];
/* DAF water meter readings, { at, value }. Shared the same way, and the figure
   every dose calculation is read from, so correcting a reading here corrects
   every day it ever affected. */
let meterReadings = [];

function blankState() {
  return {
    id: DRAFT_ID,
    date: todayISO(),
    reporter: DEFAULT_REPORTER,
    site: DEFAULT_SITE,
    reportPrefix: DEFAULT_PREFIX,
    avgWindowDays: DEFAULT_AVG_WINDOW,
    /* The time of the morning round, not the time the app happened to be
       opened. Using the clock meant that calling in at 7:30pm to log a dosing
       switch retitled the whole report as a 7:30pm round, which moved the
       period every figure is measured over. The round time barely changes, so
       it is carried from one report to the next instead. */
    readingTime: DEFAULT_READING_TIME,
    lastReadingTime: DEFAULT_READING_TIME,
    meter: '',
    prevMeter: null,
    logo: null,
    lastCheckDate: null,
    generalNote: '',
    values: defaultValues(),
    photos: {},
    thresholds: deepCopy(DEFAULT_THRESHOLDS),
    thVersion: THRESHOLD_VERSION,
    /* False while the trigger levels are still the ones the app shipped with,
       which is what lets a new build replace them. The moment the operator
       edits one, the whole set becomes theirs and is never overwritten. */
    thEdited: false
  };
}

/* Everything that should survive from one report to the next. */
function carriedSettings() {
  return {
    reporter: state.reporter,
    site: state.site,
    reportPrefix: state.reportPrefix || DEFAULT_PREFIX,
    avgWindowDays: state.avgWindowDays || DEFAULT_AVG_WINDOW,
    logo: state.logo,
    thresholds: mergeThresholds(state.thresholds),
    thVersion: state.thVersion,
    thEdited: state.thEdited === true
  };
}

function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

function valueOf(itemId) {
  if (!state.values[itemId]) state.values[itemId] = { photos: [] };
  if (!state.values[itemId].photos) state.values[itemId].photos = [];
  return state.values[itemId];
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.put({ ...state, id: DRAFT_ID, savedAt: Date.now() }).catch(err => {
      console.error('autosave failed', err);
      toast('Could not autosave - storage may be full');
    });
  }, 400);
}

/* The meter log is edited a digit at a time while typing, so the write is
   debounced the same way the draft is. */
function queueMeterSave() {
  clearTimeout(meterSaveTimer);
  meterSaveTimer = setTimeout(() => {
    saveMeterLog().catch(err => {
      console.error('could not save the meter log', err);
      toast('Could not save the meter reading');
    });
  }, 400);
}

/* ---------------- rendering ---------------- */

const el = (sel) => document.querySelector(sel);

function render() {
  // Listeners live on the stable #checklist container and are attached once
  // in boot(), so re-rendering the markup must not re-bind them.
  el('#checklist').innerHTML = CHECKLIST.map(renderSection).join('');
  refresh();
}

/* Inline SVG rather than emoji. A camera or pencil emoji is drawn from
   whatever font the WebView happens to have, which on a plant phone has
   turned up as an empty box; these always draw. */
const ICON = {
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M3.5 9A2 2 0 0 1 5.5 7h1.9l1.2-2h6.8l1.2 2h1.9a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2V9Z"/>'
    + '<circle cx="12" cy="13" r="3.3"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M4 20.2h4L20 8.2l-4-4L4 16.2v4Z"/><path d="M14.2 6l3.8 3.8"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>'
};

function renderSection(section) {
  return `
    <section class="section" data-section="${section.id}">
      <div class="section-head">
        <span class="section-no">${esc(section.number)}</span>
        <span class="section-title">${esc(section.title)}</span>
        <span class="section-tally" data-sectiontally="${section.id}"></span>
      </div>
      <div class="section-body">
        ${section.groups.map(g => renderGroup(section, g)).join('')}
      </div>
    </section>`;
}

function renderGroup(section, group) {
  return `
    <div class="group" data-group="${group.id}" data-collapsed="false">
      <button class="group-head" type="button" data-toggle="${group.id}">
        <span class="dot blank" data-groupdot="${group.id}"></span>
        <span class="group-head-text">
          <span class="group-title">${esc(group.number)} &middot; ${esc(group.title)}</span>
          ${group.note ? `<span class="group-note">${esc(group.note)}</span>` : ''}
        </span>
        <span class="group-meta">
          <span class="group-tally" data-grouptally="${group.id}"></span>
          ${ICON.chevron}
        </span>
      </button>
      <div class="group-items">
        ${group.items.map(renderItem).join('')}
      </div>
    </div>`;
}

/* Which checks get the OK / Monitor / Fault / Not done buttons.

   Not choice items, which carry their own grading, and not the sample-date
   rows, which only need a date. And - at the operator's request - not the
   tank levels or separator testing, which took four rows of buttons out of
   the chemical group alone. The tanks are still graded from the levels typed
   in, exactly as they always were whenever no button had been tapped; the
   buttons were only ever a manual override on top of that. */
const NO_STATUS_BUTTONS = new Set(['separators']);

function showsStatusButtons(item) {
  if (item.type === 'choice' || item.type === 'date' || item.type === 'stock') return false;
  return !NO_STATUS_BUTTONS.has(item.id);
}

/* Which buttons a check offers, where that is fewer than all four.

   At the operator's request the Monitor button is gone from the checks below,
   and the pH row has lost OK as well, which is what leaves room for bigger pH
   boxes. Anything not listed here keeps all four.

   Only the button you tap by hand is removed. The app still works out Monitor
   for itself from the typed readings and the trigger levels in Settings - a
   saturator at 600 kPa is still flagged as drifting - and OK on the pH row
   comes the same way, from readings inside their limits. */
const STATUS_CHOICES = {
  bio_vacuum:  [STATUS.OK, STATUS.FAULT, STATUS.TODO],
  daf_pumps:   [STATUS.OK, STATUS.FAULT, STATUS.TODO],
  daf_paddles: [STATUS.OK, STATUS.FAULT, STATUS.TODO],
  sat1:        [STATUS.OK, STATUS.FAULT, STATUS.TODO],
  sat2:        [STATUS.OK, STATUS.FAULT, STATUS.TODO],
  floc_mixer:  [STATUS.OK, STATUS.FAULT, STATUS.TODO],
  flow_rate:   [STATUS.OK, STATUS.FAULT, STATUS.TODO],
  ph:          [STATUS.FAULT, STATUS.TODO]
};

const ALL_STATUS_BUTTONS = [
  [STATUS.OK, 'OK'], [STATUS.WATCH, 'Monitor'],
  [STATUS.FAULT, 'Fault'], [STATUS.TODO, 'Not done']
];

function statusButtonsFor(item) {
  const only = STATUS_CHOICES[item.id];
  return only ? ALL_STATUS_BUTTONS.filter(([s]) => only.includes(s)) : ALL_STATUS_BUTTONS;
}

/* ---------------- dates ----------------

   The date boxes show 14/OCT/26 instead of whatever the phone's own format is
   (10/14/2026 on this one). A date input's displayed format belongs to the
   browser and cannot be styled, so each box is two layers: the text you read,
   and the real date input laid invisibly over it. Tapping still opens the
   phone's calendar, and the value underneath is still the plain YYYY-MM-DD
   everything else reads - only what is drawn on top is different. */
const DATE_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function fmtDateBox(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return '';
  return `${m[3]}/${DATE_MONTHS[month]}/${m[1].slice(2)}`;
}

// The markup for one date box. `attrs` is whatever identifies the input.
function dateBoxHtml(attrs, value) {
  return `<span class="datebox"><span class="datebox-text" aria-hidden="true"></span>`
    + `<input type="date" ${attrs} value="${esc(value || '')}"></span>`;
}

// Redraws the text on every date box from the date underneath it.
function syncDateBoxes() {
  document.querySelectorAll('.datebox').forEach(box => {
    const input = box.querySelector('input');
    const text = box.querySelector('.datebox-text');
    if (!input || !text) return;
    const shown = fmtDateBox(input.value);
    text.textContent = shown || 'Pick a date';
    setClass(text, 'empty', !shown);
  });
}

function renderItem(item) {
  const v = state.values[item.id] || {};
  let control = '';

  if (item.type === 'number') {
    // No placeholder: the box is sized for three or four digits now, and a
    // word in it would only show half cut off.
    control = `
      <div class="numrow">
        <input type="number" inputmode="decimal" step="any" data-num="${item.id}"
               value="${v.value ?? ''}">
        <span class="unit">${esc(item.unit || '')}</span>
      </div>`;

  } else if (item.type === 'multi') {
    // The field name sits in its own span so the narrow pH boxes can tuck
    // their "1 / 2 / 3" into the corner of the box instead of a row above it.
    control = `
      <div class="multirow${item.inputWidth === 'narrow' ? ' narrow' : ''}">
        ${item.fields.map(f => `
          <label class="mfield"><span class="mtag">${esc(f.label)}</span>
            <input type="number" inputmode="decimal" step="any"
                   data-multi="${item.id}" data-key="${f.key}" value="${v[f.key] ?? ''}">
          </label>`).join('')}
        ${item.unit ? `<span class="unit">${esc(item.unit)}</span>` : ''}
      </div>`;

  } else if (item.type === 'stock') {
    const u = esc(item.unit);
    control = `
      <div class="stockblock">
        <div class="stockrow yesterday">
          <span class="stocktag">Last check</span>
          <label>${item.hasBackup ? 'In use' : 'Level'}
            <input type="number" inputmode="decimal" step="any"
                   data-pair="${item.id}" data-side="prevInUse" value="${v.prevInUse ?? ''}">
          </label>
          ${item.hasBackup ? `
          <label>Backup
            <input type="number" inputmode="decimal" step="any"
                   data-pair="${item.id}" data-side="prevBackup" value="${v.prevBackup ?? ''}">
          </label>` : ''}
        </div>
        <div class="stockrow today">
          <span class="stocktag">Now</span>
          <label>${item.hasBackup ? 'In use' : 'Level'} (${u})
            <input type="number" inputmode="decimal" step="any"
                   data-pair="${item.id}" data-side="inUse" value="${v.inUse ?? ''}">
          </label>
          ${item.hasBackup ? `
          <label>Backup (${u})
            <input type="number" inputmode="decimal" step="any"
                   data-pair="${item.id}" data-side="backup" value="${v.backup ?? ''}">
          </label>` : ''}
          ${item.topUp === 'ibc' ? `
          <label>IBCs in
            <input type="number" inputmode="numeric" step="1" min="0" placeholder="0"
                   data-pair="${item.id}" data-side="ibc" value="${v.ibc ?? ''}"
                   ${v.unknownDelivery ? 'disabled' : ''}>
          </label>` : `
          <label>Added (${u})
            <input type="number" inputmode="decimal" step="any" placeholder="0"
                   data-pair="${item.id}" data-side="added" value="${v.added ?? ''}">
          </label>`}
        </div>
        ${item.topUp === 'ibc' ? `
        <div class="stockrow unsure">
          <button type="button" class="unsure-btn" data-unsure="${item.id}"
                  aria-pressed="${v.unknownDelivery ? 'true' : 'false'}">
            I don&rsquo;t know if any were delivered
          </button>
        </div>` : ''}
      </div>
      <div class="usage" data-usage="${item.id}"></div>`;

  } else if (item.type === 'choice') {
    control = `
      <div class="choicerow">
        ${item.options.map(o => `
          <button type="button" class="cbtn ${o.status}" data-choice="${item.id}" data-value="${o.value}"
                  aria-pressed="${v.choice === o.value ? 'true' : 'false'}">${esc(o.label)}</button>`).join('')}
      </div>`;

  } else if (item.type === 'date') {
    control = dateBoxHtml(`data-date="${item.id}"`, v.date);
  }

  const statusRow = !showsStatusButtons(item) ? '' : `
    <div class="statusrow">
      ${statusButtonsFor(item).map(([s, label]) => `
        <button type="button" class="sbtn ${s}" data-status="${item.id}" data-value="${s}"
                aria-pressed="${v.status === s ? 'true' : 'false'}">${label}</button>`).join('')}
    </div>`;

  // A short reading and its buttons share one line (saturators, flow rate,
  // pH). See .inline-row for what happens on a phone too narrow for both.
  const inline = !!statusRow && (item.type === 'number' || item.type === 'multi');
  const body = inline
    ? `<div class="inline-row">${control}${statusRow}</div>`
    : `${control}${statusRow}`;

  /* The photo and note buttons sit on the label line as icons. They used to be
     a pair of labelled buttons on a row of their own, which cost about 49px on
     every one of the 38 items - roughly a fifth of the whole sheet - for two
     actions that are used on a handful of checks. */
  return `
    <div class="item" data-item="${item.id}" data-type="${item.type}">
      <div class="item-top">
        <div class="item-id">
          <div class="item-label">${esc(item.label)}</div>
          ${item.hint ? `<div class="item-hint">${esc(item.hint)}</div>` : ''}
        </div>
        <div class="item-aside">
          <button type="button" class="icon-tool" data-photo="${item.id}"
                  aria-label="Add a photo to ${esc(item.label)}">${ICON.camera}</button>
          <button type="button" class="icon-tool" data-note="${item.id}"
                  aria-label="Add a note to ${esc(item.label)}">${ICON.pencil}</button>
          <span class="pill blank" data-pill="${item.id}">-</span>
        </div>
      </div>
      ${body}
      <div class="note-input" data-notewrap="${item.id}" ${v.note ? '' : 'hidden'}>
        <input type="text" data-notefield="${item.id}" value="${esc(v.note || '')}"
               placeholder="Short note for your manager">
      </div>
      <div class="thumbs" data-thumbs="${item.id}"></div>
      <input type="file" accept="image/*" capture="environment" multiple
             data-fileinput="${item.id}" hidden>
    </div>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- events ---------------- */

function bindChecklist() {
  const root = el('#checklist');

  root.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const group = toggle.closest('.group');
      group.dataset.collapsed = group.dataset.collapsed === 'true' ? 'false' : 'true';
      return;
    }

    const sbtn = e.target.closest('[data-status]');
    if (sbtn) {
      const id = sbtn.dataset.status;
      const v = valueOf(id);
      // Always select. Tapping the current choice must not clear the row.
      v.status = sbtn.dataset.value;
      root.querySelectorAll(`[data-status="${id}"]`).forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.value === v.status ? 'true' : 'false');
      });
      queueSave();
      refresh();
      return;
    }

    const cbtn = e.target.closest('[data-choice]');
    if (cbtn) {
      const id = cbtn.dataset.choice;
      const v = valueOf(id);
      v.choice = cbtn.dataset.value;
      root.querySelectorAll(`[data-choice="${id}"]`).forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.value === v.choice ? 'true' : 'false');
      });
      queueSave();
      refresh();
      return;
    }

    const unsure = e.target.closest('[data-unsure]');
    if (unsure) {
      const id = unsure.dataset.unsure;
      const val = valueOf(id);
      val.unknownDelivery = !val.unknownDelivery;
      if (val.unknownDelivery) val.ibc = '';
      queueSave();
      render();
      return;
    }

    const photoBtn = e.target.closest('[data-photo]');
    if (photoBtn) {
      root.querySelector(`[data-fileinput="${photoBtn.dataset.photo}"]`).click();
      return;
    }

    const noteBtn = e.target.closest('[data-note]');
    if (noteBtn) {
      const wrap = root.querySelector(`[data-notewrap="${noteBtn.dataset.note}"]`);
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) wrap.querySelector('input').focus();
      return;
    }

    const rm = e.target.closest('[data-rmphoto]');
    if (rm) {
      removePhoto(rm.dataset.item, rm.dataset.rmphoto);
      return;
    }
  });

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.num !== undefined) {
      valueOf(t.dataset.num).value = t.value;
    } else if (t.dataset.pair !== undefined) {
      valueOf(t.dataset.pair)[t.dataset.side] = t.value;
    } else if (t.dataset.multi !== undefined) {
      valueOf(t.dataset.multi)[t.dataset.key] = t.value;
    } else if (t.dataset.date !== undefined) {
      valueOf(t.dataset.date).date = t.value;
    } else if (t.dataset.notefield !== undefined) {
      valueOf(t.dataset.notefield).note = t.value;
    } else {
      return;
    }
    queueSave();
    refresh();
  });

  root.addEventListener('change', async (e) => {
    const input = e.target;
    if (input.dataset.fileinput === undefined) return;
    const itemId = input.dataset.fileinput;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    toast(files.length > 1 ? `Adding ${files.length} photos...` : 'Adding photo...');
    for (const file of files) {
      try {
        await attachPhoto(itemId, file);
      } catch (err) {
        console.error(err);
        toast('That photo could not be read');
      }
    }
    queueSave();
    refresh();
  });
}

/* ---------------- photos ---------------- */

const MAX_EDGE = 1400;
const JPEG_QUALITY = 0.72;

async function attachPhoto(itemId, file) {
  const processed = await downscaleToJpeg(file);
  const pid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  state.photos[pid] = processed;
  valueOf(itemId).photos.push(pid);
}

function removePhoto(itemId, pid) {
  const v = valueOf(itemId);
  v.photos = v.photos.filter(p => p !== pid);
  delete state.photos[pid];
  queueSave();
  refresh();
}

async function downscaleToJpeg(file, maxEdge) {
  const bitmap = await loadBitmap(file);
  const limit = maxEdge || MAX_EDGE;
  const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // White base so any transparency flattens instead of turning black in JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: w, height: h };
}

function loadBitmap(file) {
  if (window.createImageBitmap) {
    // from-image applies the EXIF rotation so photos are not sideways.
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(file))
      .catch(() => loadViaImgTag(file));
  }
  return loadViaImgTag(file);
}

function loadViaImgTag(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- refresh (pills, dots, summary, progress) ---------------- */

function refresh() {
  // The log decides what today's and the previous reading are, so it is read
  // first and every figure below follows from it.
  syncMeterFromLog();
  const ev = evaluate(state, previousReport, submittedReports, dosingEvents, meterReadings);

  Object.keys(ev.items).forEach(id => {
    const pill = document.querySelector(`[data-pill="${id}"]`);
    if (!pill) return;
    const s = ev.items[id].status;
    pill.className = `pill ${s}`;
    pill.textContent = STATUS_META[s].short;

    // Drives the colour rail down the left edge of the row.
    const row = document.querySelector(`[data-item="${id}"]`);
    if (row) row.setAttribute('data-state', s);

    // live "used since yesterday" line under the chemical inputs
    const usage = document.querySelector(`[data-usage="${id}"]`);
    if (usage) {
      const sum = ev.items[id].sum;
      if (sum) {
        const rows = sum.rows.map(r =>
          `<div class="sumrow"><span>${esc(r.label)}${r.detail ? ' <em>' + esc(r.detail) + '</em>' : ''}</span>` +
          `<strong>${esc(r.value)}</strong></div>`).join('');
        usage.innerHTML =
          `<div class="sumbox">${rows}` +
          `<div class="sumrow total"><span>${esc(sum.total.label)}</span>` +
          `<strong>${esc(sum.total.value)}</strong></div>` +
          (sum.footer ? `<div class="sumfoot">${esc(sum.footer)}</div>` : '') +
          `</div>`;
      } else {
        usage.innerHTML = '';
      }
    }

    const thumbs = document.querySelector(`[data-thumbs="${id}"]`);
    if (thumbs) {
      const photos = (state.values[id] && state.values[id].photos) || [];
      thumbs.innerHTML = photos.map(pid => {
        const p = state.photos[pid];
        if (!p) return '';
        return `<div class="thumb">
                  <img src="${p.dataUrl}" alt="">
                  <button type="button" data-rmphoto="${pid}" data-item="${id}" aria-label="Remove photo">&times;</button>
                </div>`;
      }).join('');
    }

    /* The icons carry a mark when something is attached, so a check with a
       photo or a note can be spotted without opening anything. */
    const vals = state.values[id] || {};
    const photoBtn = document.querySelector(`[data-photo="${id}"]`);
    if (photoBtn) {
      const n = (vals.photos || []).length;
      setClass(photoBtn, 'has', n > 0);
      photoBtn.setAttribute('data-count', n > 1 ? String(n) : '');
    }
    setClass(document.querySelector(`[data-note="${id}"]`), 'has', !!(vals.note || '').trim());
  });

  CHECKLIST.forEach(section => {
    let secDone = 0;
    let secTotal = 0;
    section.groups.forEach(group => {
      const worst = worstOf(group.items.map(i => ev.items[i.id].status));
      const dot = document.querySelector(`[data-groupdot="${group.id}"]`);
      if (dot) dot.className = `dot ${worst}`;

      // "4/5" on each group header, so a half-finished group is obvious even
      // when it is folded shut.
      const gDone = group.items.filter(i => ev.items[i.id].status !== STATUS.BLANK).length;
      secDone += gDone;
      secTotal += group.items.length;
      const tally = document.querySelector(`[data-grouptally="${group.id}"]`);
      if (tally) {
        tally.textContent = `${gDone}/${group.items.length}`;
        setClass(tally, 'complete', gDone === group.items.length);
      }
    });
    const secTally = document.querySelector(`[data-sectiontally="${section.id}"]`);
    if (secTally) secTally.textContent = `${secDone}/${secTotal}`;
  });

  const total = Object.keys(ITEM_INDEX).length;
  const counts = { ok: 0, watch: 0, fault: 0, todo: 0 };
  Object.values(ev.items).forEach(i => {
    if (counts[i.status] !== undefined) counts[i.status]++;
  });
  const done = Object.values(ev.items).filter(i => i.status !== STATUS.BLANK).length;
  el('#progressFill').style.width = `${Math.round(done / total * 100)}%`;

  /* The bar alone says how much is filled in but not whether anything is
     wrong, which is the part worth knowing before walking back inside. */
  const notes = [`${done} of ${total} checks recorded`];
  if (counts.fault) notes.push(`${counts.fault} fault${counts.fault > 1 ? 's' : ''}`);
  if (counts.watch) notes.push(`${counts.watch} to monitor`);
  if (counts.todo) notes.push(`${counts.todo} not done`);
  el('#progressLabel').textContent = notes.join(' \u00B7 ');
  el('#progressLabel').className =
    'progress-label' + (counts.fault ? ' has-fault' : counts.watch ? ' has-watch' : '');
  el('#topbarDate').textContent =
    `${prettyDate(state.date)}${state.reporter ? ' \u00B7 ' + state.reporter : ''}`;

  renderSummary(ev);
  // The counts above can wrap the progress line onto a second row, which
  // changes how far down the sticky headers belong.
  syncTopbarHeight();
  syncDateBoxes();
  return ev;
}

function renderSummary(ev) {
  const body = el('#summaryBody');
  const blocks = [];
  CHECKLIST.forEach(section => {
    const actions = ev.actions[section.id];
    if (!actions.length) return;
    blocks.push(`<div class="sum-owner">${esc(section.owner)}</div>`);
    actions.forEach(a => {
      blocks.push(`
        <div class="sum-item">
          <span class="bar ${a.status}"></span>
          <span><strong>${esc(a.label)}</strong>${a.reason ? ` <span class="sum-reason">- ${esc(a.reason)}</span>` : ''}</span>
        </div>`);
    });
  });
  if (!blocks.length) {
    const anyFilled = Object.values(ev.items).some(i => i.status !== STATUS.BLANK);
    body.className = 'summary-empty';
    body.innerHTML = anyFilled
      ? '\u2705 Everything recorded so far is within limits.'
      : 'Fill in the checklist below.';
  } else {
    body.className = '';
    body.innerHTML = blocks.join('');
  }
}

/* ---------------- PDF + sharing ---------------- */

async function generatePdf() {
  if (!state.reporter.trim()) {
    /* The name lives in Settings now, so pointing at the box is not enough -
       the sheet it sits in has to be opened too, or the toast sends the
       operator looking for a field that is not on screen. */
    toast('Add your name in Settings first');
    openSheet('#settingsSheet');
    el('#fReporter').focus();
    return;
  }

  /* A report is filed under its date, so saving a second one for the same day
     replaces the first. The period it covered then exists nowhere, while the
     next report carries on from the later reading - so that water is simply
     gone from the record. Worth a word before it happens. */
  try {
    const existing = await store.get(`report-${state.date}`);
    if (existing && existing.source !== HISTORIC_TAG && existing.values) {
      const ok = confirm(
        `A report for ${prettyDate(state.date)} is already saved.\n\n`
        + 'Saving again replaces it, and the period it covered will no longer '
        + 'be recorded anywhere.\n\n'
        + 'If you only came to log a meter reading or a dosing switch, those '
        + 'are already saved - you do not need to make a report.\n\n'
        + 'Replace it?'
      );
      if (!ok) return;
    }
  } catch (err) {
    console.error('could not check for an existing report', err);
  }

  const ev = refresh();
  toast('Building PDF...');

  // Decode the stored JPEGs only now, so the draft stays small in storage.
  const photosWithBytes = {};
  Object.entries(state.photos).forEach(([pid, p]) => {
    photosWithBytes[pid] = { ...p, bytes: dataUrlToBytes(p.dataUrl) };
  });

  const forPdf = { ...state, photos: photosWithBytes };
  if (state.logo && state.logo.dataUrl) {
    forPdf.logo = { ...state.logo, bytes: dataUrlToBytes(state.logo.dataUrl) };
  }

  let bytes;
  try {
    bytes = buildPdf(forPdf, ev, previousReport);
  } catch (err) {
    console.error(err);
    toast('PDF failed to build');
    return;
  }

  await archiveCurrent();

  const filename = `Ops-Report-${state.date}.pdf`;
  await deliverPdf(bytes, filename);
}

/* Clears the checklist for a fresh report, keeping the operator's name,
   the site name and the trigger levels. Saved reports are untouched. */
async function startNewReport() {
  const filled = Object.keys(state.values).length > 0;
  if (filled) {
    const ok = confirm(
      'Start a new report?\n\n' +
      "This clears the checks, readings and photos on screen. Today's tank " +
      'levels are moved into the Yesterday boxes so usage still works.\n\n' +
      'Reports you have already saved are kept.'
    );
    if (!ok) return;
  }

  // Today's levels become the next report's starting point.
  const carriedStock = carryStockForward(state.values);
  // Sampling dates move on their own schedule, so yesterday's are repeated.
  const carriedDates = carryDatesForward(state.values);
  const previousDate = state.date;
  const previousTime = state.readingTime || DEFAULT_READING_TIME;
  state = {
    ...blankState(), ...carriedSettings(),
    values: { ...defaultValues(), ...carriedStock, ...carriedDates },
    lastCheckDate: previousDate, lastReadingTime: previousTime,
    // The round happens at much the same time each day, so last time's is a
    // far better guess than the clock.
    readingTime: previousTime,
    id: DRAFT_ID
  };
  // Meter readings live in their own log, so the previous reading is still
  // there to be found rather than being carried across by hand.
  syncMeterFromLog();

  await store.put({ ...state, savedAt: Date.now() });
  previousReport = await findPreviousReport();
  submittedReports = await loadSubmittedReports();

  hydrateFields();
  render();
  renderThresholds();
  closeSheets();
  toast('Fresh report ready - yesterday\u2019s levels carried over');
}

async function deliverPdf(bytes, filename) {
  // 1. Wrapped in the Android app - hand it to the native share sheet.
  if (window.AndroidBridge && typeof window.AndroidBridge.sharePdf === 'function') {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    window.AndroidBridge.sharePdf(btoa(binary), filename);
    toast('Opening share sheet...');
    return;
  }

  const blob = new Blob([bytes], { type: 'application/pdf' });
  const file = new File([blob], filename, { type: 'application/pdf' });

  // 2. Mobile browser that can share files (sends straight to WhatsApp).
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      toast('Shared');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }

  // 3. Plain download.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('PDF saved to your downloads');
}

/* Archives the submitted report. Photos are left out of the stored copy - they
   have already gone out by WhatsApp or email, and keeping them would slowly
   fill the phone. The copy on screen keeps its photos so it can be re-sent. */
async function archiveCurrent() {
  const id = `report-${state.date}`;
  const stripped = { ...state, id, savedAt: Date.now(), photos: {} };
  stripped.values = {};
  Object.entries(state.values).forEach(([k, v]) => {
    stripped.values[k] = { ...v, photos: [] };
  });
  await store.put(stripped);
  await pruneOldReports();
  submittedReports = await loadSubmittedReports();
}

const KEEP_REPORT_DAYS = 365;

async function pruneOldReports() {
  try {
    // Left behind when the log was renamed from DAF to chemical dosing.
    await store.del('__daf-log');
    const all = await store.all();
    const today = todayISO();
    for (const r of all) {
      if (r.id === DRAFT_ID || !r.date) continue;
      // Clears out the temporary sample reports used while reviewing the
      // chart, so none of it can leak into a real average.
      if (r.source === 'sample') { await store.del(r.id); continue; }
      const age = daysBetween(r.date, today);
      if (age !== null && age > KEEP_REPORT_DAYS) await store.del(r.id);
    }
  } catch (err) {
    console.error('could not prune old reports', err);
  }
}

const DOSING_KEY = '__dosing-log';

async function loadDosingLog() {
  try {
    const rec = await store.get(DOSING_KEY);
    dosingEvents = (rec && Array.isArray(rec.events)) ? rec.events : [];
  } catch (err) {
    console.error('could not load the DAF log', err);
    dosingEvents = [];
  }
}

async function saveDosingLog() {
  dosingEvents.sort((a, b) => (a.at < b.at ? -1 : 1));
  await store.put({ id: DOSING_KEY, events: dosingEvents, savedAt: Date.now() });
}

const METER_KEY = '__meter-log';
/* Bumped when the embedded readings change, so corrections reach a phone that
   already loaded an earlier set. Readings added by hand are always kept. */
const METER_SEED_VERSION = 1;

async function loadMeterLog() {
  try {
    const rec = await store.get(METER_KEY);
    meterReadings = (rec && Array.isArray(rec.readings)) ? rec.readings : [];
  } catch (err) {
    console.error('could not load the meter log', err);
    meterReadings = [];
  }
}

async function saveMeterLog() {
  meterReadings.sort((a, b) => (a.at < b.at ? -1 : 1));
  await store.put({
    id: METER_KEY, readings: meterReadings,
    seedVersion: METER_SEED_VERSION, savedAt: Date.now()
  });
}

/* Loads the hand-recorded meter readings.

   Only ever adds: a reading already in the log keeps whatever value it has, so
   a correction typed on the phone is never undone by an update.

   `force` ignores the "already loaded" stamp, which is how a reading deleted
   by mistake can be put back. Without it there is no way back: the recorded
   readings are what the water speed is measured from, so deleting a few of
   them quietly changes every dose figure with nothing on screen to say why. */
async function seedMeterLog(force) {
  try {
    const rec = await store.get(METER_KEY);
    const already = rec && rec.seedVersion === METER_SEED_VERSION;
    if (already && !force) return 0;

    const have = new Set(meterReadings.map(e => e.at));
    let added = 0;
    buildHistoricMeterLog().forEach(e => {
      if (have.has(e.at)) return;
      meterReadings.push(e);
      added++;
    });
    await saveMeterLog();
    return added;
  } catch (err) {
    console.error('could not load the recorded meter readings', err);
    return 0;
  }
}

/* Points state.meter / state.prevMeter at the log.

   The log is the single source of truth, so this runs before anything is
   worked out. Today's own reading is whatever the log holds for this morning,
   and the earlier figure is the newest reading before it - which is why
   starting a new report no longer loses the history. */
function syncMeterFromLog() {
  const nowStamp = readingStamp(state.date, state.readingTime);
  const mine = meterAtStamp(meterReadings, nowStamp);
  state.meter = mine === null ? '' : String(mine);
  const before = meterBefore(meterReadings, nowStamp);
  state.prevMeter = before ? num(before.value) : null;
  state.prevMeterAt = before ? before.at : null;
}

/* Writes today's reading into the log, replacing any earlier value for the
   same moment so editing the box does not pile up entries. */
async function recordMeterReading(stamp, value) {
  meterReadings = meterReadings.filter(e => e.at !== stamp);
  if (value !== null) meterReadings.push({ at: stamp, value });
  await saveMeterLog();
}

const SEED_MARKER = '__historic-seeded';
/* Bumped whenever the embedded readings change, so an app that already loaded
   an older set picks up the corrections instead of skipping them. */
const SEED_VERSION = 2;

/* Writes the hand-recorded readings into storage.

   Runs again whenever SEED_VERSION changes, and when it does it replaces its
   own earlier copies. A report the operator actually submitted is never
   touched, whatever its date.

   `force` lifts that last rule, which is the only way back from submitting a
   report over one of the recorded dates. Doing so replaces the recorded
   figures with the new report's, and those carry no meter readings, so the
   water speed silently loses the days it was measured from. */
async function seedHistoricReports(force) {
  try {
    const marker = await store.get(SEED_MARKER);
    if (marker && marker.version === SEED_VERSION && !force) return 0;

    const byId = new Map((await store.all()).map(r => [r.id, r]));
    const fresh = [];
    buildHistoricReports().forEach(rec => {
      const prior = byId.get(rec.id);
      if (prior && prior.source !== HISTORIC_TAG && !force) return;   // a real report wins
      fresh.push(rec);
    });
    fresh.push({ id: SEED_MARKER, version: SEED_VERSION, done: true, at: Date.now() });
    await store.putMany(fresh);
    return fresh.length - 1;
  } catch (err) {
    console.error('could not load the recorded readings', err);
    return 0;
  }
}

async function loadSubmittedReports() {
  try {
    const all = await store.all();
    return all
      .filter(r => r.id !== DRAFT_ID && r.date && r.values)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (err) {
    console.error('could not load report history', err);
    return [];
  }
}

/* Fills any empty Yesterday box from the most recent saved report.

   This is what makes an already-saved report useful straight away, and it only
   ever fills blanks, so anything typed by hand is left alone. */
async function seedYesterdayFromHistory() {
  try {
    const all = await store.all();
    const saved = all
      .filter(r => r.id !== DRAFT_ID && r.values)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    if (!saved.length) return;
    const source = saved[0];

    Object.values(ITEM_INDEX).forEach(item => {
      if (item.type !== 'stock') return;
      const from = source.values[item.id];
      if (!from) return;
      const target = valueOf(item.id);
      if (target.prevInUse === undefined || target.prevInUse === '') {
        if (num(from.inUse) !== null) target.prevInUse = String(num(from.inUse));
      }
      if (item.hasBackup && (target.prevBackup === undefined || target.prevBackup === '')) {
        if (num(from.backup) !== null) target.prevBackup = String(num(from.backup));
      }
    });
    // The sampling dates stand for days at a time, so the last ones recorded
    // are repeated rather than left blank for re-typing.
    Object.values(ITEM_INDEX).forEach(item => {
      if (item.type !== 'date') return;
      const from = source.values[item.id];
      if (!from || !from.date) return;
      const target = valueOf(item.id);
      if (!target.date) target.date = from.date;
    });

    /* The period has to be known even when every box was already filled in,
       because the water and dosing figures are measured over it. This used to
       be set only when a blank was filled, so a report whose boxes happened to
       be complete had no period at all - and with no period the water figures
       fall back to whatever reading happened to be newest. */
    if (!state.lastCheckDate) {
      state.lastCheckDate = source.date || null;
      state.lastReadingTime = source.readingTime || DEFAULT_READING_TIME;
    }
  } catch (err) {
    console.error('could not seed yesterday figures', err);
  }
}

/* The newest saved report from before today, used only for the number trends;
   stock usage now comes from the Yesterday boxes on the form. */
async function findPreviousReport() {
  const all = await store.all();
  const candidates = all
    .filter(r => r.id !== DRAFT_ID && r.date && r.date < state.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return candidates[0] || null;
}

/* ---------------- settings ---------------- */

const KEY_LABELS = {
  critLow: 'Fault at/below',
  warnLow: 'Monitor at/below',
  warnHigh: 'Monitor at/above',
  critHigh: 'Fault at/above',
  crit: 'Fault at/below',
  warn: 'Monitor at/below'
};

/* Lays a stored record over a blank state.

   The spread alone is not enough for the threshold stamps. A record written by
   an older build carries no stamp, blankState() supplies the current one, and
   the spread would keep that: the record would then look up to date and go on
   using levels the operator never chose. Reading both stamps straight off the
   record keeps "missing" meaning missing. */
function stateFromRecord(rec) {
  return {
    ...blankState(), ...rec, id: DRAFT_ID,
    thVersion: rec.thVersion,
    thEdited: rec.thEdited === true
  };
}

/* Pulls the decision from refreshThresholds() into the live state. */
function applyThresholdRefresh() {
  const next = refreshThresholds(state);
  state.thresholds = next.thresholds;
  state.thVersion = next.thVersion;
  state.thEdited = next.thEdited;
}

function bindThresholds() {
  el('#thresholdForm').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.th === undefined) return;
    const n = Number(t.value);
    if (!isFinite(n)) return;
    state.thresholds[t.dataset.th][t.dataset.thkey] = n;
    // Hand-typed levels outrank anything a future build ships as default.
    state.thEdited = true;
    state.thVersion = THRESHOLD_VERSION;
    queueSave();
    refresh();
  });
}

function renderThresholds() {
  el('#thresholdForm').innerHTML = Object.keys(state.thresholds).map(group => {
    const t = state.thresholds[group];
    const isLag = group === 'sampleLagDays';
    return `
      <div class="th-row">
        <div class="th-name">${esc(TH_LABELS[group] || group)}</div>
        <div class="th-inputs">
          ${Object.keys(t).map(k => `
            <label>${esc(isLag
              ? (k === 'warn' ? 'Monitor at/above' : 'Fault at/above')
              : (KEY_LABELS[k] || k))}
              <input type="number" step="any" data-th="${group}" data-thkey="${k}" value="${t[k]}">
            </label>`).join('')}
        </div>
      </div>`;
  }).join('');
}

async function renderHistory() {
  const all = await store.all();
  const saved = all
    .filter(r => r.id !== DRAFT_ID && r.date && r.values)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const list = el('#historyList');
  if (!saved.length) {
    list.innerHTML = '<p class="muted small">No saved reports yet.</p>';
    return;
  }
  list.innerHTML = saved.map(r => `
    <div class="history-row">
      <span>${esc(prettyDate(r.date))}
        <span class="muted">${r.source === HISTORIC_TAG ? 'recorded by hand' : 'submitted'}</span></span>
      <span class="h-actions">
        <button type="button" class="tool-btn" data-load="${esc(r.id)}">Load</button>
        <button type="button" class="tool-btn" data-delete="${esc(r.id)}">Delete</button>
      </span>
    </div>`).join('');

  list.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', async () => {
    const rec = await store.get(b.dataset.load);
    if (!rec) return;
    state = stateFromRecord(rec);
    applyThresholdRefresh();
    previousReport = await findPreviousReport();
    submittedReports = await loadSubmittedReports();
    hydrateFields();
    render();
    renderThresholds();
    closeSheets();
    toast('Report loaded');
  }));

  list.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
    await store.del(b.dataset.delete);
    renderHistory();
    toast('Deleted');
  }));
}

/* ---------------- sheets + toast ---------------- */

const closeTimers = new WeakMap();

function openSheet(sel) {
  const sheet = el(sel);
  if (!sheet) return;

  clearTimeout(closeTimers.get(sheet));
  sheet.hidden = false;
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('role', 'dialog');
  document.body.classList.add('no-scroll');

  // Unhide first, then animate on the next frame, otherwise the browser
  // has nothing to transition from.
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('is-open')));

  const inner = sheet.querySelector('.sheet-inner');
  if (inner) inner.scrollTop = 0;
}

function closeSheets() {
  document.querySelectorAll('.sheet').forEach(sheet => {
    if (sheet.hidden) return;
    sheet.classList.remove('is-open');
    sheet.removeAttribute('aria-modal');
    // Wait for the slide-down to finish before hiding it for real.
    clearTimeout(closeTimers.get(sheet));
    closeTimers.set(sheet, setTimeout(() => { sheet.hidden = true; }, 240));
  });
  document.body.classList.remove('no-scroll');
}

function anySheetOpen() {
  return Array.from(document.querySelectorAll('.sheet')).some(s => !s.hidden);
}

let toastTimer = null;
function toast(msg) {
  const t = el('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- wiring ---------------- */

/* ---------------- DAF running log ---------------- */

function renderDosing() {
  const card = el('#dosingCard');
  const running = dosingOnNow(dosingEvents);

  /* "Since" is the last switch that has actually happened. It used to be the
     newest entry of any kind, so a switch logged for a moment still to come
     printed "STOPPED since" that moment - with the ON entry right underneath,
     which read as the app ignoring it. Whether the dosing is running is
     decided exactly as before; only the wording around it changed. */
  const nowMs = Date.now();
  const logged = dosingEvents.filter(e => e && e.at);
  const notYet = (e) => { const t = toMs(e.at); return t !== null && t > nowMs; };
  const last = dosingLastEvent(logged.filter(e => !notYet(e)));
  const ahead = logged.filter(notYet).sort((a, b) => (a.at < b.at ? -1 : 1));

  card.classList.remove('running', 'stopped');
  if (logged.length) card.classList.add(running ? 'running' : 'stopped');

  el('#dosingNow').textContent = !logged.length ? 'Not logged yet'
    : (running ? 'DAF DOSAGE RUNNING' : 'DAF DOSAGE STOPPED');
  el('#dosingSince').textContent = last
    ? `since ${prettyStamp(last.at)}`
    : (logged.length ? '' : 'Record when the chemical dosage starts or stops');
  el('#btnDosingToggle').textContent = running
    ? 'Record DAF dosage stopped'
    : 'Record DAF dosage started';

  /* Entries made before future times were refused can still be in the log.
     Point at them: left alone, one starts counting the moment its time
     comes, on the wrong day, and skews the dosed water in the next report. */
  const warn = el('#dosingWarn');
  if (warn) {
    const first = ahead[0];
    warn.hidden = !first;
    warn.textContent = !first ? '' :
      `A ${first.on ? 'start' : 'stop'} is logged for ${prettyStamp(first.at)}, which `
      + "hasn't come yet, so it isn't counted. If that's wrong, remove it below and "
      + 'add it again with the right date.'
      + (ahead.length > 1 ? ` (${ahead.length - 1} more like it.)` : '');
  }

  // Newest first. Folded away bar the latest, so it can hold more than the
  // six that used to fit on screen. The full list is still in Settings.
  const recent = dosingEvents.slice().sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20);
  const rows = recent.map(e => `
    <div class="dosing-row${notYet(e) ? ' future' : ''}">
      <span class="dosing-when">${esc(prettyStamp(e.at))}</span>
      <span>
        ${e.meter !== undefined ? `<span class="muted">${esc(fmtQty(e.meter, 1))} m\u00B3</span> ` : ''}
        ${notYet(e) ? '<span class="dosing-future">not yet</span> ' : ''}
        <span class="dosing-what ${e.on ? 'on' : 'off'}">${e.on ? 'ON' : 'OFF'}</span>
        <button type="button" class="dosing-del" data-dosingdel="${esc(e.at)}">remove</button>
      </span>
    </div>`);
  el('#dosingList').innerHTML = collapsibleLog('dosing', rows);
  syncFoldButton('dosing', rows.length);
}

function prettyStamp(stamp) {
  if (!stamp) return '';
  const [d, t] = String(stamp).split('T');
  return `${prettyDate(d)}, ${t || ''}`.trim();
}

/* The folding panels: the older meter readings, the older dosing entries,
   and the whole of "Needs attention". Each opens from an arrow in its card's
   heading, beside the "?".

   Open or shut is remembered here rather than read back off the page. The
   meter list is redrawn on every keystroke in the morning meter box, and an
   open list must not snap shut while it is being looked at. Every session
   starts with all three shut; that is the point of them. */
const folds = { meter: false, dosing: false, summary: false };

// classList.toggle(name, force) is not used: the test harness's DOM ignores
// the second argument and flips the class instead, so it would test a
// different page from the one the phone draws.
function setClass(node, name, on) {
  if (!node) return;
  if (on) node.classList.add(name);
  else node.classList.remove(name);
}

function applyFold(key) {
  const open = !!folds[key];
  const btn = document.querySelector(`[data-fold="${key}"]`);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (key === 'summary') {
    const body = el('#summaryBody');
    if (body) body.hidden = !open;
    setClass(el('#summaryCard'), 'folded', !open);
  } else {
    const rest = document.querySelector(`[data-logrest="${key}"]`);
    if (rest) rest.hidden = !open;
  }
}

/* Shows the newest entry and keeps the rest behind the heading's arrow.

   These lists are history: the latest line is the one worth seeing every
   morning, and the older ones only matter when something needs correcting.
   Every row is still written into the page - the older ones are hidden, not
   left out - so opening the list never has to wait for anything. */
function collapsibleLog(key, rows) {
  if (rows.length < 2) return rows.join('');
  return rows[0]
    + `<div class="log-rest" data-logrest="${key}" ${folds[key] ? '' : 'hidden'}>`
    + `${rows.slice(1).join('')}</div>`;
}

// The arrow only appears when there is something behind it.
function syncFoldButton(key, rowCount) {
  const btn = document.querySelector(`[data-fold="${key}"]`);
  if (btn) btn.hidden = rowCount < 2;
  applyFold(key);
}

function openDosingEntry() {
  const running = dosingOnNow(dosingEvents);
  el('#dosingDate').value = todayISO();
  el('#dosingTime').value = nowHHMM();
  el('#dosingMeter').value = '';
  const hint = el('#dosingHint');
  hint.textContent = running
    ? 'When did you switch the dosage off? Add the meter reading if you noted it.'
    : 'When did you switch the dosage on? Add the meter reading if you noted it.';
  setClass(hint, 'problem', false);
  syncDateBoxes();
  el('#dosingEntry').hidden = false;
}

/* Why an entry was refused. Said in the form as well as in a toast: the toast
   is gone in under three seconds, and the form stays open to be corrected. */
function dosingFormProblem(msg) {
  const hint = el('#dosingHint');
  if (hint) {
    hint.textContent = msg;
    setClass(hint, 'problem', true);
  }
  toast(msg);
}

async function saveDosingEntry() {
  const date = el('#dosingDate').value;
  const time = el('#dosingTime').value;
  if (!date || !time) { toast('Pick a date and a time'); return; }

  const at = `${date}T${time}`;
  const on = !dosingOnNow(dosingEvents);

  /* A switch that has not happened yet cannot be right, and this used to be
     taken without a word. The dosing then read as still off - its moment had
     not come - and the report, which runs to this morning's round, left it
     out. Worse, once that moment did come it started counting, from the
     wrong day. The usual way in: switched on last night, logged on the
     morning round, with the date left on today, which is what the form
     fills in. */
  const atMs = toMs(at);
  if (atMs === null) {
    dosingFormProblem('That date or time could not be read - pick them again.');
    return;
  }
  if (atMs > Date.now()) {
    dosingFormProblem(`${prettyStamp(at)} hasn't come yet. If you switched it `
      + `${on ? 'on' : 'off'} last night, set the date to yesterday.`);
    return;
  }

  // Two of the same in a row cannot be right.
  const before = dosingEvents.filter(e => e.at <= at).sort((a, b) => (a.at < b.at ? -1 : 1));
  const prev = before.length ? before[before.length - 1] : null;
  if (prev && prev.on === on) {
    toast(`Already ${on ? 'started' : 'stopped'} at that point - check the time`);
    return;
  }

  /* A reading noted at the switch goes into the meter list, not onto the event.
     One list for every meter reading means one place to look when a figure
     needs correcting, and the same out-of-order check applies here as there. */
  const raw = el('#dosingMeter').value;
  const meter = num(raw);
  if (String(raw).trim() !== '' && meter === null) {
    toast('That meter reading could not be read');
    return;
  }
  if (meter !== null) {
    const clash = meterConflict(meterReadings, at, meter);
    if (clash) { toast(clash); return; }
  }

  dosingEvents.push({ at, on });
  await saveDosingLog();
  if (meter !== null) await recordMeterReading(at, meter);

  el('#dosingEntry').hidden = true;
  renderDosing();
  refresh();
  renderMeterLog();
  toast(on ? 'DAF dosage start recorded' : 'DAF dosage stop recorded');
}

function bindDosing() {
  el('#btnDosingToggle').addEventListener('click', openDosingEntry);
  el('#btnDosingCancel').addEventListener('click', () => { el('#dosingEntry').hidden = true; });
  el('#btnDosingSave').addEventListener('click', saveDosingEntry);
  el('#dosingList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-dosingdel]');
    if (!btn) return;
    dosingEvents = dosingEvents.filter(x => x.at !== btn.dataset.dosingdel);
    await saveDosingLog();
    renderDosing();
    refresh();
    toast('Entry removed');
  });
}

/* ---------------- DAF water meter log ---------------- */

function renderMeterLog(opts) {
  const keepInput = !!(opts && opts.keepInput);
  const nowStamp = readingStamp(state.date, state.readingTime);
  const mine = meterAtStamp(meterReadings, nowStamp);

  // While the operator is typing, leaving the box alone avoids fighting the
  // caret. Every other path rewrites it from the log.
  if (!keepInput) el('#fMeter').value = mine === null ? '' : String(mine);

  /* Says which reading this report is measured from, not simply the newest one
     in the log. Those are different as soon as a reading is noted mid-period:
     a 6pm reading is the newest, but the report still measures from the
     morning tank check. Calling the newest one "last reading" made the line
     look wrong whenever both existed. */
  const pm = el('#prevMeterNote');
  if (pm) {
    const from = meterOpening(meterReadings, state.lastCheckDate, state.lastReadingTime, nowStamp);
    pm.textContent = from
      ? `This report measures water from ${fmtQty(num(from.value), 1)} m\u00B3, `
        + `taken ${prettyStamp(from.at)}`
      : 'No earlier meter reading yet';
  }

  // The count is what tells the operator at a glance whether the history the
  // water speed rests on is still all there.
  const count = el('#meterCount');
  if (count) {
    const n = meterSorted(meterReadings).length;
    count.textContent = n ? `${n} reading${n === 1 ? '' : 's'} recorded` : '';
  }

  const list = el('#meterList');
  if (!list) return;
  /* Was eight, to stop the card running down the screen. Now that all but the
     newest fold away there is no space to save, so the list can hold enough
     history to actually correct an old reading - while still staying bounded,
     because a year of readings would be hundreds of rows. */
  const recent = meterSorted(meterReadings).slice().reverse().slice(0, 30);
  const rows = recent.map(e => {
    const prev = meterBefore(meterReadings, e.at);
    const diff = prev ? num(e.value) - num(prev.value) : null;
    return `
      <div class="dosing-row">
        <span class="dosing-when">${esc(prettyStamp(e.at))}${e.at === nowStamp ? ' <em>(this report)</em>' : ''}</span>
        <span>
          <strong>${esc(fmtQty(num(e.value), 1))}</strong>
          ${diff !== null ? `<span class="muted"> +${esc(fmtQty(diff, 1))} m\u00B3</span>` : ''}
          <button type="button" class="dosing-del" data-meterdel="${esc(e.at)}">remove</button>
        </span>
      </div>`;
  });
  list.innerHTML = rows.length
    ? collapsibleLog('meter', rows)
    : '<p class="muted small">No meter readings recorded yet.</p>';
  syncFoldButton('meter', rows.length);
}

function openMeterEntry() {
  // Deliberately left empty. This panel is for a day other than today, and
  // pre-filling today is what made it look like a second box for the morning
  // reading. An empty date forces the day to be chosen on purpose.
  el('#meterDate').value = '';
  el('#meterTime').value = DEFAULT_READING_TIME;
  el('#meterValue').value = '';
  syncDateBoxes();
  el('#meterEntry').hidden = false;
}

async function saveMeterEntry() {
  const date = el('#meterDate').value;
  const time = el('#meterTime').value;
  const value = num(el('#meterValue').value);
  if (!date || !time) { toast('Pick a date and a time'); return; }
  if (value === null) { toast('Type the meter reading'); return; }

  const at = `${date}T${time}`;

  const clash = meterConflict(meterReadings, at, value);
  if (clash) { toast(clash); return; }

  await recordMeterReading(at, value);
  el('#meterEntry').hidden = true;
  refresh();
  renderMeterLog();
  toast('Meter reading saved');
}

function bindMeterLog() {
  el('#btnMeterAdd').addEventListener('click', openMeterEntry);
  el('#btnMeterRestore').addEventListener('click', async () => {
    /* Restores the readings and the reports together. Separating them was a
       trap: the readings alone look restored while the reports they are
       measured against are still missing their meter figures. */
    const ok = confirm(
      'Put back the readings and reports recorded on paper?\n\n'
      + 'This replaces anything saved for 11 Sep to 2 Oct 2026 with the '
      + 'original figures. Reports for any other date are untouched.'
    );
    if (!ok) return;

    const readings = await seedMeterLog(true);
    const reports = await seedHistoricReports(true);
    previousReport = await findPreviousReport();
    submittedReports = await loadSubmittedReports();
    await seedYesterdayFromHistory();

    hydrateFields();
    renderFlowDetail(refresh());
    renderMeterLog();
    renderHistory();
    toast(`Put back ${readings} reading${readings === 1 ? '' : 's'} `
      + `and ${reports} report${reports === 1 ? '' : 's'}`);
  });
  el('#btnMeterCancel').addEventListener('click', () => { el('#meterEntry').hidden = true; });
  el('#btnMeterSave').addEventListener('click', saveMeterEntry);
  el('#meterList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-meterdel]');
    if (!btn) return;
    meterReadings = meterReadings.filter(x => x.at !== btn.dataset.meterdel);
    await saveMeterLog();
    refresh();
    renderMeterLog();
    toast('Reading removed');
  });
}

/* Shows the working behind the water speed.

   Without this the speed is a bare number averaged over days the operator
   cannot see, so a value that looks wrong can only be explained by reading the
   stored data by hand. */
function renderFlowDetail(ev) {
  const box = el('#flowDetail');
  if (!box) return;

  const days = (ev && ev.flowDetail) || [];
  const counts = `<p class="muted small">`
    + `${meterSorted(meterReadings).length} meter readings &middot; `
    + `${dosingEvents.length} dosing entries &middot; `
    + `${submittedReports.length} saved reports</p>`;

  if (!days.length) {
    box.innerHTML = counts
      + '<p class="muted small">No day yet has the dosing running right through '
      + 'between two meter readings, so there is no measured average flow. Until there '
      + 'is, dosed water can only be worked out when the meter was noted at the '
      + 'switch.</p>';
    return;
  }

  let water = 0, hours = 0;
  days.forEach(d => { water += d.water; hours += d.hours; });

  box.innerHTML = counts + days
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(d => `
      <div class="dosing-row">
        <span class="dosing-when">${esc(prettyDate(d.date))}</span>
        <span>
          <span class="muted">${esc(fmtQty(d.water, 1))} m\u00B3 in ${esc(fmtQty(d.hours, 1))} h</span>
          <strong>&nbsp;${esc(fmtQty(d.water / d.hours, 1))}</strong>
        </span>
      </div>`).join('')
    + `<div class="dosing-row"><span class="dosing-when"><strong>`
    + `${days.length} day${days.length === 1 ? '' : 's'} together</strong></span>`
    + `<span><span class="muted">${esc(fmtQty(water, 1))} m\u00B3 in ${esc(fmtQty(hours, 1))} h</span>`
    + `<strong>&nbsp;${esc(fmtQty(water / hours, 1))} m\u00B3/h</strong></span></div>`;

  /* The days that did not count, and why. This is the part that explains a
     speed that looks wrong: a day drops out silently otherwise. */
  const rejected = ((ev && ev.flowAll) || [])
    .filter(d => !d.counted && d.why && d.why !== 'no date')
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 10);
  if (rejected.length) {
    box.innerHTML += '<p class="muted small" style="margin-top:10px">'
      + 'Days not used, and why:</p>'
      + rejected.map(d => `
        <div class="dosing-row">
          <span class="dosing-when">${esc(prettyDate(d.date))}</span>
          <span class="muted">${esc(d.why)}</span>
        </div>`).join('');
  }
}

/* The dosing entries in full, so an extra or missing one can be spotted. The
   card on the main screen only shows the newest few. */
function renderDosingAudit() {
  const box = el('#dosingAudit');
  if (!box) return;
  const list = dosingEvents.slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  box.innerHTML = list.length
    ? list.map(e => `
        <div class="dosing-row">
          <span class="dosing-when">${esc(prettyStamp(e.at))}</span>
          <span class="dosing-what ${e.on ? 'on' : 'off'}">${e.on ? 'ON' : 'OFF'}</span>
        </div>`).join('')
    : '<p class="muted small">No dosing entries recorded.</p>';
}

/* ---------------- backup, and moving data between devices ----------------

   There is no server behind this app: every phone and PC keeps its own copy in
   its own browser, which is why two devices show different figures. Proper
   live sync would need a database and an account somewhere.

   This is the offline equivalent - one file holding everything, which can be
   sent by WhatsApp or email and loaded on the other device. It doubles as the
   only backup there is: lose the phone today and the lot goes with it. */

const BACKUP_VERSION = 1;

/* When this device last saved a backup, so it can say when one is due.

   Kept in a record of its own rather than in the draft: the draft is replaced
   every morning and whenever a saved report is loaded, and either would lose
   the date. */
const BACKUP_INFO_KEY = '__backup-info';
// After this many days the main screen starts asking for a backup.
const BACKUP_REMIND_DAYS = 7;
let lastBackupAt = null;

/* Records that must not travel. The draft is whatever that device happens to
   have half-finished, and the seed markers have to be judged locally - as does
   the backup date, which belongs to the device that made the backup. */
const BACKUP_SKIP = new Set([DRAFT_ID, SEED_MARKER, BACKUP_INFO_KEY]);

async function loadBackupInfo() {
  try {
    const rec = await store.get(BACKUP_INFO_KEY);
    lastBackupAt = rec && Number(rec.lastBackupAt) > 0 ? Number(rec.lastBackupAt) : null;
  } catch (err) {
    console.error('could not read the backup date', err);
    lastBackupAt = null;
  }
}

async function noteBackupMade() {
  lastBackupAt = Date.now();
  try {
    await store.put({ id: BACKUP_INFO_KEY, lastBackupAt });
  } catch (err) {
    console.error('could not record the backup date', err);
  }
  renderBackupStatus();
}

/* "today", "yesterday", "12 days ago" - by calendar day, as a person counts.
   Local dates on purpose: toISOString() is UTC, which on a Melbourne morning
   is still yesterday. */
function daysSinceBackup() {
  if (!lastBackupAt) return null;
  const iso = isoOf(lastBackupAt);
  return iso >= todayISO() ? 0 : (daysBetween(iso, todayISO()) || 0);
}

function renderBackupStatus() {
  const days = daysSinceBackup();
  const ago = days === null ? '' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;

  const status = el('#backupStatus');
  if (status) {
    status.textContent = days === null
      ? 'No backup has been saved on this phone yet.'
      : `Last backup: ${prettyDate(isoOf(lastBackupAt))} (${ago}).`;
    setClass(status, 'overdue', days === null || days >= BACKUP_REMIND_DAYS);
  }

  const nag = el('#backupNag');
  if (nag) {
    const due = days === null || days >= BACKUP_REMIND_DAYS;
    nag.hidden = !due;
    const text = el('#backupNagText');
    if (text && due) {
      text.textContent = days === null
        ? 'No backup saved yet. Your reports are only on this phone.'
        : `Last backup was ${ago}. Your reports are only on this phone.`;
    }
  }
}

// The local calendar date of a moment, as YYYY-MM-DD.
function isoOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function buildBackup() {
  const all = await store.all();
  const records = all
    .filter(r => r && r.id && !BACKUP_SKIP.has(r.id))
    .map(r => {
      // Photos are stripped: they are already sent out with the report and
      // would make the file far too big to pass between devices.
      const copy = { ...r, photos: {} };
      if (copy.values) {
        copy.values = {};
        Object.entries(r.values).forEach(([k, v]) => { copy.values[k] = { ...v, photos: [] }; });
      }
      return copy;
    });
  return {
    app: 'ops-report', version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    site: state.site || DEFAULT_SITE,
    records
  };
}

async function exportBackup() {
  try {
    const payload = await buildBackup();
    const text = JSON.stringify(payload);
    const name = `ops-report-backup-${todayISO()}.json`;
    const blob = new Blob([text], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });

    // Counted as made once the file is handed over; backing out of the share
    // sheet is not a backup, so the reminder stays.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        await noteBackupMade();
        toast('Backup shared');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    await noteBackupMade();
    toast(`Backup saved - ${payload.records.length} records`);
  } catch (err) {
    console.error('could not build the backup', err);
    toast('Could not make the backup');
  }
}

/* Folds an incoming record into what is already here.

   Reports: the one saved later wins, so the device used most recently for a
   given morning is the one that counts.

   The two logs are different - they are not one record per day but a list of
   moments, and each device may hold moments the other has never seen. Letting
   the later save win would throw away whichever list was written first, so the
   entries are merged by their timestamp instead. */
function mergeBackupRecord(mine, theirs) {
  if (!mine) return theirs;

  if (theirs.id === METER_KEY) {
    const by = new Map((mine.readings || []).map(e => [e.at, e]));
    (theirs.readings || []).forEach(e => { if (e && e.at) by.set(e.at, e); });
    return {
      ...mine,
      readings: Array.from(by.values()).sort((a, b) => (a.at < b.at ? -1 : 1)),
      savedAt: Date.now()
    };
  }

  if (theirs.id === DOSING_KEY) {
    const by = new Map((mine.events || []).map(e => [e.at, e]));
    (theirs.events || []).forEach(e => { if (e && e.at) by.set(e.at, e); });
    return {
      ...mine,
      events: Array.from(by.values()).sort((a, b) => (a.at < b.at ? -1 : 1)),
      savedAt: Date.now()
    };
  }

  // A report the operator submitted always beats a recorded-by-hand copy,
  // whichever was saved later.
  const mineReal = mine.source !== HISTORIC_TAG;
  const theirsReal = theirs.source !== HISTORIC_TAG;
  if (mineReal !== theirsReal) return mineReal ? mine : theirs;

  return (Number(theirs.savedAt) || 0) > (Number(mine.savedAt) || 0) ? theirs : mine;
}

async function importBackup(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    toast('That file could not be read');
    return;
  }
  if (!payload || payload.app !== 'ops-report' || !Array.isArray(payload.records)) {
    toast('That is not an ops report backup');
    return;
  }
  if (Number(payload.version) > BACKUP_VERSION) {
    toast('That backup came from a newer version of the app');
    return;
  }

  const when = payload.exportedAt ? payload.exportedAt.slice(0, 10) : 'an unknown date';
  const ok = confirm(
    `Load ${payload.records.length} records from ${when}?\n\n`
    + 'Readings and dosing times from both devices are combined. Where the same '
    + 'morning exists on both, the one saved later is kept.\n\n'
    + 'The report on screen is not touched.'
  );
  if (!ok) return;

  try {
    const byId = new Map((await store.all()).map(r => [r.id, r]));
    const merged = [];
    payload.records.forEach(rec => {
      if (!rec || !rec.id || BACKUP_SKIP.has(rec.id)) return;
      merged.push(mergeBackupRecord(byId.get(rec.id), rec));
    });
    if (merged.length) await store.putMany(merged);

    await loadDosingLog();
    await loadMeterLog();
    await pruneOldReports();
    previousReport = await findPreviousReport();
    submittedReports = await loadSubmittedReports();

    hydrateFields();
    renderDosing();
    renderMeterLog();
    renderFlowDetail(refresh());
    renderDosingAudit();
    renderHistory();
    toast(`Loaded ${merged.length} records`);
  } catch (err) {
    console.error('could not load the backup', err);
    toast('Could not load that backup');
  }
}

function bindBackup() {
  el('#btnBackupExport').addEventListener('click', exportBackup);
  el('#btnBackupNag').addEventListener('click', exportBackup);
  el('#btnBackupImport').addEventListener('click', () => el('#backupInput').click());
  el('#backupInput').addEventListener('change', async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = typeof file.text === 'function'
        ? await file.text()
        : await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsText(file);
        });
      await importBackup(text);
    } catch (err) {
      console.error(err);
      toast('That file could not be read');
    }
  });

  el('#btnCheckUpdate').addEventListener('click', async () => {
    if (!swReg) { toast('Updates only work when opened from the web address'); return; }
    /* Asking for an update needs signal and nothing else does. Say so, instead
       of an error that reads as though the app itself is broken. */
    if (navigator.onLine === false) {
      toast('No signal right now. The app still works - check again when you have signal.');
      return;
    }
    toast('Checking for an update...');
    try {
      await swReg.update();
      // A waiting worker means new files are ready but held back until the old
      // one lets go, which is why closing the app has not always been enough.
      if (swReg.waiting) {
        swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
        toast('Update found - restarting');
      } else if (swReg.installing) {
        toast('Update downloading - it will restart on its own');
      } else {
        toast('Already on the latest version');
      }
    } catch (err) {
      console.error('update check failed', err);
      toast('Could not reach the internet. The app still works - try again with signal.');
    }
  });
}

/* ---------------- company logo ---------------- */

const LOGO_MAX_EDGE = 420;

function renderLogo() {
  const box = el('#logoPreview');
  if (!box) return;
  box.innerHTML = state.logo && state.logo.dataUrl
    ? `<img src="${state.logo.dataUrl}" alt="Company logo">`
    : '<span class="muted small">No logo</span>';
}

function bindLogo() {
  el('#btnLogoPick').addEventListener('click', () => el('#logoInput').click());

  el('#btnLogoClear').addEventListener('click', () => {
    state.logo = null;
    renderLogo();
    queueSave();
    toast('Logo removed');
  });

  el('#logoInput').addEventListener('change', async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    try {
      // Flattened onto white and re-encoded as JPEG, which is what the PDF
      // writer can embed. Transparent PNGs therefore stay readable.
      state.logo = await downscaleToJpeg(file, LOGO_MAX_EDGE);
      renderLogo();
      queueSave();
      toast('Logo saved - it will appear on the next PDF');
    } catch (err) {
      console.error(err);
      toast('That image could not be read');
    }
  });
}

/* The section and group headers stick below the top bar, and anything the app
   scrolls to has to clear it. Its height is not a fixed number: the safe-area
   inset above it differs between phones, and the progress line wraps to two
   lines once the counts are long. So measure the bar and let the stylesheet
   work from the real figure.

   Guarded the same way as the error handlers at the foot of this file - the
   test harness has no layout engine, so there is nothing to measure there. */
let topbarHeight = 0;

function syncTopbarHeight() {
  const bar = document.querySelector('.topbar');
  const root = document.documentElement;
  if (!bar || typeof bar.getBoundingClientRect !== 'function') return;
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
  const h = Math.round(bar.getBoundingClientRect().height);
  // Only written when it actually moves; this is called from refresh(), which
  // runs on every keystroke.
  if (h > 0 && h !== topbarHeight) {
    topbarHeight = h;
    root.style.setProperty('--topbar-h', h + 'px');
  }
}

function showBuildId() {
  const meta = document.querySelector('meta[name="build-id"]');
  const raw = meta ? meta.getAttribute('content') : '';
  // Still the literal placeholder when running straight from www/ in development.
  const label = (!raw || raw.indexOf('BUILD_ID') !== -1) ? 'development build' : raw;
  /* Every place the version is shown, found by class rather than by id.

     These used to be separate ids, and when a third was added it reused one of
     them. Duplicate ids are legal HTML but querySelector only ever returns the
     first, so the other quietly kept saying "dev" - which is exactly the kind
     of thing that makes an update look as though it has not landed. */
  document.querySelectorAll('.js-build-id').forEach(target => {
    target.textContent = label;
  });
}

function hydrateFields() {
  el('#fDate').value = state.date;
  el('#fReporter').value = state.reporter || '';
  el('#fReadingTime').value = state.readingTime || DEFAULT_READING_TIME;
  // The meter box, the "last reading" line and the log list all come from the
  // one log, so they are filled in together.
  renderMeterLog();
  el('#fSite').value = state.site || '';
  el('#fPrefix').value = state.reportPrefix || DEFAULT_PREFIX;
  el('#fAvgWindow').value = state.avgWindowDays || DEFAULT_AVG_WINDOW;
  el('#fGeneralNote').value = state.generalNote || '';
  syncDateBoxes();
}

function bindShell() {
  el('#fDate').addEventListener('change', async e => {
    const picked = e.target.value || todayISO();

    /* Those dates hold the readings and reports recorded on paper before the
       app existed. Submitting over one of them replaces the recorded figures,
       and a submitted report carries no meter readings - so the days the water
       speed is measured from disappear, the speed moves, and nothing on screen
       says why. That happened in testing and took a long time to track down.

       A warning rather than a block: a real report might genuinely need one of
       these dates, and Settings can put the recorded data back either way. */
    if (picked >= RECORDED_FROM && picked <= RECORDED_TO && picked !== state.date) {
      const ok = confirm(
        `${prettyDate(RECORDED_FROM)} to ${prettyDate(RECORDED_TO)} hold the `
        + 'readings recorded on paper.\n\n'
        + 'Saving a report for this date replaces them, which changes the '
        + 'measured average flow and the dose figures.\n\n'
        + 'Use today\'s date for a test report. Carry on anyway?'
      );
      if (!ok) {
        e.target.value = state.date;
        syncDateBoxes();
        return;
      }
    }

    state.date = picked;
    // A different date means a different report to compare against.
    previousReport = await findPreviousReport();
    queueSave();
    refresh();
  });
  el('#fReporter').addEventListener('input', e => { state.reporter = e.target.value; queueSave(); refresh(); });

  /* The "?" buttons and the fold arrows in the card headings. One listener on
     main covers both, so nothing needs re-attaching when a list is redrawn. */
  /* A date picked on the phone redraws its text straight away, rather than
     waiting for the next refresh. */
  ['input', 'change'].forEach(type => document.addEventListener(type, (e) => {
    if (e.target && e.target.closest && e.target.closest('.datebox')) syncDateBoxes();
  }));

  /* With a mouse the invisible date input would only put the cursor on a hidden
     day/month/year segment, so the click is turned into the calendar. A finger
     already opens it natively, and is left alone. */
  document.addEventListener('click', (e) => {
    const input = e.target && e.target.closest && e.target.closest('.datebox input');
    if (!input || typeof input.showPicker !== 'function') return;
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: fine)').matches) return;
    try { input.showPicker(); } catch { /* already open, or not allowed right now */ }
  });

  // On the whole page, not just <main>: the Settings sheet has "?" buttons too.
  document.addEventListener('click', (e) => {
    const help = e.target.closest('[data-help]');
    if (help) {
      // A "?" can sit inside the Advanced heading, which must not fold open
      // just because its help was asked for.
      e.preventDefault();
      const panel = document.getElementById(help.dataset.help);
      if (!panel) return;
      const wasOpen = !panel.hidden;
      panel.hidden = wasOpen;
      help.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
      return;
    }

    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const key = fold.dataset.fold;
      folds[key] = !folds[key];
      applyFold(key);
    }
  });

  el('#fMeter').addEventListener('input', e => {
    // Straight into the log, under this morning's reading time, replacing any
    // value already there. The log is what every figure is read from.
    const stamp = readingStamp(state.date, state.readingTime);
    const value = num(e.target.value);
    meterReadings = meterReadings.filter(x => x.at !== stamp);
    if (value !== null) meterReadings.push({ at: stamp, value });
    queueMeterSave();
    queueSave();
    refresh();
    renderMeterLog({ keepInput: true });
  });
  el('#fReadingTime').addEventListener('change', e => {
    const oldStamp = readingStamp(state.date, state.readingTime);
    state.readingTime = e.target.value || DEFAULT_READING_TIME;
    // The reading moves with the time it was taken, so it does not strand
    // itself at the old moment and read as a second reading.
    const moved = meterReadings.find(x => x.at === oldStamp);
    if (moved) {
      const stamp = readingStamp(state.date, state.readingTime);
      meterReadings = meterReadings.filter(x => x.at !== oldStamp && x.at !== stamp);
      meterReadings.push({ at: stamp, value: moved.value });
      queueMeterSave();
    }
    queueSave();
    refresh();
    renderMeterLog();
  });
  el('#fSite').addEventListener('input', e => { state.site = e.target.value; queueSave(); });
  el('#fAvgWindow').addEventListener('input', e => {
    const n = Math.round(Number(e.target.value));
    state.avgWindowDays = isFinite(n) && n > 0 ? n : DEFAULT_AVG_WINDOW;
    queueSave();
    refresh();
  });
  el('#fPrefix').addEventListener('input', e => {
    state.reportPrefix = e.target.value.trim() || DEFAULT_PREFIX;
    queueSave();
  });
  el('#fGeneralNote').addEventListener('input', e => { state.generalNote = e.target.value; queueSave(); });

  el('#btnPdf').addEventListener('click', generatePdf);
  el('#btnSettings').addEventListener('click', () => {
    renderBackupStatus();
    renderOfflineStatus();
    renderHistory();
    renderFlowDetail(refresh());
    renderDosingAudit();
    openSheet('#settingsSheet');
  });
  el('#btnNewReport').addEventListener('click', startNewReport);
  el('#btnResetThresholds').addEventListener('click', () => {
    // One tap used to wipe every level typed by hand, with no way back.
    if (!confirm('Put every trigger level back to the original numbers?\n\n'
      + 'Any level you have changed will be lost.')) return;
    state.thresholds = deepCopy(DEFAULT_THRESHOLDS);
    // Back to shipped numbers, so a later build may update them again.
    state.thEdited = false;
    state.thVersion = THRESHOLD_VERSION;
    renderThresholds();
    queueSave();
    refresh();
    toast('Trigger levels reset');
  });

  document.addEventListener('click', (e) => {
    // Close on the X, on a "Done" button, or on a tap outside the panel.
    if (e.target.closest('[data-close-sheet]')) closeSheets();
    else if (e.target.classList.contains('sheet')) closeSheets();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && anySheetOpen()) {
      e.preventDefault();
      closeSheets();
    }
  });
}

/* Storage can be unavailable if the page is opened straight off the phone's
   filesystem rather than served over https. Better to say so loudly than to
   let someone fill in the whole checklist and lose it. */
async function checkStorage() {
  try {
    if (!window.indexedDB) throw new Error('IndexedDB missing');
    await store.put({ id: '__probe', savedAt: Date.now() });
    await store.del('__probe');
    return true;
  } catch (err) {
    console.error('storage unavailable', err);
    const warn = document.createElement('div');
    warn.className = 'card';
    warn.style.cssText = 'border-color:#be2c2c;background:#fdf2f2;color:#8a1f1f';
    warn.innerHTML =
      '<h2 style="color:#be2c2c">Autosave is not working</h2>' +
      '<p class="small" style="margin:0">This page cannot save to your phone, so if you ' +
      'close it you will lose what you have typed. Finish the report and send the PDF ' +
      'in one go. To fix it properly, open the app from its web address rather than ' +
      'from a downloaded file.</p>';
    document.querySelector('main').prepend(warn);
    return false;
  }
}

/* Puts a readable message on screen when start-up goes wrong.

   A blank page is the worst thing this app can do: it gives no reason, no way
   to reach the readings, and no clue whether the fault is the phone, the
   network or the app. Anything is better than nothing. */
function showStartupProblem(detail) {
  try {
    const host = document.querySelector('main') || document.body;
    if (!host || document.querySelector('#startupProblem')) return;
    const box = document.createElement('div');
    // setAttribute rather than `.id =`, which reads the same in a browser but
    // is the form the test harness can see too.
    box.setAttribute('id', 'startupProblem');
    box.className = 'card';
    box.style.cssText = 'border:2px solid #be2c2c;background:#fdf2f2;color:#8a1f1f';
    box.innerHTML =
      '<h2 style="color:#be2c2c;margin-top:0">The app did not start properly</h2>'
      + '<p class="small">Part of the screen could not be drawn, so some of it may be '
      + 'missing. Your saved readings and reports are not affected.</p>'
      + '<p class="small"><strong>Try:</strong> close the app completely and open it '
      + 'again. If it keeps happening, your readings can still be rescued from '
      + 'Settings using <strong>Save a backup</strong>.</p>'
      + (detail ? `<p class="small" style="opacity:.75">Could not: ${esc(detail)}</p>` : '');
    host.prepend(box);
  } catch {
    // Last resort: plain text straight into the body.
    document.body.innerHTML = '<p style="font:16px sans-serif;padding:20px">'
      + 'The app did not start properly. Close it completely and open it again.</p>';
  }
}

/* Asks the browser to keep this site's storage, and remembers what it said.

   Without it Chrome treats the readings, the cached app and everything else as
   throwaway, and can clear the lot when the phone runs short of space - which
   takes the offline copy with it and leaves a page that only works online.

   Never waited for: some browsers put a question to the user here, and a start
   that is held up behind a question nobody sees looks like an app that will not
   open. The answer is shown in Settings once it arrives. */
let storageProtected = null;   // null = not known (yet)

async function keepStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      let kept = typeof navigator.storage.persisted === 'function'
        ? await navigator.storage.persisted()
        : false;
      if (!kept) kept = await navigator.storage.persist();
      storageProtected = !!kept;
    }
  } catch (err) {
    console.error('could not ask to keep storage', err);
  }
}

/* ---------------- does this phone hold its own copy of the app? ----------------

   The app opens with no signal only because the phone saved a copy of it. That
   copy is made by the first visit with signal, and a phone can lose it - low
   storage, clearing the browser's data - without telling anyone. Left alone,
   the first sign is an error page at the plant. So the phone is asked, while
   there is still signal to fix it with, and says so plainly. */
let offlineReady = null;       // null = not asked yet; true / false / 'n/a'
let bootedAt = Date.now();     // not const: the tests move it to skip the wait

async function checkOfflineReady() {
  // Opened from a file, or inside the Android app: the app is already on the
  // phone, there is nothing to download.
  if (typeof location === 'undefined' || !String(location.protocol).startsWith('http')) return 'n/a';
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)
      || typeof caches === 'undefined'
      || typeof navigator.serviceWorker.getRegistration !== 'function') return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.active) return false;
    return !!(await caches.match('index.html', { ignoreSearch: true }));
  } catch (err) {
    console.error('could not check the saved copy', err);
    return false;
  }
}

async function renderOfflineStatus() {
  offlineReady = await checkOfflineReady();

  const line = el('#offlineStatus');
  if (line) {
    line.textContent = offlineReady === true || offlineReady === 'n/a'
      ? 'Works without signal: yes.'
      : 'Works without signal: not yet. Open the app once with signal.';
    setClass(line, 'overdue', offlineReady === false);
  }

  const kept = el('#storageStatus');
  if (kept) {
    kept.hidden = storageProtected === null || offlineReady === 'n/a';
    kept.textContent = storageProtected
      ? 'Protected from phone clean-ups: yes.'
      : 'Protected from phone clean-ups: no. Tap the ? to see how.';
    setClass(kept, 'overdue', !storageProtected);
  }

  /* The warning strip on the main screen is only for the one case that matters:
     the phone has no saved copy. Held back for a few seconds so it does not
     flash up on a first visit while the copy is still being made. */
  const nag = el('#offlineNag');
  if (nag) nag.hidden = !(offlineReady === false && Date.now() - bootedAt > 6000);
}

// Re-asked a few times after start, so a first visit clears its own warning.
function watchOfflineReady() {
  [1500, 7000, 14000, 30000].forEach(ms => setTimeout(() => {
    if (offlineReady !== true) renderOfflineStatus();
  }, ms));
}

async function boot() {
  await checkStorage();
  keepStorage().then(renderOfflineStatus);

  try {
    const draft = await store.get(DRAFT_ID);
    if (draft) {
      state = stateFromRecord(draft);
      if (!state.thresholds) state.thresholds = deepCopy(DEFAULT_THRESHOLDS);
      // A draft left over from a previous day starts fresh, keeping the
      // settings and rolling the tank levels into the Yesterday boxes.
      if (draft.date !== todayISO() && !location.search.includes('keep')) {
        const hadReadings = Object.values(state.values || {})
          .some(v => v && (v.inUse !== undefined && v.inUse !== ''));
        const carriedStock = hadReadings ? carryStockForward(state.values) : {};
        const carriedDates = carryDatesForward(state.values);
        state = {
          ...blankState(), ...carriedSettings(),
          values: { ...defaultValues(), ...carriedStock, ...carriedDates },
          lastCheckDate: hadReadings ? draft.date : (draft.lastCheckDate || null),
          lastReadingTime: hadReadings
            ? (draft.readingTime || DEFAULT_READING_TIME)
            : (draft.lastReadingTime || DEFAULT_READING_TIME),
          readingTime: draft.readingTime || DEFAULT_READING_TIME,
          id: DRAFT_ID
        };
      }
    }
  } catch (err) {
    console.error('could not load draft', err);
  }

  if (!state.reporter) state.reporter = DEFAULT_REPORTER;
  if (!state.site) state.site = DEFAULT_SITE;
  // Takes new shipped limits, repairs any that an older version never saved,
  // and leaves hand-typed numbers untouched.
  applyThresholdRefresh();

  try {
    // The recorded readings have to be in storage before anything reads back
    // from it. Seeding used to run after, so on a first launch there was
    // nothing to find: the Yesterday boxes stayed blank and the last-check
    // date stayed unset, which left the dosing period empty.
    await seedHistoricReports();
    await loadDosingLog();
    if (!dosingEvents.length) {
      // The times recorded on paper for those first weeks.
      dosingEvents = HISTORIC_DOSING_LOG.slice();
      await saveDosingLog();
    }
    await loadMeterLog();
    await seedMeterLog();
    await pruneOldReports();
    await seedYesterdayFromHistory();
    previousReport = await findPreviousReport();
    submittedReports = await loadSubmittedReports();
  } catch (err) {
    console.error('could not load the previous report', err);
  }
  await loadBackupInfo();

  /* Drawing the screen comes last, and any one failure here used to leave
     nothing on screen at all - a blank page with no hint of what went wrong,
     and no way to reach the data. Each step is now separate: one failing step
     loses its own piece of the screen rather than the whole app. */
  const steps = [
    ['fill the fields', hydrateFields],
    ['show the version', showBuildId],
    ['wire the buttons', bindShell],
    ['wire the checklist', bindChecklist],
    ['wire the trigger levels', bindThresholds],
    ['wire the logo', bindLogo],
    ['show the logo', renderLogo],
    ['wire the dosing card', bindDosing],
    ['show the dosing card', renderDosing],
    ['wire the meter list', bindMeterLog],
    ['show the meter list', renderMeterLog],
    ['wire the backup buttons', bindBackup],
    ['show when the last backup was', renderBackupStatus],
    ['draw the checklist', render],
    ['show the trigger levels', renderThresholds],
    ['size the top bar', syncTopbarHeight]
  ];
  const broken = [];
  steps.forEach(([what, fn]) => {
    try {
      fn();
    } catch (err) {
      console.error(`could not ${what}`, err);
      broken.push(what);
    }
  });
  if (broken.length) showStartupProblem(broken.join(', '));

  renderOfflineStatus();
  watchOfflineReady();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      swReg = reg;
      // Ask the server on every start. Closing and reopening the app is not
      // enough on its own: without this the worker already on the phone keeps
      // serving its cached copy and a new upload can go unnoticed for hours.
      reg.update().catch(() => {});
    }).catch(() => {});

    /* A new worker taking over means new files, so reload once to keep the
       screen and the code it runs in step.

       Only when a worker was already in charge when the page opened. On a
       first visit the worker takes over a page that had none, and reloading
       then is pointless churn - and if anything goes wrong in start-up it
       turns into a reload loop, which looks exactly like a blank page. */
    const hadController = !!navigator.serviceWorker.controller;
    if (typeof navigator.serviceWorker.addEventListener === 'function') {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (swReloading || !hadController) return;
        swReloading = true;
        if (typeof location.reload === 'function') location.reload();
      });
    }
  }
}

/* Nothing may reach the operator as a blank page.

   An error thrown outside boot() - a syntax error in a later file, a failed
   module, anything - would otherwise leave an empty screen with no reason
   given and no way to reach the readings. */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('error', (e) => {
    console.error('unhandled error', e && (e.error || e.message));
    if (typeof showStartupProblem === 'function') showStartupProblem('');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('unhandled rejection', e && e.reason);
  });

  // Turning the phone changes the top bar's height, and the sticky headers
  // below it have to follow.
  window.addEventListener('resize', syncTopbarHeight);
  window.addEventListener('orientationchange', syncTopbarHeight);
}

// Guarded so the module can be loaded in a test harness without a DOM.
if (typeof document !== 'undefined') {
  boot().catch(err => {
    console.error('the app could not start', err);
    showStartupProblem('start up');
  });
}
