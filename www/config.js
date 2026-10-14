/* ------------------------------------------------------------------
   Daily Operations Report - checklist definition and thresholds
   ------------------------------------------------------------------
   Item types:
     status  - tap one of OK / WATCH / FAULT / NOT DONE
     choice  - tap one named option, each mapped to a status
     number  - single numeric reading, auto-graded
     multi   - several small readings on one line; each reading can have
               its own trigger levels
     stock   - tank levels: last check / delivered since / now
     date    - "sampled up to" date, recorded without grading
   ------------------------------------------------------------------ */

const STATUS = {
  OK: 'ok',
  WATCH: 'watch',
  FAULT: 'fault',
  TODO: 'todo',
  BLANK: 'blank'
};

const STATUS_META = {
  ok:    { label: 'OK',       short: 'OK',    colour: [34, 139, 79],   wa: '\u2705' },
  watch: { label: 'Monitor',  short: 'WATCH', colour: [201, 138, 4],   wa: '\u26A0\uFE0F' },
  fault: { label: 'Fault',    short: 'FAULT', colour: [190, 44, 44],   wa: '\u274C' },
  todo:  { label: 'Not done', short: 'TODO',  colour: [110, 118, 129], wa: '\u2B1C' },
  blank: { label: 'Not set',  short: '-',     colour: [160, 167, 175], wa: '\u2B1C' }
};

/* Every IBC on site holds this much. */
const IBC_LITRES = 1000;

const DEFAULT_REPORTER = 'HAFIZ SHAKEEB ARSLAN';
const DEFAULT_SITE = 'AUSTRALIAN TALLOW PRODUCERS';
const DEFAULT_PREFIX = 'ATP-DOR';

/* How many days of submitted reports the average usage looks back over.
   Adjustable in Settings. */
const DEFAULT_AVG_WINDOW = 14;

/* The time of the morning walk, used when a report does not carry one. */
const DEFAULT_READING_TIME = '08:00';

/* A chemical's usage tank being completely empty is always a fault, whatever
   the backup situation, so it needs no adjustable trigger. */
const EMPTY_TANK = 0;

/* Adjustable trigger levels. Readings without an entry here are not graded
   automatically and rely on the operator's own OK / Fault choice. */
const DEFAULT_THRESHOLDS = {
  ph1:         { critLow: 4.9, warnLow: 5.0, warnHigh: 5.5, critHigh: 5.6 },
  ph2:         { critLow: 6.0, warnLow: 6.1, warnHigh: 6.5, critHigh: 6.7 },
  ph3:         { critLow: 6.0, warnLow: 6.1, warnHigh: 7.8, critHigh: 8.0 },
  /* The four delivered chemicals are judged in days, not litres, once the app
     has the history to know how fast each one goes - one set of litre levels
     treated a chemical that lasts two weeks like one that lasts two days.
     chemDays is the whole stock on site (time to order); chemTankDays is the
     usage tank alone at the rate it empties while dosing (time to refill). */
  chemDays:    { crit: 3,   warn: 7 },
  chemTankDays:{ crit: 1,   warn: 2 },
  // Litre levels: what the chemicals are judged on until that history exists.
  chemInUse:   { crit: 300, warn: 500 },
  chemBackup:  { crit: 0,   warn: 300 },
  boilerChem:  { crit: 50,  warn: 100 },
  saturator:   { critLow: 500, warnLow: 550, warnHigh: 600, critHigh: 650 },
  flow:        { critLow: 17, warnLow: 18, warnHigh: 20, critHigh: 21 }
};

/* Bumped whenever the numbers above change.

   Trigger levels live inside the saved draft, so a phone that already ran an
   older build keeps whatever that build shipped and never sees a new default.
   The stamp lets boot() tell "these are just the old shipped numbers" apart
   from "the operator typed these", and only the former gets replaced. */
const THRESHOLD_VERSION = 2;

/* Plain-language names for the Settings screen. */
const TH_LABELS = {
  ph1:         'pH reading 1',
  ph2:         'pH reading 2',
  ph3:         'pH reading 3',
  chemDays:    'Chemical stock on site - days left (time to order)',
  chemTankDays:'Chemical usage tank - days of dosing left (time to refill)',
  chemInUse:   'Chemical usage tank, litres - only until there is enough history',
  chemBackup:  'Chemical backup stock, litres - only until there is enough history',
  boilerChem:  'Boiler chemical (L)',
  saturator:   'Saturator pressure (kPa)',
  flow:        'Flow rate (m3/h)'
};

/* Takes whatever thresholds were saved previously and returns a complete set.

   Reports saved by an older version are missing any limit added since, and a
   missing limit used to bring the whole report down. Every group and key from
   the defaults is guaranteed to exist here, keeping the operator's own numbers
   wherever they are still valid. */
function mergeThresholds(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
  if (!saved || typeof saved !== 'object') return out;
  Object.keys(out).forEach(group => {
    const savedGroup = saved[group];
    if (!savedGroup || typeof savedGroup !== 'object') return;
    Object.keys(out[group]).forEach(key => {
      const v = Number(savedGroup[key]);
      if (isFinite(v)) out[group][key] = v;
    });
  });
  return out;
}

/* Works out which trigger levels to run after the app updates.

   Takes the saved draft (or anything carrying `thresholds`, `thVersion` and
   `thEdited`) and returns the set to use plus the stamps to store back.

   Shipped numbers that the operator never touched are replaced by the new
   defaults. Anything hand-typed is kept exactly as entered and only has
   genuinely missing limits filled in. */
function refreshThresholds(saved) {
  const hand = !!saved && saved.thEdited === true;
  const stale = !saved || Number(saved.thVersion) !== THRESHOLD_VERSION;
  if (!hand && stale) {
    return {
      thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
      thVersion: THRESHOLD_VERSION,
      thEdited: false,
      replaced: true
    };
  }
  return {
    thresholds: mergeThresholds(saved && saved.thresholds),
    thVersion: THRESHOLD_VERSION,
    thEdited: hand,
    replaced: false
  };
}

/* Reusable option sets ------------------------------------------------ */

const OK_FAULT_OPTIONS = [
  { value: 'ok',    label: 'OK',    status: STATUS.OK },
  { value: 'fault', label: 'Fault', status: STATUS.FAULT }
];

// For "is it overflowing?" style questions, where No is the good answer.
const YES_NO_OPTIONS = [
  { value: 'no',  label: 'No',  status: STATUS.OK },
  { value: 'yes', label: 'Yes', status: STATUS.FAULT }
];

const DONE_OPTIONS = [
  { value: 'done',    label: 'Done',     status: STATUS.OK },
  { value: 'notdone', label: 'Not done', status: STATUS.TODO }
];

// Standard wastewater clarity descriptors.
//
// "Not running" is for the days the DAF is stopped, so there is no effluent to
// judge. That is not a problem, so it is green - and it has no badge of its
// own, so the report prints "Not running" beside the tick rather than
// replacing the tick's wording. It sits beside "Clear" so the two green
// answers are together and the ones that need attention follow.
const CLARITY_OPTIONS = [
  { value: 'clear',      label: 'Clear',           status: STATUS.OK },
  { value: 'notrunning', label: 'Not running',     status: STATUS.OK },
  { value: 'slight',     label: 'Slightly turbid', status: STATUS.WATCH },
  { value: 'turbid',     label: 'Turbid',          status: STATUS.FAULT },
  { value: 'offline',    label: 'Out of service',  status: STATUS.FAULT }
];

// Housekeeping grades for the underpits.
const CLEANLINESS_OPTIONS = [
  { value: 'clean',   label: 'Clean',         status: STATUS.OK },
  { value: 'minor',   label: 'Minor residue', status: STATUS.OK },
  { value: 'heavy',   label: 'Heavy residue', status: STATUS.WATCH },
  { value: 'notdone', label: 'Not cleaned',   status: STATUS.FAULT }
];

const PAPERWORK_OPTIONS = [
  // "Fault" is wrong for a paperwork job, so this option names the action.
  { value: 'updated', label: 'Updated',         status: STATUS.OK },
  { value: 'prints',  label: 'Need new prints', status: STATUS.FAULT, badge: 'NEED PRINTS' }
];

/* Is the plant turning over? "Not running" is kept apart from "Fault" because
   the two call for different replies: one may be a planned stop, the other is
   a breakdown. Both still need reporting, so both come out red. */
const RUNNING_OPTIONS = [
  { value: 'running',    label: 'Running',     status: STATUS.OK },
  { value: 'notrunning', label: 'Not running', status: STATUS.FAULT, badge: 'NOT RUNNING' },
  { value: 'fault',      label: 'Fault',       status: STATUS.FAULT },
  // "Not done" reads oddly for a reading, so this says what actually happened.
  { value: 'notchecked', label: 'Not checked', status: STATUS.TODO }
];

/* Is the reading where it should be? Drifting either way is worth watching
   rather than treating as a breakdown, so those two are amber. */
const TARGET_OPTIONS = [
  { value: 'within',     label: 'Within target', status: STATUS.OK },
  { value: 'above',      label: 'Above target',  status: STATUS.WATCH, badge: 'ABOVE TARGET' },
  { value: 'below',      label: 'Below target',  status: STATUS.WATCH, badge: 'BELOW TARGET' },
  { value: 'fault',      label: 'Fault',         status: STATUS.FAULT },
  { value: 'notchecked', label: 'Not checked',   status: STATUS.TODO }
];

/* ------------------------------------------------------------------
   The checklist
   ------------------------------------------------------------------ */
const CHECKLIST = [
  {
    id: 'leighton',
    owner: 'Leighton Black',
    groups: [
      {
        id: 'biofilters',
        title: 'Biofilters',
        items: [
          { id: 'bio_running', label: 'System running', type: 'choice', options: RUNNING_OPTIONS,
            default: { choice: 'running' } },
          { id: 'bio_target',  label: 'Within target',  type: 'choice', options: TARGET_OPTIONS,
            default: { choice: 'within' } },
          { id: 'bio_vacuum',  label: 'Vacuum gauge',   type: 'status', default: { status: STATUS.OK } },
          { id: 'bio1_rh',     label: 'Bio 1 humidity', type: 'choice', options: OK_FAULT_OPTIONS,
            default: { choice: 'fault' } },
          { id: 'bio2_rh',     label: 'Bio 2 humidity', type: 'choice', options: OK_FAULT_OPTIONS,
            default: { choice: 'fault' } }
        ]
      },
      {
        id: 'chemicals',
        title: 'Chemical Levels',
        note: 'last check carries over automatically',
        items: [
          { id: 'caustic',    label: 'Caustic 46%',        type: 'stock', unit: 'L', hasBackup: true, topUp: 'ibc' },
          { id: 'coagulant',  label: 'Coagulant 720',      type: 'stock', unit: 'L', hasBackup: true, topUp: 'ibc' },
          { id: 'flocculant', label: 'Flocculant 7686',    type: 'stock', unit: 'L', hasBackup: true, topUp: 'ibc' },
          { id: 'sulphuric',  label: 'Sulphuric Acid 73%', type: 'stock', unit: 'L', hasBackup: true, topUp: 'ibc' }
        ]
      },
      {
        id: 'wwtp',
        title: 'Waste Water Treatment Plant',
        items: [
          { id: 'daf_pumps',   label: 'DAF sludge pumps', type: 'status', default: { status: STATUS.OK } },
          { id: 'daf_paddles', label: 'DAF paddles',      type: 'status', default: { status: STATUS.OK } },
          { id: 'daf_clarity', label: 'DAF effluent clarity', type: 'choice', options: CLARITY_OPTIONS,
            default: { choice: 'clear' } },
          { id: 'daf_overflow', label: 'DAF overflow', type: 'choice', options: YES_NO_OPTIONS,
            default: { choice: 'no' } },
          { id: 'waste_tanks', label: 'Waste Tanks - Overflow', type: 'choice', options: YES_NO_OPTIONS,
            default: { choice: 'no' } },
          // No starting value: the pressure is different every morning, and a
          // made-up 500 sat exactly on the fault level, so both saturators
          // opened as a fault before anyone had looked at them.
          { id: 'sat1', label: 'Saturator DAF 1', type: 'number', unit: 'kPa', threshold: 'saturator',
            decimals: 0 },
          { id: 'sat2', label: 'Saturator DAF 2', type: 'number', unit: 'kPa', threshold: 'saturator',
            decimals: 0 },
          {
            // Each reading comes off a different point, so each has its own limits.
            id: 'ph', label: 'pH readings', type: 'multi',
            decimals: 1, display: 'slash', inputWidth: 'narrow',
            fields: [
              { key: 'a', label: '1', threshold: 'ph1' },
              { key: 'b', label: '2', threshold: 'ph2' },
              { key: 'c', label: '3', threshold: 'ph3' }
            ]
          },
          { id: 'tank1_mixer', label: 'Tank 1 mixer', type: 'status', default: { status: STATUS.OK } },
          { id: 'floc_mixer',  label: 'Flocculant mixer adjusted', type: 'status', default: { status: STATUS.OK } },
          { id: 'flow_rate',   label: 'Flow rate', type: 'number', unit: 'm3/h', threshold: 'flow',
            decimals: 1, default: { value: 19.9 } }
        ]
      }
    ]
  },
  {
    id: 'hafiz',
    owner: 'Hafiz Sarosh',
    groups: [
      {
        id: 'pits',
        title: 'Pit Pumps & Cleaning',
        items: [
          { id: 'pit_pump', label: 'Pit Pump', type: 'status', default: { status: STATUS.OK } },
          { id: 'lamb_pit', label: 'Lamb underpit', type: 'choice', options: CLEANLINESS_OPTIONS,
            default: { choice: 'minor' } },
          { id: 'beef_pit', label: 'Beef underpit', type: 'choice', options: CLEANLINESS_OPTIONS,
            default: { choice: 'minor' } }
        ]
      },
      {
        id: 'ducting',
        title: 'Production Fume Ducting',
        note: 'checking for steaming',
        items: [
          { id: 'duct_lamb_cooker', label: 'Lamb cooker', type: 'status', hint: 'OK = no steaming',
            default: { status: STATUS.OK } },
          { id: 'duct_beef_cooker', label: 'Beef cooker', type: 'status', hint: 'OK = no steaming',
            default: { status: STATUS.OK } },
          { id: 'duct_beef_press',  label: 'Beef press',  type: 'status', hint: 'OK = no steaming',
            default: { status: STATUS.OK } },
          { id: 'duct_drier1',      label: 'Drier 1',     type: 'status', hint: 'OK = no steaming',
            default: { status: STATUS.OK } },
          { id: 'duct_drier2',      label: 'Drier 2',     type: 'status', hint: 'OK = no steaming',
            default: { status: STATUS.OK } },
          { id: 'duct_drier3',      label: 'Drier 3',     type: 'status', hint: 'OK = no steaming',
            default: { status: STATUS.OK } }
        ]
      },
      {
        id: 'boilers',
        title: 'Boilers',
        note: 'last check carries over automatically',
        items: [
          { id: 'boiler1_chem', label: 'Boiler 1 chemical', type: 'stock', unit: 'L',
            hasBackup: false, topUp: 'litres', threshold: 'boilerChem', compact: true },
          { id: 'boiler2_chem', label: 'Boiler 2 chemical', type: 'stock', unit: 'L',
            hasBackup: false, topUp: 'litres', threshold: 'boilerChem', compact: true },
          { id: 'blowdown',   label: 'Blowdown',      type: 'choice', options: DONE_OPTIONS,
            default: { choice: 'done' } },
          { id: 'water_test', label: 'Water testing', type: 'choice', options: DONE_OPTIONS,
            default: { choice: 'done' } }
        ]
      },
      {
        id: 'samples',
        title: 'Sample Testing',
        items: [
          { id: 'ovine_daily',  label: 'Ovine Daily',  type: 'date' },
          { id: 'mbm_weekly',   label: 'MBM Weekly',   type: 'date' },
          { id: 'ovine_weekly', label: 'Ovine Weekly', type: 'date' },
          { id: 'ovine_bags',   label: 'Ovine bag paperwork', type: 'choice', options: PAPERWORK_OPTIONS,
            default: { choice: 'updated' } },
          {
            id: 'separators', label: 'Separator testing', type: 'multi',
            decimals: 0, display: 'labelled', unit: 'samples',
            fields: [
              { key: 'tallow', label: 'Tallow' },
              { key: 'stick',  label: 'Stick water' }
            ]
          }
        ]
      }
    ]
  }
];

/* Section and group numbering, e.g. 1, then 1.1, 1.2 ... */
CHECKLIST.forEach((section, si) => {
  section.number = String(si + 1);
  section.title = section.owner;
  section.groups.forEach((group, gi) => {
    group.number = `${si + 1}.${gi + 1}`;
  });
});

/* Flat lookup so the rest of the app can resolve an item by id. */
const ITEM_INDEX = (() => {
  const map = {};
  CHECKLIST.forEach(section => {
    section.groups.forEach(group => {
      group.items.forEach(item => {
        map[item.id] = {
          ...item,
          sectionId: section.id, owner: section.owner,
          groupTitle: group.title, groupNumber: group.number
        };
      });
    });
  });
  return map;
})();

/* The four chemicals, for the stock summary table. */
function chemicalItems() {
  return Object.values(ITEM_INDEX).filter(i => i.type === 'stock' && i.topUp === 'ibc');
}

/* ------------------------------------------------------------------
   Numbers
   ------------------------------------------------------------------ */

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/* 2900 -> "2,900" */
function fmtQty(n, decimals) {
  if (n === null || n === undefined) return '-';
  const v = Number(n);
  if (!isFinite(v)) return '-';
  const dp = decimals !== undefined ? decimals : (Number.isInteger(v) ? 0 : 1);
  const fixed = Math.abs(v).toFixed(dp);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

/* ------------------------------------------------------------------
   Grading
   ------------------------------------------------------------------ */

function gradeNumber(value, thresholdKey, thresholds) {
  const n = num(value);
  if (n === null) return STATUS.BLANK;
  const t = thresholds[thresholdKey];
  if (!t) return STATUS.OK;

  if (t.critLow !== undefined) {
    if (n <= t.critLow || n >= t.critHigh) return STATUS.FAULT;
    if (n <= t.warnLow || n >= t.warnHigh) return STATUS.WATCH;
    return STATUS.OK;
  }
  if (t.crit !== undefined) {
    if (n <= t.crit) return STATUS.FAULT;
    if (n <= t.warn) return STATUS.WATCH;
    return STATUS.OK;
  }
  return STATUS.OK;
}

function gradeChoice(item, value) {
  if (!value) return STATUS.BLANK;
  const opt = (item.options || []).find(o => o.value === value);
  return opt ? opt.status : STATUS.BLANK;
}

function choiceLabel(item, value) {
  const opt = (item.options || []).find(o => o.value === value);
  return opt ? opt.label : '';
}

/* Wording for the badge when an option overrides the plain status word. */
function optionBadge(item, value) {
  const opt = (item.options || []).find(o => o.value === value);
  return opt && opt.badge ? opt.badge : null;
}

/* Each field may name its own threshold; the worst one wins for the row. */
function gradeMulti(item, values, thresholds) {
  const grades = [];
  let any = false;
  (item.fields || []).forEach(f => {
    const n = num(values && values[f.key]);
    if (n === null) return;
    any = true;
    const key = f.threshold || item.threshold;
    if (key) grades.push(gradeNumber(n, key, thresholds));
  });
  if (!any) return STATUS.BLANK;
  return grades.length ? worstOf(grades) : STATUS.OK;
}

/* Chemical tanks are judged purely on their levels, using the trigger levels
   in Settings. How many days of stock remain is reported as information but
   never changes the status. */
function gradeChemical(v, thresholds) {
  const inUse = num(v.inUse);
  const backup = num(v.backup);
  const grades = [];
  if (inUse !== null) grades.push(gradeNumber(inUse, 'chemInUse', thresholds));
  if (backup !== null) grades.push(gradeNumber(backup, 'chemBackup', thresholds));
  return grades.length ? worstOf(grades) : STATUS.BLANK;
}

const SEVERITY_ORDER = [STATUS.OK, STATUS.BLANK, STATUS.TODO, STATUS.WATCH, STATUS.FAULT];

function worstOf(list) {
  let worst = STATUS.OK;
  list.forEach(s => {
    if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst)) worst = s;
  });
  return worst;
}

function needsAction(status) {
  return status === STATUS.FAULT || status === STATUS.WATCH || status === STATUS.TODO;
}

/* ------------------------------------------------------------------
   Stock movement
   ------------------------------------------------------------------
   A delivered IBC is placed beside the backup stock straight away, so it is
   already inside the backup figure read at the next check:

     used = last check total + delivered since - total now

   Refilling the usage tank from a backup IBC moves stock between the two
   boxes without changing the total, so it needs no recording at all.
   ------------------------------------------------------------------ */

function stockUsage(item, v, gapDays) {
  if (!v) return null;
  const pIn = num(v.prevInUse);
  const pBack = item.hasBackup ? num(v.prevBackup) : null;
  const tIn = num(v.inUse);
  const tBack = item.hasBackup ? num(v.backup) : null;

  if (pIn === null && pBack === null) return null;
  if (tIn === null && tBack === null) return null;

  const prevTotal = (pIn || 0) + (pBack || 0);
  const todayTotal = (tIn || 0) + (tBack || 0);

  const ibcs = item.topUp === 'ibc' ? (num(v.ibc) || 0) : 0;
  const topUp = item.topUp === 'ibc' ? ibcs * IBC_LITRES : (num(v.added) || 0);

  const days = gapDays && gapDays > 0 ? gapDays : 1;
  const used = prevTotal + topUp - todayTotal;

  // Stock cannot rise on its own, so an unexplained rise means a delivery
  // was not recorded. Whole IBCs only, so the shortfall can be named.
  const rise = todayTotal - (prevTotal + topUp);
  // Chemicals arrive as whole IBCs, so the shortfall can be named in IBCs.
  // Boiler tanks are topped up by the litre, so it stays in litres.
  const missingIbcs = rise > 0 && item.topUp === 'ibc' ? Math.ceil(rise / IBC_LITRES) : 0;
  const missingLitres = rise > 0 ? rise : 0;

  return {
    used, topUp, ibcs, prevTotal, todayTotal, days,
    perDay: used > 0 ? used / days : 0,
    missingIbcs, missingLitres,
    unconfirmed: !!v.unknownDelivery
  };
}

function stockOnHand(item, v) {
  const tIn = num(v && v.inUse);
  const tBack = item.hasBackup ? num(v && v.backup) : null;
  if (tIn === null && tBack === null) return null;
  return (tIn || 0) + (tBack || 0);
}

/* Days of stock left at the current rate.

   Reported for information only - it never sets a status. Tank levels alone
   decide whether something is flagged. */
function daysOfStock(item, usage) {
  if (!item || item.topUp !== 'ibc') return null;
  if (!usage || usage.unconfirmed || usage.perDay <= 0) return null;
  return usage.todayTotal / usage.perDay;
}

/* Wording for the badge. "Fault" is right for a broken pump but not for a
   tank that simply needs topping up or reordering. */
function stockBadge(item, status, reason) {
  if (!needsAction(status)) return STATUS_META[status].short;
  // Boiler dose tanks are mixed and topped up in house, so they are only ever
  // a refill job - never a reorder.
  if (item && item.topUp === 'litres') return 'REFILL';
  // For the delivered chemicals, no backup left is the more serious problem,
  // so that is the action named.
  if (/no backup stock|backup very low/.test(reason)) return 'REORDER';
  if (/usage tank/.test(reason)) return 'REFILL';
  if (status === STATUS.FAULT) return 'REORDER';
  if (status === STATUS.WATCH) return 'LOW';
  return STATUS_META[status].short;
}

/* The starting point for a new report: the states that are true on a normal
   day, so only the exceptions have to be touched. */
function defaultValues() {
  const out = {};
  Object.values(ITEM_INDEX).forEach(item => {
    if (!item.default) return;
    out[item.id] = { ...item.default, photos: [] };
  });
  return out;
}

/* ------------------------------------------------------------------
   DAF running log
   ------------------------------------------------------------------
   The plant does not run around the clock: it starts Monday afternoon and
   stops Friday evening, with the odd shutdown in between. Chemical use
   therefore has to be measured per hour the DAF actually ran, not per
   calendar day - otherwise a weekend makes it look as though usage halved.

   Each event is { at: 'YYYY-MM-DDTHH:MM', on: true|false }.
   ------------------------------------------------------------------ */

function readingStamp(dateISO, time) {
  return `${dateISO}T${time || DEFAULT_READING_TIME}`;
}

function toMs(stamp) {
  if (!stamp) return null;
  const t = new Date(stamp.length <= 10 ? stamp + 'T' + DEFAULT_READING_TIME : stamp).getTime();
  return isFinite(t) ? t : null;
}

/* Turns the event list into the periods the DAF was actually on. */
function dosingIntervals(events) {
  const list = (events || [])
    .filter(e => e && e.at)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (!list.length) return [];

  const out = [];
  // If the first thing recorded is a shutdown, it must have been running before.
  let openedAt = list[0].on === false ? -Infinity : null;

  list.forEach(e => {
    const t = toMs(e.at);
    if (t === null) return;
    if (e.on) {
      if (openedAt === null) openedAt = t;        // ignore a second "started"
    } else if (openedAt !== null) {
      out.push([openedAt, t]);
      openedAt = null;
    }
  });
  if (openedAt !== null) out.push([openedAt, Infinity]);
  return out;
}

/* Hours the DAF ran between two moments. */
function dosingHoursBetween(events, fromStamp, toStamp) {
  const a = toMs(fromStamp), b = toMs(toStamp);
  if (a === null || b === null || b <= a) return 0;
  let total = 0;
  dosingIntervals(events).forEach(([s, e]) => {
    const lo = Math.max(s, a), hi = Math.min(e, b);
    if (hi > lo) total += (hi - lo) / 3600000;
  });
  return Math.round(total * 100) / 100;
}

/* Is the DAF running as things stand? */
function dosingOnNow(events, nowStamp) {
  const now = nowStamp ? toMs(nowStamp) : Date.now();
  return dosingIntervals(events).some(([s, e]) => now >= s && now < e);
}

/* Water that passed through the DAF while the chemicals were dosing.

   Exact whenever the meter is known at both ends of a dosing stretch - which
   is automatic when dosing ran for the whole period between two readings.
   Otherwise the dosing hours are multiplied by the flow rate measured from
   those exact periods, and the result is marked as an estimate. */
function dosedWater(fromStamp, toStamp, fromMeter, toMeter, events, flowRate, meterLog) {
  const a = toMs(fromStamp), b = toMs(toStamp);
  if (a === null || b === null || b <= a) return null;

  // Moments where the meter is actually known.
  const known = [];
  if (num(fromMeter) !== null) known.push({ t: a, m: num(fromMeter) });
  if (num(toMeter) !== null) known.push({ t: b, m: num(toMeter) });
  (events || []).forEach(e => {
    const t = toMs(e.at);
    if (t !== null && num(e.meter) !== null && t >= a && t <= b) {
      known.push({ t, m: num(e.meter) });
    }
  });
  // A reading noted in the meter log counts the same as one noted at a switch,
  // so a mid-period reading makes that stretch exact rather than estimated.
  meterSorted(meterLog).forEach(e => {
    const t = toMs(e.at);
    if (t !== null && t >= a && t <= b) known.push({ t, m: num(e.value) });
  });
  const meterAt = (t) => {
    const hit = known.find(k => k.t === t);
    return hit ? hit.m : null;
  };

  let volume = 0;
  let exact = true;
  let hours = 0;

  dosingIntervals(events).forEach(([s, e]) => {
    const lo = Math.max(s, a), hi = Math.min(e, b);
    if (hi <= lo) return;
    hours += (hi - lo) / 3600000;
    const ms = meterAt(lo), me = meterAt(hi);
    if (ms !== null && me !== null && me >= ms) {
      volume += me - ms;
    } else if (flowRate && flowRate > 0) {
      volume += ((hi - lo) / 3600000) * flowRate;
      exact = false;
    } else {
      exact = false;
    }
  });

  if (hours <= 0) return { volume: 0, exact: true, hours: 0 };
  return { volume: Math.round(volume * 10) / 10, exact, hours: Math.round(hours * 100) / 100 };
}

/* Flow rate while dosing, measured only from periods where dosing covered the
   whole gap and both meter readings are known. Those are exact, so they are
   the only trustworthy basis for filling in the gaps. */
function dosingFlowRate(reports, events, meterLog) {
  const days = flowRateDays(reports, events, meterLog);
  let water = 0, hours = 0;
  days.forEach(d => { water += d.water; hours += d.hours; });
  return hours > 0 ? water / hours : null;
}

/* The days the flow rate is measured from: those where dosing covered the
   whole period between two readings, so the meter difference is exactly the
   water that was dosed. */
function flowRateDays(reports, events, meterLog) {
  return flowRateCandidates(reports, events, meterLog).filter(d => d.counted);
}

/* Every period that was considered, with the reason any of them was left out.

   The speed is an average over past days, and the number on its own gives no
   clue which days went into it. When the figure looks wrong the cause is
   almost always a period that silently stopped qualifying - a dosing entry
   added in the middle of it, or a deleted report - and without this there is
   no way to see that from inside the app. */
function flowRateCandidates(reports, events, meterLog) {
  return (reports || []).map(r => {
    const row = { date: r.date, water: null, hours: null, gap: null, counted: false, why: '' };
    if (!r.date) { row.why = 'no date'; return row; }
    if (!r.lastCheckDate) { row.why = 'no previous check recorded'; return row; }

    const { meter, prevMeter } = meterForReport(r, meterLog);
    const from = readingStamp(r.lastCheckDate, r.lastReadingTime || DEFAULT_READING_TIME);
    const to = readingStamp(r.date, r.readingTime || DEFAULT_READING_TIME);
    row.gap = Math.round(((toMs(to) - toMs(from)) / 3600000) * 100) / 100;
    row.hours = dosingHoursBetween(events, from, to);

    if (meter === null || prevMeter === null) {
      row.why = 'meter reading missing';
      return row;
    }
    row.water = Math.round((meter - prevMeter) * 10) / 10;
    if (row.gap <= 0) { row.why = 'period has no length'; return row; }
    if (row.water < 0) { row.why = 'meter went backwards'; return row; }
    if (Math.abs(row.hours - row.gap) > 0.02) {
      row.why = `dosing on ${fmtQty(row.hours, 1)} of ${fmtQty(row.gap, 1)} hrs`;
      return row;
    }
    row.counted = true;
    return row;
  });
}

function dosingFlowDays(reports, events, meterLog) {
  return flowRateDays(reports, events, meterLog).length;
}

function dosingLastEvent(events) {
  const list = (events || []).filter(e => e && e.at).slice()
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  return list.length ? list[list.length - 1] : null;
}

/* ------------------------------------------------------------------
   Readings recorded by hand before the app existed
   ------------------------------------------------------------------
   Each entry is a morning reading: [usage tank level, backup level].
   Loaded once on first run so the average usage is right from day one.
   ------------------------------------------------------------------ */

const HISTORIC_READINGS = [
  // date,        caustic,        coagulant,       flocculant,    acid,          DAF meter (m3)
  { date: '2026-09-11', caustic: [1000, 500],  coagulant: [600, 2000],  flocculant: [950, 50], sulphuric: [700, 0],    meter: 219656.9 },
  { date: '2026-09-14', caustic: [800, 500],   coagulant: [600, 2000],  flocculant: [950, 50], sulphuric: [600, 0],    meter: 220148.4 },
  { date: '2026-09-15', caustic: [800, 500],   coagulant: [600, 2000],  flocculant: [950, 50], sulphuric: [600, 0],    meter: 220210.6 },
  { date: '2026-09-16', caustic: [900, 2000],  coagulant: [400, 2000],  flocculant: [850, 50], sulphuric: [900, 1000], meter: 220582.7 },
  { date: '2026-09-17', caustic: [500, 1000],  coagulant: [400, 2000],  flocculant: [800, 50], sulphuric: [500, 1000], meter: 220878.3 },
  { date: '2026-09-21', caustic: [1000, 0],    coagulant: [150, 2000],  flocculant: [700, 50], sulphuric: [1000, 0],   meter: 221837.7 },
  { date: '2026-09-22', caustic: [600, 0],     coagulant: [1000, 1000], flocculant: [600, 50], sulphuric: [400, 0],    meter: 222148.0 },
  { date: '2026-09-23', caustic: [200, 0],     coagulant: [800, 1000],  flocculant: [600, 50], sulphuric: [50, 0],     meter: 222455.2 },
  { date: '2026-09-24', caustic: [500, 200],   coagulant: [700, 1000],  flocculant: [550, 50], sulphuric: [500, 0],    meter: 222783.5 },
  { date: '2026-09-28', caustic: [250, 200],   coagulant: [700, 1000],  flocculant: [500, 50], sulphuric: [200, 0],    meter: 223460.4 },
  { date: '2026-09-29', caustic: [1000, 1000], coagulant: [600, 1000],  flocculant: [480, 50], sulphuric: [550, 1000], meter: 223764.6 },
  { date: '2026-09-30', caustic: [500, 1000],  coagulant: [450, 1000],  flocculant: [480, 50], sulphuric: [1000, 0],   meter: 224148.8 },
  { date: '2026-10-01', caustic: [0, 1000],    coagulant: [400, 1000],  flocculant: [480, 50], sulphuric: [500, 0],    meter: 224481.1 },
  { date: '2026-10-02', caustic: [600, 0],     coagulant: [200, 1000],  flocculant: [350, 50], sulphuric: [0, 0],      meter: 224994.2 }
];

/* IBCs that moved in or out between readings. A negative figure is stock that
   left the site - on 17 Sep one caustic IBC went to another department, which
   is why that day looked like a 1,400 L usage day rather than 400 L. */
const HISTORIC_MOVEMENTS = {
  '2026-09-16': { caustic: 2, sulphuric: 2 },
  '2026-09-17': { caustic: -1 },
  '2026-09-24': { caustic: 1, sulphuric: 1 },
  '2026-09-29': { caustic: 2, sulphuric: 2 }
};

const HISTORIC_NOTE = {
  '2026-09-17': 'One caustic IBC transferred to another department',
  '2026-10-02': 'Acid and caustic ran out, waiting on delivery'
};

const HISTORIC_TAG = 'recorded-by-hand';

/* The span the recorded readings cover. Saving a report inside it replaces
   recorded figures, so the date field warns before letting that happen. */
const RECORDED_FROM = HISTORIC_READINGS[0].date;
const RECORDED_TO = HISTORIC_READINGS[HISTORIC_READINGS.length - 1].date;

/* When the chemical dosing was switched on and off, as recorded on paper.
   The DAF water itself is never switched off, so it is not tracked - the meter
   accounts for the water, and this log says which of it was dosed.

   Note: one shutdown was written down as "19 Sep Friday", but 19 Sep is a
   Saturday. Friday 18 Sep is the reading that makes every day's figures
   consistent, so that is what is used. */
const HISTORIC_DOSING_LOG = [
  { at: '2026-09-11T16:00', on: false },
  { at: '2026-09-15T11:00', on: true },
  { at: '2026-09-18T16:00', on: false },
  { at: '2026-09-21T14:00', on: true },
  { at: '2026-09-24T16:00', on: false },
  { at: '2026-09-28T08:30', on: true },
  { at: '2026-10-02T16:00', on: false }
];

/* The meter readings on their own, as an editable log.

   The readings above are tied to the reports they were taken with, which makes
   a wrong one awkward to correct. This log is the editable copy and the one
   the figures are read from, so a reading typed by mistake can simply be
   removed and entered again. */
function buildHistoricMeterLog() {
  return HISTORIC_READINGS
    .filter(r => num(r.meter) !== null)
    .map(r => ({ at: readingStamp(r.date, DEFAULT_READING_TIME), value: num(r.meter) }));
}

/* Readings sorted oldest first, with anything unusable dropped. */
function meterSorted(log) {
  return (log || [])
    .filter(e => e && e.at && num(e.value) !== null)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/* The reading taken at exactly this moment, if there is one. */
function meterAtStamp(log, stamp) {
  const hit = meterSorted(log).find(e => e.at === stamp);
  return hit ? num(hit.value) : null;
}

/* The newest reading strictly before this moment. Returns the whole entry, so
   the caller can say when it was taken. */
function meterBefore(log, stamp) {
  const list = meterSorted(log).filter(e => e.at < stamp);
  return list.length ? list[list.length - 1] : null;
}

/* The newest reading at or before this moment. */
function meterLatest(log, stamp) {
  const list = stamp ? meterSorted(log).filter(e => e.at <= stamp) : meterSorted(log);
  return list.length ? list[list.length - 1] : null;
}

/* The reading a report measures its water from.

   That is the one taken at the last tank check, because the chemical usage
   covers the same period - or the newest reading before it when none was taken
   that morning. Shared by the screen and the report so the two can never
   disagree about which reading is the basis. */
function meterOpening(log, lastCheckDate, lastReadingTime, nowStamp) {
  const checkStamp = lastCheckDate ? readingStamp(lastCheckDate, lastReadingTime) : null;
  return checkStamp ? meterLatest(log, checkStamp) : meterBefore(log, nowStamp);
}

/* Checks a reading against the ones either side of it.

   The meter only ever counts up, so a reading below the one before it or above
   the one after it is a typing slip. Returns the message to show, or null when
   the reading sits correctly between its neighbours. Shared by every place a
   reading can be entered, so none of them can accept a figure the others
   would have refused. */
function meterConflict(log, at, value) {
  const v = num(value);
  if (v === null) return 'Type the meter reading';
  const before = meterBefore(log, at);
  const after = meterSorted(log).find(e => e.at > at);
  if (before && v < num(before.value)) {
    return `Lower than the ${fmtQty(num(before.value), 1)} reading before it - check the number`;
  }
  if (after && v > num(after.value)) {
    return `Higher than the ${fmtQty(num(after.value), 1)} reading after it - check the number`;
  }
  return null;
}

/* The pair of readings that bracket a report's period.

   The log wins wherever it has a reading, so correcting the log corrects every
   figure that was ever worked out from it. A report saved before the log
   existed still has its own readings, and those are used as the fallback. */
function meterForReport(report, log) {
  if (!report) return { meter: null, prevMeter: null };
  const to = readingStamp(report.date, report.readingTime || DEFAULT_READING_TIME);
  const fromDate = report.lastCheckDate;
  const from = fromDate
    ? readingStamp(fromDate, report.lastReadingTime || DEFAULT_READING_TIME)
    : null;

  let meter = meterAtStamp(log, to);
  if (meter === null) meter = num(report.meter);

  let prevMeter = from ? meterAtStamp(log, from) : null;
  if (prevMeter === null && from) {
    const before = meterBefore(log, to);
    // Only trust a nearby reading if it is the one that opens this period.
    if (before && before.at === from) prevMeter = num(before.value);
  }
  if (prevMeter === null) prevMeter = num(report.prevMeter);

  return { meter, prevMeter };
}

/* Turns those readings into report records the average can read. */
function buildHistoricReports() {
  const chems = ['caustic', 'coagulant', 'flocculant', 'sulphuric'];
  return HISTORIC_READINGS.map((row, i) => {
    const prev = i > 0 ? HISTORIC_READINGS[i - 1] : null;
    const moves = HISTORIC_MOVEMENTS[row.date] || {};
    const values = {};

    chems.forEach(id => {
      const [inUse, backup] = row[id];
      const v = { inUse: String(inUse), backup: String(backup), photos: [] };
      if (prev) {
        v.prevInUse = String(prev[id][0]);
        v.prevBackup = String(prev[id][1]);
      }
      if (moves[id]) v.ibc = String(moves[id]);
      values[id] = v;
    });

    return {
      id: `report-${row.date}`,
      date: row.date,
      lastCheckDate: prev ? prev.date : null,
      meter: row.meter,
      prevMeter: prev ? prev.meter : null,
      lastReadingTime: DEFAULT_READING_TIME,
      values,
      photos: {},
      readingTime: DEFAULT_READING_TIME,
      generalNote: HISTORIC_NOTE[row.date] || '',
      source: HISTORIC_TAG,
      savedAt: new Date(row.date + 'T07:00:00').getTime()
    };
  });
}

/* ------------------------------------------------------------------
   Usage history
   ------------------------------------------------------------------
   Every submitted report already carries its own period: the last-check
   levels, what was delivered, and the levels now. So each report yields one
   usage figure without having to pair reports up.

   Periods that cannot be trusted are skipped - unknown deliveries, or stock
   that rose with nothing recorded - so they cannot distort the average.
   ------------------------------------------------------------------ */

function usageFromReport(item, report, dosingEvents, flowRate, meterLog) {
  if (!report || !report.values) return null;
  const v = report.values[item.id];
  if (!v) return null;
  const gap = daysBetween(report.lastCheckDate, report.date);
  const u = stockUsage(item, v, gap);
  if (!u) return null;
  if (u.unconfirmed || u.missingLitres > 0) return null;
  if (u.used < 0) return null;

  // Chemicals are measured against the water they treated. With no dosing log
  // at all it falls back to calendar days rather than reporting nothing.
  let hours = null, water = null, exactWater = false;
  if (item.topUp === 'ibc' && report.lastCheckDate && (dosingEvents || []).length) {
    const from = readingStamp(report.lastCheckDate, report.lastReadingTime || DEFAULT_READING_TIME);
    const to = readingStamp(report.date, report.readingTime || DEFAULT_READING_TIME);
    hours = dosingHoursBetween(dosingEvents, from, to);
    const m = meterForReport(report, meterLog);
    const w = dosedWater(from, to, m.prevMeter, m.meter, dosingEvents, flowRate, meterLog);
    if (w) { water = w.volume; exactWater = w.exact; }
  }

  return {
    date: report.date, used: u.used, days: u.days,
    hours, water, exactWater,
    perDay: u.used / u.days,
    perHour: hours && hours > 0 ? u.used / hours : null,
    dose: water && water > 0 ? u.used / water : null
  };
}

/* Average usage per day across the window, weighted by days rather than by
   report, so a three-day gap counts for three days. */
function usageStats(item, reports, windowDays, today, dosingEvents, flowRate, meterLog) {
  const window = windowDays > 0 ? windowDays : DEFAULT_AVG_WINDOW;
  const series = [];
  let totalUsed = 0, totalDays = 0, totalHours = 0;
  let hourUsed = 0, waterUsed = 0, totalWater = 0;
  let allWaterExact = true;

  (reports || []).forEach(r => {
    const age = daysBetween(r.date, today);
    if (age !== null && age > window) return;      // older than the window
    const u = usageFromReport(item, r, dosingEvents, flowRate, meterLog);
    if (!u) return;
    // Nothing was dosed in that period, so there is nothing to learn from it
    // and it would only drag the figures down.
    if (u.hours !== null && u.hours <= 0) return;
    series.push(u);
    totalUsed += u.used;
    totalDays += u.days;
    if (u.hours) { totalHours += u.hours; hourUsed += u.used; }
    if (u.water && u.water > 0) {
      totalWater += u.water;
      waterUsed += u.used;
      if (!u.exactWater) allWaterExact = false;
    }
  });

  series.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    series,
    avgPerDay: totalDays > 0 ? totalUsed / totalDays : null,
    avgPerHour: totalHours > 0 ? hourUsed / totalHours : null,
    avgDose: totalWater > 0 ? waterUsed / totalWater : null,
    waterCovered: totalWater,
    waterExact: allWaterExact,
    hoursCovered: totalHours,
    daysCovered: totalDays,
    hoursPerDay: totalDays > 0 && totalHours > 0 ? totalHours / totalDays : null,
    // Water dosed per calendar day, so days-left reflects the real pattern.
    waterPerDay: totalDays > 0 && totalWater > 0 ? totalWater / totalDays : null,
    window
  };
}

/* Days of stock left, based on the average rather than a single day. */
function daysLeftFromAverage(onHand, avgPerDay) {
  if (onHand === null || !avgPerDay || avgPerDay <= 0) return null;
  return onHand / avgPerDay;
}

/* Running hours of stock left, for the chemicals. */
function hoursLeftFromAverage(onHand, avgPerHour) {
  if (onHand === null || !avgPerHour || avgPerHour <= 0) return null;
  return onHand / avgPerHour;
}

/* How much water the chemical left in stock can still treat. */
function waterLeftFromDose(onHand, avgDose) {
  if (onHand === null || !avgDose || avgDose <= 0) return null;
  return onHand / avgDose;
}

/* Copies the current readings into the "last check" boxes and clears the
   current ones, ready for the next report. */
function carryStockForward(values) {
  const out = {};
  if (!values) return out;
  Object.values(ITEM_INDEX).forEach(item => {
    if (item.type !== 'stock') return;
    const v = values[item.id];
    if (!v) return;
    const carried = {};
    if (num(v.inUse) !== null) carried.prevInUse = String(num(v.inUse));
    if (item.hasBackup && num(v.backup) !== null) carried.prevBackup = String(num(v.backup));
    if (Object.keys(carried).length) {
      carried.photos = [];
      out[item.id] = carried;
    }
  });
  return out;
}

/* Carries the "sampled up to" dates into the next report.

   These move on their own schedule - a weekly sample does not change for days
   at a time - so repeating yesterday's date is almost always right, and when
   it is not it only takes one tap to correct. */
function carryDatesForward(values) {
  const out = {};
  if (!values) return out;
  Object.values(ITEM_INDEX).forEach(item => {
    if (item.type !== 'date') return;
    const v = values[item.id];
    if (!v || !v.date) return;
    out[item.id] = { date: v.date, photos: [] };
  });
  return out;
}

function daysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  const d = Math.round((b - a) / 86400000);
  return d > 0 ? d : null;
}

function daysBehind(dateStr, reportDate) {
  if (!dateStr) return null;
  const then = new Date(dateStr + 'T00:00:00');
  const now = new Date(reportDate + 'T00:00:00');
  if (isNaN(then.getTime()) || isNaN(now.getTime())) return null;
  return Math.round((now - then) / 86400000);
}
