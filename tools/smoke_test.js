/* Exercises the pure logic of the app without a browser: markup generation,
   grading, chemical usage, WhatsApp output and PDF generation for awkward
   inputs.

   Run: node tools/smoke_test.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WWW = path.join(__dirname, '..', 'www');

const sandbox = {
  console, JSON, Math, Date, Number, String, Array, Object, isFinite,
  Uint8Array, RegExp, Boolean, Error, parseInt, parseFloat, setTimeout, clearTimeout
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

for (const f of ['config.js', 'pdf.js', 'report.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), ctx, { filename: f });
}

const run = (code) => vm.runInContext(code, ctx);

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`);
  }
}

/* ---------------- 1. markup covers every item ---------------- */
console.log('\n1. Checklist markup');

run('state = blankState();');
const html = run('CHECKLIST.map(renderSection).join("")');
const itemIds = run('Object.keys(ITEM_INDEX)');
const byType = run(`
  (() => {
    const out = { status: [], choice: [], number: [], multi: [], stock: [], date: [] };
    Object.values(ITEM_INDEX).forEach(i => { if (out[i.type]) out[i.type].push(i.id); });
    return out;
  })()
`);

check(`all ${itemIds.length} items rendered`,
  itemIds.every(id => html.includes(`data-item="${id}"`)));
check('every item has a photo button',
  itemIds.every(id => html.includes(`data-photo="${id}"`)));
check('number items get a numeric input',
  byType.number.every(id => html.includes(`data-num="${id}"`)));
check('stock items get yesterday and today boxes',
  byType.stock.every(id =>
    html.includes(`data-pair="${id}" data-side="prevInUse"`) &&
    html.includes(`data-pair="${id}" data-side="inUse"`)));
check('chemicals get a backup and an IBC box',
  ['caustic', 'coagulant', 'flocculant', 'sulphuric'].every(id =>
    html.includes(`data-pair="${id}" data-side="prevBackup"`) &&
    html.includes(`data-pair="${id}" data-side="backup"`) &&
    html.includes(`data-pair="${id}" data-side="ibc"`)));
check('boilers get a single level plus an Added box',
  ['boiler1_chem', 'boiler2_chem'].every(id =>
    html.includes(`data-pair="${id}" data-side="added"`) &&
    !html.includes(`data-pair="${id}" data-side="backup"`)));
check('date items get a date input',
  byType.date.every(id => html.includes(`data-date="${id}"`)));
check('multi items get one input per field',
  run(`
    (() => Object.values(ITEM_INDEX).filter(i => i.type === 'multi').every(i =>
      i.fields.every(f => \`\${CHECKLIST.map(renderSection).join("")}\`
        .includes('data-multi="' + i.id + '" data-key="' + f.key + '"'))))()
  `));
check('choice items get one button per option',
  byType.choice.every(id => {
    const opts = run(`ITEM_INDEX['${id}'].options.map(o => o.value)`);
    return opts.every(o => html.includes(`data-choice="${id}" data-value="${o}"`));
  }));
check('choice items do NOT also show generic status buttons',
  byType.choice.every(id => !html.includes(`data-status="${id}"`)));
check('sample-date rows show only a date, no status buttons',
  byType.date.every(id => !html.includes(`data-status="${id}"`)));
check('other items DO show status buttons',
  [...byType.status, ...byType.number, ...byType.multi, ...byType.stock]
    .every(id => html.includes(`data-status="${id}"`)));
check('no template leftovers', !html.includes('undefined') && !html.includes('[object'));

/* ---------------- 2. the requested changes ---------------- */
console.log('\n2. Requested changes are in place');

check('no shift field anywhere', !run('JSON.stringify(blankState())').includes('shift'));
check('name defaults to the full name',
  run('blankState().reporter') === 'HAFIZ SHAKEEB ARSLAN', run('blankState().reporter'));
check('managers use full names',
  run("JSON.stringify(CHECKLIST.map(s2 => s2.owner)) === '[\"Leighton Black\",\"Hafiz Sarosh\"]'"),
  run('JSON.stringify(CHECKLIST.map(s2 => s2.owner))'));
check('date defaults to today',
  run('blankState().date') === new Date().toISOString().slice(0, 10)
  || /^\d{4}-\d{2}-\d{2}$/.test(run('blankState().date')));
check('pH is a single item with 3 fields',
  run("ITEM_INDEX.ph && ITEM_INDEX.ph.type === 'multi' && ITEM_INDEX.ph.fields.length === 3"));
check('old ph1/ph2/ph3 items are gone',
  run("!ITEM_INDEX.ph1 && !ITEM_INDEX.ph2 && !ITEM_INDEX.ph3"));
check('pit pump renamed',
  run("ITEM_INDEX.pit_pump && ITEM_INDEX.pit_pump.label === 'Pit Pump'"));
check('older pump ids are gone', run('!ITEM_INDEX.main_pumps && !ITEM_INDEX.beef_pit_pump'));
check('blowdown is Done / Not done',
  run("ITEM_INDEX.blowdown.type === 'choice' && JSON.stringify(ITEM_INDEX.blowdown.options.map(o => o.label)) === '[\"Done\",\"Not done\"]'"));
check('water testing is Done / Not done',
  run("ITEM_INDEX.water_test.type === 'choice' && JSON.stringify(ITEM_INDEX.water_test.options.map(o => o.label)) === '[\"Done\",\"Not done\"]'"));
check('boiler chemicals track usage like the chemicals',
  run("['boiler1_chem','boiler2_chem'].every(id => ITEM_INDEX[id].type === 'stock' && ITEM_INDEX[id].topUp === 'litres')"));
check('company name defaults to ATP', run('DEFAULT_SITE') === 'AUSTRALIAN TALLOW PRODUCERS');
check('DAF overflow renamed and Yes/No',
  run("ITEM_INDEX.daf_overflow.label === 'DAF overflow' && ITEM_INDEX.daf_overflow.options.length === 2"));
check('waste tanks renamed',
  run("ITEM_INDEX.waste_tanks.label === 'Waste Tanks - Overflow'"), run("ITEM_INDEX.waste_tanks.label"));
check('No is the good answer',
  run("gradeChoice(ITEM_INDEX.daf_overflow,'no') === 'ok' && gradeChoice(ITEM_INDEX.daf_overflow,'yes') === 'fault'"));
check('the old overflow item is gone', run('!ITEM_INDEX.no_overflow'));

/* ---------------- 2b. the pre-filled defaults ---------------- */
console.log('\n2b. Default starting values');
const defs = run('defaultValues()');
const wantOk = ['bio_vacuum','daf_pumps','daf_paddles','tank1_mixer',
  'floc_mixer','pit_pump','duct_lamb_cooker','duct_beef_cooker','duct_beef_press',
  'duct_drier1','duct_drier2','duct_drier3'];
check('the everyday OK items are pre-set',
  wantOk.every(k => defs[k] && defs[k].status === 'ok'),
  wantOk.filter(k => !defs[k] || defs[k].status !== 'ok').join(','));
check('both biofilter humidity rows start as Fault',
  defs.bio1_rh.choice === 'fault' && defs.bio2_rh.choice === 'fault');
check('DAF clarity starts Clear', defs.daf_clarity.choice === 'clear');
check('both overflow questions start No',
  defs.daf_overflow.choice === 'no' && defs.waste_tanks.choice === 'no');
check('saturators start at 500', defs.sat1.value === 500 && defs.sat2.value === 500);
check('flow rate starts at 19.9', defs.flow_rate.value === 19.9);
check('underpits start at minor residue',
  defs.lamb_pit.choice === 'minor' && defs.beef_pit.choice === 'minor');
check('no drier starts as a fault',
  ['duct_drier1', 'duct_drier2', 'duct_drier3']
    .every(k => defs[k].status === 'ok' && !defs[k].note),
  JSON.stringify(defs.duct_drier2));

/* The biofilter rows name what they found instead of a bare OK / Fault. */
check('system running starts on Running', defs.bio_running.choice === 'running');
check('within target starts on Within target', defs.bio_target.choice === 'within');
check('system running offers the four states',
  run("JSON.stringify(ITEM_INDEX.bio_running.options.map(o => o.value))")
    === '["running","notrunning","fault","notchecked"]',
  run("JSON.stringify(ITEM_INDEX.bio_running.options.map(o => o.value))"));
check('not running is reported as a fault',
  run("gradeChoice(ITEM_INDEX.bio_running,'notrunning') === 'fault'"));
check('not checked is reported as outstanding',
  run("gradeChoice(ITEM_INDEX.bio_running,'notchecked') === 'todo'"));
check('not running gets its own badge',
  run("optionBadge(ITEM_INDEX.bio_running,'notrunning')") === 'NOT RUNNING');
check('within target offers the five states',
  run("JSON.stringify(ITEM_INDEX.bio_target.options.map(o => o.value))")
    === '["within","above","below","fault","notchecked"]',
  run("JSON.stringify(ITEM_INDEX.bio_target.options.map(o => o.value))"));
check('drifting off target is a watch, not a fault',
  run("gradeChoice(ITEM_INDEX.bio_target,'above') === 'watch'")
  && run("gradeChoice(ITEM_INDEX.bio_target,'below') === 'watch'"));
check('off-target badges say which way',
  run("optionBadge(ITEM_INDEX.bio_target,'above')") === 'ABOVE TARGET'
  && run("optionBadge(ITEM_INDEX.bio_target,'below')") === 'BELOW TARGET');
check('blowdown and water testing start Done',
  defs.blowdown.choice === 'done' && defs.water_test.choice === 'done');
check('ovine paperwork starts Updated', defs.ovine_bags.choice === 'updated');
check('chemicals and sample dates are NOT pre-filled',
  !defs.caustic && !defs.ovine_daily && !defs.boiler1_chem,
  JSON.stringify(Object.keys(defs).filter(k => /caustic|ovine_daily|boiler/.test(k))));
check('DAF clarity has 4 named options',
  run("ITEM_INDEX.daf_clarity.type === 'choice' && ITEM_INDEX.daf_clarity.options.length === 4"));
check('clarity options include an out-of-service state',
  run("ITEM_INDEX.daf_clarity.options.some(o => o.label === 'Out of service')"));
check('both underpits have 4 cleanliness grades',
  run("['lamb_pit','beef_pit'].every(id => ITEM_INDEX[id].type === 'choice' && ITEM_INDEX[id].options.length === 4)"));
check('ovine paperwork has Updated / Need new prints',
  run("JSON.stringify(ITEM_INDEX.ovine_bags.options.map(o => o.label)) === '[\"Updated\",\"Need new prints\"]'"));
check('separator testing takes tallow and stick water counts',
  run("ITEM_INDEX.separators.type === 'multi' && JSON.stringify(ITEM_INDEX.separators.fields.map(f => f.key)) === '[\"tallow\",\"stick\"]'"));
check('chemicals accept IBC deliveries',
  run("['caustic','coagulant','flocculant','sulphuric'].every(id => ITEM_INDEX[id].type === 'stock' && ITEM_INDEX[id].topUp === 'ibc' && ITEM_INDEX[id].hasBackup === true)"));

/* ---------------- 3. grading ---------------- */
console.log('\n3. Grading rules');

/* Builds a run of submitted reports so the average has something to work with. */
const HISTORY = `(() => {
  const iso = d => { const x = new Date('2026-09-24T00:00:00'); x.setDate(x.getDate() - d);
    return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0'); };
  const out = []; let inUse = 900, backup = 1700, b = 900;
  for (let i = 12; i >= 1; i--) {
    const used = 400, total = inUse + backup - used;
    const nIn = Math.max(80, Math.round(total * 0.35)), nBk = Math.max(0, total - nIn);
    out.push({ id: 'r' + i, date: iso(i), lastCheckDate: iso(i + 1), values: {
      caustic: { prevInUse: String(inUse), prevBackup: String(backup), inUse: String(nIn), backup: String(nBk) },
      boiler1_chem: { prevInUse: String(b), inUse: String(b - 70) } } });
    inUse = nIn; backup = nBk; b = b - 70 < 100 ? 900 : b - 70;
  }
  return out;
})()`;

const grade = (setup, prev) => run(`
  (() => {
    state = blankState();
    state.date = '2026-09-24';
    ${setup}
    return evaluate(state, ${prev || 'null'}, ${HISTORY}, []);
  })()
`);

// Reading 1 sits below its own band; 2 and 3 are inside theirs.
let ev = grade(`state.values.ph = { a: 4.5, b: 6.3, c: 7.1 };`);
check('a single low pH reading fails the set', ev.items.ph.status === 'fault', ev.items.ph.status);
check('the failing reading is named', /reading 1 \(4\.5\)/.test(ev.items.ph.reason), ev.items.ph.reason);
check('pH displays all three on one line', ev.items.ph.display === '4.5 / 6.3 / 7.1', ev.items.ph.display);
check('each pH reading has its own trigger levels',
  run("['ph1','ph2','ph3'].every(k => DEFAULT_THRESHOLDS[k] && DEFAULT_THRESHOLDS[k].critLow !== undefined)"));
check('the pH fields point at their own limits',
  run("JSON.stringify(ITEM_INDEX.ph.fields.map(f => f.threshold)) === '[\"ph1\",\"ph2\",\"ph3\"]'"));

// reading 2 can be set independently of readings 1 and 3
ev = grade(`
  state.thresholds = mergeThresholds({ ph2: { critLow: 8.0, warnLow: 8.2, warnHigh: 9.5, critHigh: 10 } });
  state.values.ph = { a: 5.2, b: 7.5, c: 7.0 };
`);
check('a per-reading limit only affects that reading',
  ev.items.ph.status === 'fault' && /reading 2 \(7\.5\)/.test(ev.items.ph.reason), ev.items.ph.reason);

ev = grade(`state.values.ph = { a: 5.2, b: 6.3, c: 7.0 };`);
check('healthy pH set is ok', ev.items.ph.status === 'ok', ev.items.ph.status);

ev = grade(`state.values.daf_clarity = { choice: 'clear' };`);
check('clear effluent is ok', ev.items.daf_clarity.status === 'ok', ev.items.daf_clarity.status);
ev = grade(`state.values.daf_clarity = { choice: 'slight' };`);
check('slightly turbid is a watch', ev.items.daf_clarity.status === 'watch', ev.items.daf_clarity.status);
ev = grade(`state.values.daf_clarity = { choice: 'offline' };`);
check('out of service is a fault', ev.items.daf_clarity.status === 'fault', ev.items.daf_clarity.status);
check('the chosen wording is what gets reported',
  ev.items.daf_clarity.display === 'Out of service', ev.items.daf_clarity.display);

ev = grade(`state.values.beef_pit = { choice: 'notdone' };`);
check('an uncleaned pit is a fault', ev.items.beef_pit.status === 'fault', ev.items.beef_pit.status);
ev = grade(`state.values.beef_pit = { choice: 'minor' };`);
check('minor residue passes', ev.items.beef_pit.status === 'ok', ev.items.beef_pit.status);

ev = grade(`state.values.ovine_bags = { choice: 'prints' };`);
check('needing new prints raises an action',
  ev.actions.hafiz.some(a => a.label === 'Ovine bag paperwork'));

ev = grade(`state.values.separators = { tallow: 5, stick: 5, status: 'ok' };`);
check('separator counts read back properly',
  ev.items.separators.display === 'Tallow 5, Stick water 5', ev.items.separators.display);

ev = grade(`state.values.bio2_rh = { choice: 'fault' };`);
check('biofilter humidity is a simple OK / Fault pick',
  run("ITEM_INDEX.bio2_rh.type === 'choice'") && ev.items.bio2_rh.status === 'fault',
  ev.items.bio2_rh.status);
check('humidity has no trigger levels any more', run('!DEFAULT_THRESHOLDS.humidity'));
ev = grade(`state.values.sat1 = { status: 'fault' };`);
check('a tapped Fault survives with no reading', ev.items.sat1.status === 'fault');

/* ---------------- 4. chemical usage ---------------- */
console.log('\n4. Chemical usage');

/* These cases describe the stock *rule*, so they fix their own limits instead
   of leaning on whatever the app currently ships. Changing a shipped default
   is then free to change the app without quietly rewriting what a case means
   here. The separate check that the shipped numbers are the agreed ones lives
   in section 4a. */
const CHEM_LIMITS = `state.thresholds = mergeThresholds({
    chemInUse: { crit: 0, warn: 300 },
    chemBackup: { crit: 0, warn: 0 }
  });`;

// Yesterday's figures now live on the form itself, so no history is needed.
// The exact example from the brief: 1000/500 yesterday, 600/500 today = 400 used
// backup rules: none at all is red, under the monitor level is amber
ev = grade(`${CHEM_LIMITS} state.values.caustic = { inUse: 800, backup: 0 };`);
check('no backup stock is a fault', ev.items.caustic.status === 'fault', ev.items.caustic.status);
check('the reason says there is no backup', /no backup stock/.test(ev.items.caustic.reason), ev.items.caustic.reason);
ev = grade(`${CHEM_LIMITS} state.values.caustic = { inUse: 250, backup: 2000 };`);
check('usage tank under the monitor level is a watch', ev.items.caustic.status === 'watch', ev.items.caustic.status);
check('and it says refill', ev.items.caustic.badge === 'REFILL', ev.items.caustic.badge);
ev = grade(`${CHEM_LIMITS} state.values.caustic = { inUse: 0, backup: 2000 };`);
check('an empty usage tank is a fault', ev.items.caustic.status === 'fault', ev.items.caustic.status);
check('and it still says refill', ev.items.caustic.badge === 'REFILL', ev.items.caustic.badge);
ev = grade(`${CHEM_LIMITS} state.values.caustic = { inUse: 800, backup: 0 };`);
check('no backup says reorder', ev.items.caustic.badge === 'REORDER', ev.items.caustic.badge);
ev = grade(`${CHEM_LIMITS} state.values.caustic = { inUse: 301, backup: 2000 };`);
check('just above the usage trigger is ok', ev.items.caustic.status === 'ok', ev.items.caustic.status);
ev = grade(`${CHEM_LIMITS} state.values.caustic = { inUse: 800, backup: 1000 };`);
check('healthy backup is ok', ev.items.caustic.status === 'ok', ev.items.caustic.status);

ev = grade(`state.values.caustic = { prevInUse: 1000, prevBackup: 500, inUse: 600, backup: 500 };`);
check('400 L used is worked out correctly',
  ev.items.caustic.sum.total.value === '400 L', JSON.stringify(ev.items.caustic.sum));

ev = grade(`state.values.caustic = { prevInUse: 1000, prevBackup: 500, inUse: 600, backup: 1500, ibc: 1 };`);
check('an IBC delivery is counted',
  ev.items.caustic.sum.rows.some(r => r.detail === '1 IBC' && r.value === '+1,000 L'),
  JSON.stringify(ev.items.caustic.sum.rows));
check('usage stays right across a delivery',
  ev.items.caustic.sum.total.value === '400 L', JSON.stringify(ev.items.caustic.sum));

ev = grade(`state.values.caustic = { prevInUse: 1000, prevBackup: 500, inUse: 600, backup: 2500, ibc: 2 };`);
check('two IBCs are handled',
  ev.items.caustic.sum.rows.some(r => r.detail === '2 IBCs' && r.value === '+2,000 L'),
  JSON.stringify(ev.items.caustic.sum.rows));

// yesterday 1500, today 2500, nothing logged -> up 1000 L
ev = grade(`state.values.caustic = { prevInUse: 1000, prevBackup: 500, inUse: 1000, backup: 1500 };`);
check('an unlogged delivery is flagged',
  /at least 1 IBC/.test(ev.items.caustic.reason), ev.items.caustic.reason);
check('and usage is not claimed',
  ev.items.caustic.sum.total.label === 'Usage not confirmed', ev.items.caustic.sum.total.label);

ev = grade(`state.values.caustic = { prevInUse: 1000, prevBackup: 500, inUse: 1000, backup: 500 };`);
check('no movement reads as zero used',
  ev.items.caustic.sum.total.value === '0 L', ev.items.caustic.sum.total.value);

ev = grade(`state.values.caustic = { inUse: 600, backup: 500 };`);
check('without a last check there is no sum', ev.items.caustic.sum === null);

// days of stock remaining
ev = grade(`${CHEM_LIMITS}
  state.values.sulphuric = { prevInUse: 400, prevBackup: 2000, inUse: 200, backup: 2000 };`);
check('a low usage tank is a watch, whatever the usage',
  ev.items.sulphuric.status === 'watch', ev.items.sulphuric.status);
check('the status comes from the tank level',
  /usage tank low/.test(ev.items.sulphuric.reason), ev.items.sulphuric.reason);

// a heavy usage day with healthy tanks must stay green
ev = grade(`${CHEM_LIMITS}
  state.values.caustic = { prevInUse: 1000, prevBackup: 1000, inUse: 500, backup: 1000, ibc: 1 };`);
check('heavy usage alone does not flag anything',
  ev.items.caustic.status === 'ok', ev.items.caustic.status);
check('the average is reported from the history',
  /Average use \d/.test(ev.items.caustic.sum.footer), ev.items.caustic.sum.footer);
check('the average says how many days it covers',
  /over \d+ days/.test(ev.items.caustic.sum.footer), ev.items.caustic.sum.footer);
check('days left comes off the average',
  /about .* left/i.test(ev.items.caustic.sum.footer), ev.items.caustic.sum.footer);
check('the average covers several days of history',
  ev.stock.find(s2 => s2.id === 'caustic').daysCovered >= 3,
  String(ev.stock.find(s2 => s2.id === 'caustic').daysCovered));
check('no leftover chart data',
  ev.stock.every(s2 => s2.series === undefined),
  JSON.stringify(Object.keys(ev.stock[0])));

// without history it must say so rather than invent a number
const noHist = run(`(() => { state = blankState(); state.date = '2026-09-24';
  state.values.caustic = { prevInUse: 1000, prevBackup: 1000, inUse: 500, backup: 1000 };
  return evaluate(state, null, [], []); })()`);
check('no history says so plainly',
  /Not enough history/.test(noHist.items.caustic.sum.footer), noHist.items.caustic.sum.footer);

// boilers work the same way, topped up in litres rather than IBCs
ev = grade(`state.values.boiler1_chem = { prevInUse: 150, inUse: 80 };`);
check('boiler usage is worked out',
  ev.items.boiler1_chem.sum.total.value === '70 L', ev.items.boiler1_chem.sum.total.value);
ev = grade(`state.values.boiler2_chem = { prevInUse: 70, inUse: 100, added: 50 };`);
check('a boiler top-up is counted',
  ev.items.boiler2_chem.sum.rows.some(r => r.value === '+50 L'),
  JSON.stringify(ev.items.boiler2_chem.sum.rows));
check('boiler usage allows for the top-up',
  ev.items.boiler2_chem.sum.total.value === '20 L', ev.items.boiler2_chem.sum.total.value);
ev = grade(`state.values.boiler1_chem = { prevInUse: 600, inUse: 1000 };`);
check('an unexplained boiler rise is named in litres',
  /400 L not accounted for/.test(ev.items.boiler1_chem.reason), ev.items.boiler1_chem.reason);
ev = grade(`state.values.boiler2_chem = { prevInUse: 70, inUse: 100, added: 50 };`);
check('boilers are kept out of the chemical table',
  ev.stock.filter(s2 => s2.kind === 'chemical').every(s2 => !/Boiler/.test(s2.label)),
  JSON.stringify(ev.stock.filter(s2 => s2.kind === 'chemical').map(s2 => s2.label)));
check('boilers still get their own average',
  !!ev.stock.find(s2 => s2.kind === 'boiler'), JSON.stringify(ev.stock.map(s2 => s2.kind)));
check('the average window is adjustable',
  run(`(() => { state = blankState(); state.date='2026-09-24'; state.avgWindowDays = 3;
    state.values.caustic = { prevInUse: 1000, prevBackup: 1000, inUse: 500, backup: 1000 };
    const a = evaluate(state, null, ${HISTORY}, []);
    state.avgWindowDays = 12;
    const b = evaluate(state, null, ${HISTORY}, []);
    return a.stock.find(s2=>s2.id==='caustic').daysCovered < b.stock.find(s2=>s2.id==='caustic').daysCovered;
  })()`));

check('"1 day" not "1.0 days"', run("fmtDays(1)") === '1 day', run("fmtDays(1)"));
check('part of a day reads sensibly', run("fmtDays(0.4)") === 'less than a day', run("fmtDays(0.4)"));
check('longer runs are rounded', run("fmtDays(13.6)") === '14 days', run("fmtDays(13.6)"));

/* ---------------- 4a. the shipped trigger levels ---------------- */
console.log('\n4a. Shipped trigger levels');

/* The numbers the operator asked to be built in. Spelled out here so an
   accidental edit to config.js cannot pass unnoticed. */
const AGREED = {
  ph1:        { critLow: 4.9, warnLow: 5.0, warnHigh: 5.5, critHigh: 5.6 },
  ph2:        { critLow: 6.0, warnLow: 6.1, warnHigh: 6.5, critHigh: 6.7 },
  ph3:        { critLow: 6.0, warnLow: 6.1, warnHigh: 7.8, critHigh: 8.0 },
  chemInUse:  { crit: 300, warn: 500 },
  chemBackup: { crit: 0, warn: 300 },
  boilerChem: { crit: 50, warn: 100 },
  saturator:  { critLow: 500, warnLow: 550, warnHigh: 600, critHigh: 650 },
  flow:       { critLow: 17, warnLow: 18, warnHigh: 20, critHigh: 21 }
};
check('the shipped levels are the agreed ones',
  JSON.stringify(run('DEFAULT_THRESHOLDS')) === JSON.stringify(AGREED),
  JSON.stringify(run('DEFAULT_THRESHOLDS')));
check('a brand new report starts on the shipped levels',
  JSON.stringify(run('blankState().thresholds')) === JSON.stringify(AGREED));
check('a brand new report is not marked hand-typed',
  run('blankState().thEdited') === false);

/* An update must be able to push new levels onto a phone that only ever had
   the old shipped ones, which is what the version stamp is for. */
let th = run(`refreshThresholds({
  thresholds: { ph1: { critLow: 6.0, warnLow: 6.5, warnHigh: 8.5, critHigh: 9.0 } },
  thVersion: 1, thEdited: false })`);
check('old shipped levels are replaced by an update', th.replaced === true);
check('and the new numbers are the ones in use',
  th.thresholds.ph1.critLow === 4.9, String(th.thresholds.ph1.critLow));

th = run('refreshThresholds(null)');
check('a first run with nothing saved takes the shipped levels',
  th.replaced === true && th.thresholds.flow.critHigh === 21);

/* Hand-typed numbers outrank anything a later build ships. */
th = run(`refreshThresholds({
  thresholds: { flow: { critLow: 2, warnLow: 3, warnHigh: 40, critHigh: 50 } },
  thVersion: 1, thEdited: true })`);
check('hand-typed levels survive an update', th.replaced === false);
check('the operator\'s own flow limit is kept',
  th.thresholds.flow.critLow === 2, String(th.thresholds.flow.critLow));
check('a hand-typed set still gets missing limits filled',
  th.thresholds.ph2.critHigh === 6.7, String(th.thresholds.ph2.critHigh));
check('the stamp moves up so it is only replaced once',
  th.thVersion === run('THRESHOLD_VERSION'), String(th.thVersion));

th = run(`refreshThresholds({
  thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
  thVersion: THRESHOLD_VERSION, thEdited: false })`);
check('an up-to-date phone is left alone', th.replaced === false);

/* ---------------- 4b. old saved settings must not crash ---------------- */
console.log('\n4b. Settings saved by an older version');

const patched = run(`
  (() => {
    const partial = { ph1: { critLow: 5.5 } };   // everything else missing
    const merged = mergeThresholds(partial);
    return { keys: Object.keys(merged).sort(), ph: merged.ph1.critLow,
             chemWarn: merged.chemInUse && merged.chemInUse.warn,
             warnHigh: merged.ph1.warnHigh,
             wantWarnHigh: DEFAULT_THRESHOLDS.ph1.warnHigh,
             wantChemWarn: DEFAULT_THRESHOLDS.chemInUse.warn };
  })()
`);
check('missing threshold groups are filled in',
  patched.keys.length === Object.keys(run('DEFAULT_THRESHOLDS')).length, patched.keys.join(','));
check('the operator\'s own number is kept', patched.ph === 5.5, String(patched.ph));
check('missing keys inside a group are filled',
  patched.warnHigh === patched.wantWarnHigh, String(patched.warnHigh));
check('every trigger level has a plain-language name',
  run('Object.keys(DEFAULT_THRESHOLDS).every(k => !!TH_LABELS[k])'));
check('a limit added later is filled in',
  patched.chemWarn === patched.wantChemWarn, String(patched.chemWarn));

ev = run(`
  (() => {
    state = blankState();
    state.date = '2026-09-24';
    state.thresholds = { ph1: { critLow: 6 } };   // no daysOfStock at all
    state.values.caustic = { prevInUse: 1000, prevBackup: 500, inUse: 600, backup: 500 };
    return evaluate(state, null);
  })()
`);
check('a report with old settings still evaluates', ev.items.caustic.status !== undefined,
  ev.items.caustic.status);

/* ---------------- 4c. the hand-recorded September readings ---------------- */
console.log('\n4c. Readings recorded before the app existed');

const hist = run('buildHistoricReports()');
check('fourteen readings embedded', hist.length === 14, String(hist.length));
check('the first is a seed with no previous reading',
  hist[0].date === '2026-09-11' && hist[0].lastCheckDate === null);
check('each later reading points at the one before',
  hist.slice(1).every((r, i) => r.lastCheckDate === hist[i].date));
check('the three-day weekend gap is preserved',
  run("daysBetween('2026-09-11','2026-09-14')") === 3);
check('the four-day holiday gap is preserved',
  run("daysBetween('2026-09-17','2026-09-21')") === 4);

const perChem = run(`(() => {
  const reps = buildHistoricReports();
  const out = {};
  ['caustic','coagulant','flocculant','sulphuric'].forEach(id => {
    let used = 0, days = 0;
    reps.forEach(r => { const u = usageFromReport(ITEM_INDEX[id], r);
      if (u) { used += u.used; days += u.days; } });
    out[id] = { used, days, avg: Math.round(used / days) };
  });
  return out;
})()`);
check('caustic totals 4,900 L across the record',
  perChem.caustic.used === 4900, JSON.stringify(perChem.caustic));
check('acid totals 5,700 L', perChem.sulphuric.used === 5700, String(perChem.sulphuric.used));
check('coagulant totals 1,400 L', perChem.coagulant.used === 1400, String(perChem.coagulant.used));
check('flocculant totals 600 L', perChem.flocculant.used === 600, String(perChem.flocculant.used));

// the transfer out on 17 Sep must read as 400 L used, not 1,400
const sep17 = run(`(() => {
  const r = buildHistoricReports().find(x => x.date === '2026-09-17');
  return usageFromReport(ITEM_INDEX.caustic, r, [], null);
})()`);
check('17 Sep caustic reads 400 L, not 1,400', sep17.used === 400, String(sep17.used));
check('the IBC sent to another department is recorded as leaving',
  run("buildHistoricReports().find(r => r.date === '2026-09-17').values.caustic.ibc") === '-1');
check('and the reason is written down',
  /another department/.test(run("buildHistoricReports().find(r => r.date === '2026-09-17').generalNote")));

// zero-usage days are real - the plant does not always run
check('a zero-usage day is kept, not skipped',
  run(`(() => { const r = buildHistoricReports().find(x => x.date === '2026-09-15');
    const u = usageFromReport(ITEM_INDEX.caustic, r, [], null); return u && u.used === 0; })()`));

check('no "not enough history" once the readings are loaded',
  run(`(() => { state = blankState(); state.date = '2026-09-28'; state.lastCheckDate = '2026-09-24';
    state.values.caustic = { prevInUse: '500', prevBackup: '200', inUse: '400', backup: '200' };
    const ev = evaluate(state, null, buildHistoricReports(), []);
    return !/Not enough history/.test(ev.items.caustic.sum.footer); })()`));

/* ---------------- 4d. badge wording from an option ---------------- */
console.log('\n4d. Ovine bag paperwork wording');

ev = grade(`state.values.ovine_bags = { choice: 'prints' };`);
check('it is red', ev.items.ovine_bags.status === 'fault', ev.items.ovine_bags.status);
check('the badge says NEED PRINTS, not FAULT',
  ev.items.ovine_bags.badge === 'NEED PRINTS', ev.items.ovine_bags.badge);
check('the value is not repeated beside it', ev.items.ovine_bags.hideDisplay === true);
ev = grade(`state.values.ovine_bags = { choice: 'updated' };`);
check('Updated stays green with a plain OK badge',
  ev.items.ovine_bags.status === 'ok' && ev.items.ovine_bags.badge === 'OK',
  ev.items.ovine_bags.badge);
check('the badge fits the row',
  run(`(() => { const d = new PdfDoc();
    return d.badge('NEED PRINTS', 'cross', PT.pageW - PT.margin - 6, 0, [0,0,0]) < 110; })()`));

/* ---------------- 4e. the DAF running log ---------------- */
console.log('\n4e. DAF running hours');

check('the log reads as recorded',
  run('HISTORIC_DOSING_LOG.length') === 7 && run("HISTORIC_DOSING_LOG[0].on") === false,
  String(run('HISTORIC_DOSING_LOG.length')));
check('a shutdown first means it was running before',
  run("dosingIntervals([{at:'2026-09-11T16:00',on:false}])[0][0]") === -Infinity);

// hours between the morning readings
const H = [
  ['2026-09-11', '2026-09-14', 8,  'Fri 8am to 4pm, then off all weekend'],
  ['2026-09-14', '2026-09-15', 0,  'never started on the Monday'],
  ['2026-09-15', '2026-09-16', 21, 'started Tue 11am'],
  ['2026-09-16', '2026-09-17', 24, 'ran right through'],
  ['2026-09-17', '2026-09-21', 32, 'Thu + Fri to 4pm, then off'],
  ['2026-09-21', '2026-09-22', 18, 'started Mon 2pm'],
  ['2026-09-23', '2026-09-24', 24, 'ran right through']
];
H.forEach(([a, b, want, why]) => {
  const got = run(`dosingHoursBetween(HISTORIC_DOSING_LOG, readingStamp('${a}','08:00'), readingStamp('${b}','08:00'))`);
  check(`${a.slice(5)} to ${b.slice(5)} = ${want} hrs (${why})`, got === want, String(got));
});

check('a weekend adds no hours at all',
  run("dosingHoursBetween(HISTORIC_DOSING_LOG, '2026-09-19T00:00', '2026-09-21T08:00')") === 0);
check('the DAF reads as stopped after the last entry',
  run("dosingOnNow(HISTORIC_DOSING_LOG, '2026-09-28T08:00')") === false);
check('and as running mid-week',
  run("dosingOnNow(HISTORIC_DOSING_LOG, '2026-09-22T09:00')") === true);

const doseStats = run(`(() => {
  const reps = buildHistoricReports();
  const rate = dosingFlowRate(reps, HISTORIC_DOSING_LOG);
  const out = { rate };
  ['caustic','coagulant','flocculant','sulphuric'].forEach(id => {
    const s = usageStats(ITEM_INDEX[id], reps, 30, '2026-10-02', HISTORIC_DOSING_LOG, rate);
    out[id] = { dose: Math.round(s.avgDose * 1000) / 1000,
                water: Math.round(s.waterCovered),
                exact: s.waterExact,
                perHour: Math.round(s.avgPerHour * 10) / 10 };
  });
  return out;
})()`);
check('the dosing flow rate is measured at 15.0 m3/h',
  Math.round(doseStats.rate * 100) / 100 === 15, String(doseStats.rate));
check('3,819 m3 of water was dosed', doseStats.caustic.water === 3819, String(doseStats.caustic.water));
check('caustic dose 1.283 L/m3', doseStats.caustic.dose === 1.283, String(doseStats.caustic.dose));
check('acid dose 1.493 L/m3', doseStats.sulphuric.dose === 1.493, String(doseStats.sulphuric.dose));
check('coagulant dose 0.367 L/m3', doseStats.coagulant.dose === 0.367, String(doseStats.coagulant.dose));
check('flocculant dose 0.157 L/m3', doseStats.flocculant.dose === 0.157, String(doseStats.flocculant.dose));
check('part of the water is flagged as estimated', doseStats.caustic.exact === false);
check('running hours are still worked out alongside',
  doseStats.caustic.perHour > 0, String(doseStats.caustic.perHour));

/* exact vs estimated water */
check('a full dosing period gives an exact volume',
  run(`(() => {
    const r = buildHistoricReports().find(x => x.date === '2026-09-23');
    const u = usageFromReport(ITEM_INDEX.caustic, r, HISTORIC_DOSING_LOG, 15);
    return u.exactWater === true && u.water === 307.2;
  })()`));
check('a part-dosing period is estimated from the measured flow',
  run(`(() => {
    const r = buildHistoricReports().find(x => x.date === '2026-09-28');
    const u = usageFromReport(ITEM_INDEX.caustic, r, HISTORIC_DOSING_LOG, 15);
    return u.exactWater === false && u.hours === 8 && u.water === 120;
  })()`));
check('a meter noted at the switch makes it exact again',
  run(`(() => {
    const log = HISTORIC_DOSING_LOG.map(e =>
      e.at === '2026-09-24T16:00' ? { ...e, meter: 222900 } : e);
    const r = buildHistoricReports().find(x => x.date === '2026-09-28');
    const u = usageFromReport(ITEM_INDEX.caustic, r, log, 15);
    return u.exactWater === true && Math.round(u.water) === 117;
  })()`));
check('water only counts while dosing was on',
  run(`(() => {
    // 24 Sep to 28 Sep: 676.9 m3 flowed but only 8 hours were dosed
    const r = buildHistoricReports().find(x => x.date === '2026-09-28');
    const u = usageFromReport(ITEM_INDEX.caustic, r, HISTORIC_DOSING_LOG, 15);
    return u.water < 200 && (r.meter - r.prevMeter) > 600;
  })()`));

check('the acid ran dry on 2 Oct',
  run(`(() => {
    const r = buildHistoricReports().find(x => x.date === '2026-10-02');
    return r.values.sulphuric.inUse === '0' && r.values.sulphuric.backup === '0';
  })()`));
check('fourteen readings are embedded', run('HISTORIC_READINGS.length') === 14,
  String(run('HISTORIC_READINGS.length')));
check('every reading carries a meter value',
  run('HISTORIC_READINGS.every(r => r.meter > 0)'));
check('the dosing log has seven entries', run('HISTORIC_DOSING_LOG.length') === 7,
  String(run('HISTORIC_DOSING_LOG.length')));

check('a period where the plant never ran is left out',
  run(`(() => {
    const r = buildHistoricReports().find(x => x.date === '2026-09-15');
    const s = usageStats(ITEM_INDEX.caustic, [r], 30, '2026-09-16', HISTORIC_DOSING_LOG, 15);
    return s.avgDose === null && s.series.length === 0;
  })()`));

check('boilers stay on calendar days',
  run(`(() => {
    const s = usageStats(ITEM_INDEX.boiler1_chem,
      [{ date:'2026-09-24', lastCheckDate:'2026-09-23',
         values:{ boiler1_chem:{ prevInUse:'900', inUse:'800' } } }],
      14, '2026-09-24', HISTORIC_DOSING_LOG, 15);
    return s.avgDose === null && s.avgPerDay === 100;
  })()`));

check('with no running log the chemicals fall back to days',
  run(`(() => {
    const s = usageStats(ITEM_INDEX.caustic, buildHistoricReports(), 30, '2026-10-02', [], null);
    return s.avgDose === null && s.avgPerDay > 0;
  })()`));

check('the report says litres per cubic metre',
  run(`(() => { state = blankState(); state.date='2026-09-28'; state.lastCheckDate='2026-09-24';
    state.readingTime='08:00'; state.lastReadingTime='08:00';
    state.prevMeter = 222783.5; state.meter = 223460.4;
    state.values.caustic = { prevInUse:'500', prevBackup:'200', inUse:'400', backup:'200' };
    const ev = evaluate(state, null, buildHistoricReports(), HISTORIC_DOSING_LOG);
    const f = ev.items.caustic.sum.footer;
    // Said in words rather than as "1.45 L/m3", which read as jargon.
    return f.indexOf('for every 1 m\u00B3 of water treated') !== -1
      && f.indexOf('per m\u00B3') !== -1; })()`));

check('and shows the water dosed',
  run(`(() => { state = blankState(); state.date='2026-09-22'; state.lastCheckDate='2026-09-21';
    state.readingTime='08:00'; state.lastReadingTime='08:00';
    state.prevMeter = 221837.7; state.meter = 222148.0;
    state.values.caustic = { prevInUse:'1000', prevBackup:'0', inUse:'600', backup:'0' };
    const ev = evaluate(state, null, buildHistoricReports(), HISTORIC_DOSING_LOG);
    return ev.items.caustic.sum.rows.some(r => r.label === 'Water dosed'); })()`));

/* ---------------- 4f. the editable meter log ---------------- */
console.log('\n4f. DAF meter log');

const mlog = run('buildHistoricMeterLog()');
check('every recorded reading is in the log',
  mlog.length === run('HISTORIC_READINGS.length'), String(mlog.length));
check('the log is in order',
  mlog.every((e, i) => i === 0 || mlog[i - 1].at < e.at));
check('readings are stamped with the morning reading time',
  mlog[0].at === '2026-09-11T08:00', mlog[0].at);
check('the last reading is the one off the meter',
  mlog[mlog.length - 1].value === 224994.2, String(mlog[mlog.length - 1].value));

check('a reading can be found by its exact moment',
  run("meterAtStamp(buildHistoricMeterLog(), '2026-09-24T08:00')") === 222783.5);
check('an unknown moment finds nothing',
  run("meterAtStamp(buildHistoricMeterLog(), '2026-09-24T09:30')") === null);
check('the reading before a moment is found',
  run("meterBefore(buildHistoricMeterLog(), '2026-09-24T08:00').at") === '2026-09-23T08:00');
check('nothing sits before the first reading',
  run("meterBefore(buildHistoricMeterLog(), '2026-09-11T08:00')") === null);
check('the newest reading is found',
  run("meterLatest(buildHistoricMeterLog()).value") === 224994.2);
check('unusable entries are ignored',
  run("meterSorted([{at:'2026-09-24T08:00',value:'x'},{value:5},{at:'2026-09-25T08:00',value:7}]).length") === 1);

/* The whole point of the log: correcting it corrects the figures. */
check('the log is used ahead of the figure saved on the report',
  run(`(() => {
    const r = { date:'2026-09-24', lastCheckDate:'2026-09-23',
                readingTime:'08:00', lastReadingTime:'08:00',
                meter: 999999, prevMeter: 111111 };
    const m = meterForReport(r, buildHistoricMeterLog());
    return m.meter === 222783.5 && m.prevMeter === 222455.2; })()`));
check('a report saved before the log existed still works',
  run(`(() => {
    const r = { date:'2026-09-24', lastCheckDate:'2026-09-23',
                readingTime:'08:00', lastReadingTime:'08:00',
                meter: 222783.5, prevMeter: 222455.2 };
    const m = meterForReport(r, []);
    return m.meter === 222783.5 && m.prevMeter === 222455.2; })()`));
check('removing a reading falls back to the one on the report',
  run(`(() => {
    const log = buildHistoricMeterLog().filter(e => e.at !== '2026-09-24T08:00');
    const r = { date:'2026-09-24', lastCheckDate:'2026-09-23',
                readingTime:'08:00', lastReadingTime:'08:00',
                meter: 222783.5, prevMeter: 222455.2 };
    return meterForReport(r, log).meter === 222783.5; })()`));
check('with no reading anywhere there is nothing to report',
  run(`(() => {
    const r = { date:'2026-09-24', lastCheckDate:'2026-09-23',
                readingTime:'08:00', lastReadingTime:'08:00' };
    const m = meterForReport(r, []);
    return m.meter === null && m.prevMeter === null; })()`));

/* A mid-period reading makes that stretch exact instead of estimated. */
check('a logged reading counts as an exact anchor',
  run(`(() => {
    const events = [{ at: '2026-09-21T08:00', on: true }, { at: '2026-09-21T18:00', on: false }];
    const bare = dosedWater('2026-09-21T08:00', '2026-09-22T08:00', null, null, events, 15, []);
    const anchored = dosedWater('2026-09-21T08:00', '2026-09-22T08:00', null, null, events, 15,
      [{ at: '2026-09-21T08:00', value: 1000 }, { at: '2026-09-21T18:00', value: 1160 }]);
    return bare.exact === false && anchored.exact === true && anchored.volume === 160; })()`));

/* Behaviour-preserving guard: for the recorded data, reading the meters out of
   the log must give exactly what reading them off the reports gave. */
check('the log reproduces the figures the reports gave',
  run(`(() => {
    const reports = buildHistoricReports();
    const events = HISTORIC_DOSING_LOG.slice();
    const viaLog = dosingFlowRate(reports, events, buildHistoricMeterLog());
    const viaReports = dosingFlowRate(reports, events, []);
    return Math.abs(viaLog - viaReports) < 1e-9; })()`));
check('and that flow rate is still 15.0 m\u00B3/h',
  Math.abs(run('dosingFlowRate(buildHistoricReports(), HISTORIC_DOSING_LOG, buildHistoricMeterLog())') - 15) < 0.005,
  String(run('dosingFlowRate(buildHistoricReports(), HISTORIC_DOSING_LOG, buildHistoricMeterLog())')));

/* The block that lets the bosses check the dose arithmetic. */
const waterBlock = run(`
  (() => {
    state = blankState();
    state.date = '2026-10-02'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-01'; state.lastReadingTime = '08:00';
    const log = buildHistoricMeterLog();
    const ev = evaluate(state, null, buildHistoricReports(), HISTORIC_DOSING_LOG, log);
    const bytes = buildPdf(state, ev, null);
    return {
      text: String.fromCharCode(...bytes),
      from: ev.meterFrom, to: ev.meterTo, at: ev.meterFromAt, total: ev.totalWater
    };
  })()
`);
check('the meter pair comes out of the log',
  waterBlock.from === 224481.1 && waterBlock.to === 224994.2,
  `${waterBlock.from} -> ${waterBlock.to}`);
check('the water between readings is worked out',
  Math.abs(waterBlock.total - 513.1) < 0.05, String(waterBlock.total));
check('the earlier reading carries the moment it was taken',
  waterBlock.at === '2026-10-01T08:00', String(waterBlock.at));
check('the PDF prints the water block',
  waterBlock.text.indexOf('WATER TREATED SINCE THE LAST REPORT') !== -1);
check('and names both meter readings with their date and time',
  waterBlock.text.indexOf('Meter at 1 Oct 8:00am') !== -1
  && waterBlock.text.indexOf('Meter at 2 Oct 8:00am') !== -1);
check('and the water through the plant',
  waterBlock.text.indexOf('Water through the plant') !== -1);
check('and how long the dosing was on',
  waterBlock.text.indexOf('Chemical was dosing for') !== -1);
check('and the water speed',
  waterBlock.text.indexOf('Water speed while dosing') !== -1);
check('and explains what a dose figure means',
  waterBlock.text.indexOf('litres of chemical used for every') !== -1);

/* Dosing switched off for the whole period used to print a bare "0.0 hrs". */
const dosingOff = run(`
  (() => {
    state = blankState();
    state.date = '2026-10-04'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-02'; state.lastReadingTime = '08:00';
    const log = buildHistoricMeterLog().concat([{ at: '2026-10-04T08:00', value: 225500 }]);
    // Dosing off well before this period opens.
    const events = HISTORIC_DOSING_LOG.slice(0, 5);
    const ev = evaluate(state, null, buildHistoricReports(), events, log);
    const bytes = buildPdf(state, ev, null);
    return { hours: ev.dosingHours, water: ev.totalWater,
             text: String.fromCharCode(...bytes) };
  })()
`);
check('a period with no dosing still reports the water',
  Math.abs(dosingOff.water - 505.8) < 0.05, String(dosingOff.water));
check('and says so in words rather than printing a bare zero',
  dosingOff.hours === 0
  && dosingOff.text.indexOf('off for this whole period') !== -1,
  String(dosingOff.hours));

/* The reported bug: the water figures and the dosing hours came from
   different periods, so the report showed water alongside "0.0 hrs". */
check('the dosing hours cover the same period as the meter readings',
  run(`(() => {
    state = blankState();
    state.date = '2026-10-04'; state.readingTime = '08:00';
    state.lastCheckDate = null;            // no stock check recorded yet
    const log = buildHistoricMeterLog().concat([{ at: '2026-10-04T08:00', value: 225500 }]);
    const ev = evaluate(state, null, buildHistoricReports(), HISTORIC_DOSING_LOG, log);
    // 2 Oct 08:00 -> 4 Oct 08:00 covers the 8 hours before the 16:00 shutdown.
    return ev.spanFrom === '2026-10-02T08:00' && ev.dosingHours === 8; })()`),
  run(`(() => {
    state = blankState();
    state.date = '2026-10-04'; state.readingTime = '08:00';
    state.lastCheckDate = null;
    const log = buildHistoricMeterLog().concat([{ at: '2026-10-04T08:00', value: 225500 }]);
    const ev = evaluate(state, null, buildHistoricReports(), HISTORIC_DOSING_LOG, log);
    return 'span ' + ev.spanFrom + ' hours ' + ev.dosingHours; })()`));

/* A reading cannot be entered out of order, wherever it is entered from. */
check('a reading below the one before it is caught',
  /Lower than/.test(run("meterConflict(buildHistoricMeterLog(), '2026-10-04T08:00', 100)")),
  run("meterConflict(buildHistoricMeterLog(), '2026-10-04T08:00', 100)"));
check('a reading above the one after it is caught',
  /Higher than/.test(run("meterConflict(buildHistoricMeterLog(), '2026-09-15T08:00', 999999)")),
  run("meterConflict(buildHistoricMeterLog(), '2026-09-15T08:00', 999999)"));
check('a reading in the right place is accepted',
  run("meterConflict(buildHistoricMeterLog(), '2026-10-04T08:00', 225500)") === null);

/* The water runs all day whether or not the chemical is dosing, so a reading
   taken later the same day is higher than the morning's. That is the normal
   case and must never be queried - the check is about readings out of order in
   time, not about a figure having gone up. */
check('a later reading on the same day is not queried',
  run(`(() => {
    const log = buildHistoricMeterLog().concat([{ at: '2026-10-04T08:00', value: 225500 }]);
    return meterConflict(log, '2026-10-04T18:00', 225900) === null; })()`));
check('but a later reading that went backwards is',
  run(`(() => {
    const log = buildHistoricMeterLog().concat([{ at: '2026-10-04T08:00', value: 225500 }]);
    return /Lower than/.test(meterConflict(log, '2026-10-04T18:00', 225100)); })()`));
check('a meter that stood still is not queried',
  run(`(() => {
    const log = buildHistoricMeterLog().concat([{ at: '2026-10-04T08:00', value: 225500 }]);
    return meterConflict(log, '2026-10-04T18:00', 225500) === null; })()`));
check('a reading that is not a number is caught',
  run("meterConflict(buildHistoricMeterLog(), '2026-10-04T08:00', 'abc')") !== null);

/* Submitting archives the report, so a second PDF for the same morning used to
   count that period twice and shift every average. */
const twice = run(`
  (() => {
    const reports = buildHistoricReports();
    const log = buildHistoricMeterLog();
    const events = HISTORIC_DOSING_LOG.slice();
    const last = reports[reports.length - 1];
    state = blankState();
    state.date = last.date; state.readingTime = '08:00';
    state.lastCheckDate = last.lastCheckDate; state.lastReadingTime = '08:00';
    state.avgWindowDays = 60;
    state.values = last.values;
    /* Once saved, today's period exists both on screen and in storage. The
       figures must not notice. A second archived copy is the clearest way to
       say that: it adds no new period, so nothing may move. */
    const pick = (ev) => {
      const s = ev.stock.find(x => x.id === 'caustic');
      return { dose: Number(s.avgDose.toFixed(3)), water: Math.round(s.waterCovered) };
    };
    const once = evaluate(state, null, reports, events, log);
    const duplicated = evaluate(state, null,
      reports.concat([{ ...last, id: 'report-again' }]), events, log);
    return { once: pick(once), duplicated: pick(duplicated) };
  })()
`);
check('a day already saved is not counted twice',
  twice.once.dose === twice.duplicated.dose && twice.once.water === twice.duplicated.water,
  `once ${JSON.stringify(twice.once)} vs duplicated ${JSON.stringify(twice.duplicated)}`);
check('the caustic dose over the recorded weeks is 1.283 L/m\u00B3',
  twice.once.dose === 1.283, String(twice.once.dose));
check('and it is measured over 3,819 m\u00B3 of dosed water',
  twice.once.water === 3819, String(twice.once.water));

/* ---------------- 4f2. two reports in a row ---------------- */
console.log('\n4f2. Two reports across a mid-day reading');

/* The operator's own test. A reading noted at 6pm when the dosing was switched
   on must not become the start of the next report, or the water between the
   morning check and 6pm belongs to no report at all. */
const pair = run(`
  (() => {
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },   // morning round
      { at: '2026-10-04T18:00', value: 225900 },   // noted at the dosing switch
      { at: '2026-10-05T08:00', value: 226600 }    // next morning
    ]);
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T18:00', on: true }]);
    const reports = buildHistoricReports();

    const one = (date, lastCheck) => {
      state = blankState();
      state.date = date; state.readingTime = '08:00';
      state.lastCheckDate = lastCheck; state.lastReadingTime = '08:00';
      const ev = evaluate(state, null, reports, events, log);
      return {
        from: ev.meterFrom, fromAt: ev.meterFromAt, to: ev.meterTo,
        through: Math.round(ev.totalWater * 10) / 10,
        span: ev.spanHours, hours: ev.dosingHours,
        dosed: ev.waterNow ? Math.round(ev.waterNow.volume * 10) / 10 : null,
        exact: ev.waterNow ? ev.waterNow.exact : null,
        rate: ev.flowRate ? Math.round(ev.flowRate * 100) / 100 : null,
        flowDays: ev.flowDays
      };
    };
    return { r1: one('2026-10-04', '2026-10-02'), r2: one('2026-10-05', '2026-10-04') };
  })()
`);

check('report 1 measures from the 2 Oct reading',
  pair.r1.from === 224994.2 && pair.r1.fromAt === '2026-10-02T08:00',
  `${pair.r1.from} at ${pair.r1.fromAt}`);
check('report 1 water through the plant is 505.8',
  pair.r1.through === 505.8, String(pair.r1.through));
check('report 1 period is 48 hours', pair.r1.span === 48, String(pair.r1.span));
check('report 1 dosing ran 8 of those hours',
  pair.r1.hours === 8, String(pair.r1.hours));
check('report 1 dosed volume is estimated from the speed',
  pair.r1.exact === false && Math.abs(pair.r1.dosed - 8 * pair.r1.rate) < 0.5,
  `${pair.r1.dosed} vs 8 x ${pair.r1.rate}`);

check('report 2 measures from the MORNING reading, not the 6pm one',
  pair.r2.from === 225500 && pair.r2.fromAt === '2026-10-04T08:00',
  `${pair.r2.from} at ${pair.r2.fromAt}`);
check('report 2 water through the plant is the full 1,100',
  pair.r2.through === 1100, String(pair.r2.through));
check('report 2 period is 24 hours', pair.r2.span === 24, String(pair.r2.span));
check('report 2 dosing ran 14 of those hours',
  pair.r2.hours === 14, String(pair.r2.hours));
check('report 2 dosed volume is exact, anchored on the 6pm reading',
  pair.r2.exact === true && pair.r2.dosed === 700,
  `${pair.r2.dosed} exact=${pair.r2.exact}`);

/* The reading the dosed volume is measured from has to appear on the report.
   Showing only the two period readings made the dosed figure look as though it
   had been worked out from the wrong number. */
const switchLine = run(`
  (() => {
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T18:00', value: 225900 },
      { at: '2026-10-05T08:00', value: 226600 }
    ]);
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T18:00', on: true }]);
    state = blankState();
    state.date = '2026-10-05'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-04'; state.lastReadingTime = '08:00';
    const ev = evaluate(state, null, buildHistoricReports(), events, log);
    const bytes = buildPdf(state, ev, null);
    return { switches: ev.switches, text: String.fromCharCode(...bytes) };
  })()
`);
check('the switch inside the period is reported',
  switchLine.switches.length === 1 && switchLine.switches[0].on === true,
  JSON.stringify(switchLine.switches));
check('and carries the meter reading taken at it',
  switchLine.switches[0].meter === 225900, String(switchLine.switches[0].meter));
check('the PDF prints when the dosing was switched on',
  switchLine.text.indexOf('Dosing on at 4 Oct 6:00pm') !== -1);
check('and names the reading the dosed volume comes from',
  switchLine.text.indexOf('225,900.0') !== -1);
check('the switch time reads as a time of day',
  run("clockTime('2026-10-04T18:00')") === '6:00pm',
  run("clockTime('2026-10-04T18:00')"));
check('morning times too',
  run("clockTime('2026-10-04T08:30')") === '8:30am'
  && run("clockTime('2026-10-04T00:15')") === '12:15am'
  && run("clockTime('2026-10-04T12:05')") === '12:05pm');
check('a switch with no reading noted says so',
  run(`(() => {
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T18:00', on: true }]);
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-05T08:00', value: 226600 }
    ]);
    state = blankState();
    state.date = '2026-10-05'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-04'; state.lastReadingTime = '08:00';
    const ev = evaluate(state, null, buildHistoricReports(), events, log);
    const bytes = buildPdf(state, ev, null);
    return ev.switches[0].meter === null
      && String.fromCharCode(...bytes).indexOf('meter not noted') !== -1; })()`));

/* No water may fall between the two reports. */
check('the two reports together account for every cubic metre',
  Math.abs((pair.r1.through + pair.r2.through) - (226600 - 224994.2)) < 0.05,
  `${pair.r1.through} + ${pair.r2.through} vs ${226600 - 224994.2}`);

check('the report says how many days the speed rests on',
  pair.r1.flowDays >= 3, String(pair.r1.flowDays));

/* The working behind the speed, including why a day was left out. This is what
   explains a figure that looks wrong without reading the stored data by hand. */
const flowWork = run(`
  (() => {
    const log = buildHistoricMeterLog();
    const reports = buildHistoricReports();
    const clean = flowRateCandidates(reports, HISTORIC_DOSING_LOG, log);
    // An entry dropped into the middle of 1 Oct stops that day counting.
    const meddled = flowRateCandidates(reports,
      HISTORIC_DOSING_LOG.concat([
        { at: '2026-09-30T20:00', on: false },
        { at: '2026-10-01T02:00', on: true }
      ]).sort((a, b) => (a.at < b.at ? -1 : 1)), log);
    const rate = (rows) => {
      let w = 0, h = 0;
      rows.filter(r => r.counted).forEach(r => { w += r.water; h += r.hours; });
      return h > 0 ? Number((w / h).toFixed(1)) : null;
    };
    return {
      cleanCounted: clean.filter(r => r.counted).map(r => r.date),
      cleanRate: rate(clean),
      meddledCounted: meddled.filter(r => r.counted).map(r => r.date),
      meddledRate: rate(meddled),
      why: meddled.find(r => r.date === '2026-10-01').why,
      firstWhy: clean.find(r => r.date === '2026-09-11').why
    };
  })()
`);
check('the clean data counts six days at 15.0',
  flowWork.cleanCounted.length === 6 && flowWork.cleanRate === 15,
  `${flowWork.cleanCounted.length} days at ${flowWork.cleanRate}`);
check('an extra dosing entry drops that day out',
  flowWork.meddledCounted.indexOf('2026-10-01') === -1
  && flowWork.meddledCounted.length === 5,
  JSON.stringify(flowWork.meddledCounted));
check('and the reason says how much of the period was dosing',
  /dosing on .* of .* hrs/.test(flowWork.why), flowWork.why);
check('the very first day says it has no previous check',
  /no previous check/.test(flowWork.firstWhy), flowWork.firstWhy);
check('dropping a day moves the speed',
  flowWork.meddledRate !== flowWork.cleanRate,
  `${flowWork.meddledRate} vs ${flowWork.cleanRate}`);

/* The line on screen names the reading the report is measured from, which is
   not the newest reading once one is noted mid-period. */
check('the opening reading is the morning one, not the newest',
  run(`(() => {
    const log = [
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T18:00', value: 225900 }
    ];
    const o = meterOpening(log, '2026-10-04', '08:00', '2026-10-05T08:00');
    return o.value === 225500 && o.at === '2026-10-04T08:00'; })()`));
check('with no tank check yet it falls back to the newest reading',
  run(`(() => {
    const log = [
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T18:00', value: 225900 }
    ];
    const o = meterOpening(log, null, '08:00', '2026-10-05T08:00');
    return o.value === 225900; })()`));

/* ---------------- 4f3. an incomplete period ---------------- */
console.log('\n4f3. When a meter reading is missing');

/* Reported from the phone: four lines, one meter reading, no water total, and
   an estimated volume over an hour and a half. The reading time had been left
   at the time of day the app was opened, so the round's own reading sat at a
   different moment and the report found nothing for today. */
const partial = run(`
  (() => {
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T18:00', value: 225900 }
    ]);
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T18:00', on: true }]);
    const one = (readingTime, lastCheckDate) => {
      state = blankState();
      state.date = '2026-10-04'; state.readingTime = readingTime;
      state.lastCheckDate = lastCheckDate; state.lastReadingTime = '08:00';
      const ev = evaluate(state, null, buildHistoricReports(), events, log);
      return {
        from: ev.meterFrom, to: ev.meterTo,
        through: ev.totalWater === null ? null : Math.round(ev.totalWater * 10) / 10,
        span: ev.spanHours, hours: ev.dosingHours, missing: ev.meterMissing,
        spanFrom: ev.spanFrom, spanTo: ev.spanTo
      };
    };
    return {
      evening: one('19:30', null),
      eveningWithCheck: one('19:30', '2026-10-02'),
      morning: one('08:00', '2026-10-02')
    };
  })()
`);

/* The reading time no longer has to match a reading exactly. */
check('a reading time after the round still finds the day\'s reading',
  partial.evening.to === 225900 && partial.evening.from === 225500,
  `${partial.evening.from} -> ${partial.evening.to}`);
check('and the period is a real one, not an hour and a half',
  partial.evening.span === 10 && partial.evening.through === 400,
  `span ${partial.evening.span}, through ${partial.evening.through}`);
check('one reading is never used as both ends',
  partial.evening.spanFrom !== partial.evening.spanTo,
  `${partial.evening.spanFrom} / ${partial.evening.spanTo}`);
check('with the tank-check date known the full period is used',
  partial.eveningWithCheck.from === 224994.2
  && partial.eveningWithCheck.through === 905.8,
  `${partial.eveningWithCheck.from}, ${partial.eveningWithCheck.through}`);
check('the ordinary morning case is unchanged',
  partial.morning.through === 505.8 && partial.morning.hours === 8,
  `${partial.morning.through}, ${partial.morning.hours}`);

/* With nothing entered for today the report must ask, not half-report. */
const noReading = run(`
  (() => {
    state = blankState();
    state.date = '2026-10-06'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-02'; state.lastReadingTime = '08:00';
    const ev = evaluate(state, null, buildHistoricReports(),
      HISTORIC_DOSING_LOG, buildHistoricMeterLog());
    const bytes = buildPdf(state, ev, null);
    return { missing: ev.meterMissing, hours: ev.dosingHours,
             water: ev.totalWater, text: String.fromCharCode(...bytes) };
  })()
`);
check('a report with no reading for today says which one is missing',
  noReading.missing === 'today', String(noReading.missing));
check('and works nothing out from half a period',
  noReading.hours === null && noReading.water === null,
  `${noReading.hours}, ${noReading.water}`);
check('and the PDF asks for it in plain words',
  noReading.text.indexOf('No DAF meter reading has been entered') !== -1);
check('a stale reading is never passed off as this morning\'s',
  run(`(() => {
    state = blankState();
    state.date = '2026-10-06'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-02'; state.lastReadingTime = '08:00';
    const ev = evaluate(state, null, buildHistoricReports(),
      HISTORIC_DOSING_LOG, buildHistoricMeterLog());
    return ev.meterTo === null; })()`));

/* ---------------- 4f4. a period that runs backwards ---------------- */
console.log('\n4f4. A period that would run backwards');

/* Reported from the phone. The last-check time is carried over from the
   previous report, so re-making a report earlier in the same day left the
   opening moment after the closing one: the two readings printed in reverse,
   water of -400 m3, and "0.0 of those -11.5 hrs". */
const backwards = run(`
  (() => {
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T19:30', value: 225900 }
    ]);
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T19:30', on: true }]);
    state = blankState();
    state.date = '2026-10-04'; state.readingTime = '08:00';
    // Carried over from a report whose round was at 19:30 the same day.
    state.lastCheckDate = '2026-10-04'; state.lastReadingTime = '19:30';
    const ev = evaluate(state, null, buildHistoricReports(), events, log);
    return {
      from: ev.meterFrom, to: ev.meterTo,
      fromAt: ev.spanFrom, toAt: ev.spanTo,
      span: ev.spanHours, water: ev.totalWater,
      hours: ev.dosingHours, missing: ev.meterMissing
    };
  })()
`);
check('the period is not left running backwards',
  backwards.span > 0, String(backwards.span));
check('it falls back to the newest reading before this one',
  backwards.from === 224994.2 && backwards.fromAt === '2026-10-02T08:00',
  `${backwards.from} at ${backwards.fromAt}`);
check('the water is positive again',
  Math.abs(backwards.water - 505.8) < 0.05, String(backwards.water));
check('and the hours are the real 8 over 48',
  backwards.hours === 8 && backwards.span === 48,
  `${backwards.hours} of ${backwards.span}`);

/* With no earlier reading to fall back on, say so rather than print nonsense. */
const noWayBack = run(`
  (() => {
    const log = [
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T19:30', value: 225900 }
    ];
    state = blankState();
    state.date = '2026-10-04'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-04'; state.lastReadingTime = '19:30';
    const ev = evaluate(state, null, [], HISTORIC_DOSING_LOG, log);
    const bytes = buildPdf(state, ev, null);
    return { missing: ev.meterMissing, water: ev.totalWater,
             hours: ev.dosingHours, text: String.fromCharCode(...bytes) };
  })()
`);
check('a period that cannot be measured reports nothing',
  noWayBack.water === null && noWayBack.hours === null,
  `${noWayBack.water}, ${noWayBack.hours}`);
check('and the PDF asks for an earlier reading',
  noWayBack.missing === 'earlier'
  && /no earlier DAF meter reading/.test(noWayBack.text),
  String(noWayBack.missing));
check('a negative water figure is never printed',
  noWayBack.text.indexOf('-400') === -1 && noWayBack.text.indexOf('-11.5') === -1);

/* A meter that reads lower than the one it is measured against is a data
   problem, not a plant reading. */
check('the meter going backwards across a period is not reported as water',
  run(`(() => {
    const log = [
      { at: '2026-10-03T08:00', value: 226000 },
      { at: '2026-10-04T08:00', value: 225500 }
    ];
    state = blankState();
    state.date = '2026-10-04'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-03'; state.lastReadingTime = '08:00';
    const ev = evaluate(state, null, [], HISTORIC_DOSING_LOG, log);
    return ev.totalWater === null && ev.meterMissing === 'period'; })()`));

/* ---------------- 4f5. a switch at the very end ---------------- */
console.log('\n4f5. A dosing switch at the closing moment');

/* Reported from the phone: "Dosing switched on 7:30pm" printed directly above
   "0.0 of those 11.5 hrs", which reads as a contradiction. The switch sat
   exactly at the end of the period, so it belongs to the next report. */
const endSwitch = run(`
  (() => {
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T19:30', value: 225900 }
    ]);
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T19:30', on: true }]);
    state = blankState();
    state.date = '2026-10-04'; state.readingTime = '19:30';
    state.lastCheckDate = '2026-10-04'; state.lastReadingTime = '08:00';
    const ev = evaluate(state, null, buildHistoricReports(), events, log);
    const bytes = buildPdf(state, ev, null);
    return { hours: ev.dosingHours, span: ev.spanHours,
             water: ev.totalWater, switches: ev.switches.length,
             text: String.fromCharCode(...bytes) };
  })()
`);
check('the period itself is right',
  endSwitch.span === 11.5 && endSwitch.water === 400,
  `${endSwitch.span} hrs, ${endSwitch.water} m\u00B3`);
check('no dosing hours fall inside it', endSwitch.hours === 0, String(endSwitch.hours));
check('the switch at the closing moment is not listed as if it counted',
  endSwitch.switches === 0, String(endSwitch.switches));
check('and the PDF explains it belongs to the next report',
  /counts towards the next report/.test(endSwitch.text));
check('a switch inside the period is still listed',
  run(`(() => {
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-05T08:00', value: 226600 }
    ]);
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T19:30', on: true }]);
    state = blankState();
    state.date = '2026-10-05'; state.readingTime = '08:00';
    state.lastCheckDate = '2026-10-04'; state.lastReadingTime = '08:00';
    return evaluate(state, null, buildHistoricReports(), events, log).switches.length === 1; })()`));

/* ------------- 4f6. the recorded dates are known ------------- */
console.log('\n4f6. The span of recorded data');

check('the recorded span matches the readings',
  run('RECORDED_FROM') === '2026-09-11' && run('RECORDED_TO') === '2026-10-02',
  `${run('RECORDED_FROM')} to ${run('RECORDED_TO')}`);
check('it is taken from the readings, not typed twice',
  run('RECORDED_FROM === HISTORIC_READINGS[0].date')
  && run('RECORDED_TO === HISTORIC_READINGS[HISTORIC_READINGS.length - 1].date'));

/* ---------------- 4f7. the water block laid out in two columns ------------- */
console.log('\n4f7. The water block as a two-column table');

const twoCol = run(`
  (() => {
    const log = buildHistoricMeterLog().concat([
      { at: '2026-10-04T08:00', value: 225500 },
      { at: '2026-10-04T19:30', value: 225900 },
      { at: '2026-10-05T08:00', value: 226600 }
    ]);
    const events = HISTORIC_DOSING_LOG.concat([{ at: '2026-10-04T19:30', on: true }]);
    const one = (date, rt, lcd, lrt) => {
      state = blankState();
      state.date = date; state.readingTime = rt;
      state.lastCheckDate = lcd; state.lastReadingTime = lrt;
      const ev = evaluate(state, null, buildHistoricReports(), events, log);
      const bytes = buildPdf(state, ev, null);
      return { ev, text: String.fromCharCode(...bytes) };
    };
    const r2 = one('2026-10-05', '08:00', '2026-10-04', '08:00');
    const sameDay = one('2026-10-04', '19:30', '2026-10-04', '08:00');

    /* Widest label plus value against the room one column leaves. Two columns
       halve the space, so a label comfortable in one can collide in two. */
    const PAGE_W = 595.28, MARGIN = 38;
    const room = ((PAGE_W - MARGIN * 2) / 2) - 26;
    const widest = [
      ['Chemical was dosing for', '12.5 of those 24.0 hrs', false],
      ['Water that got chemical', '1,311 m\u00B3  (estimated)', true],
      ['Dosing on at 28 Sep 8:30am', 'meter not noted', false],
      ['Water speed while dosing', '15.0 m\u00B3 per hour', false],
      ['Meter at 28 Sep 8:00am', '223,460.4 m\u00B3', false]
    ].map(([l, v, b]) => Math.round(measure(l, 8.2, b) + measure(v, b ? 9 : 8.6, b)));

    return {
      room: Math.round(room), widest,
      r2Text: r2.text, sameDayText: sameDay.text,
      r2Switch: r2.ev.switches[0]
    };
  })()
`);

check('no row is too wide for half the page',
  twoCol.widest.every(w => w < twoCol.room),
  `widest ${Math.max(...twoCol.widest)}pt in ${twoCol.room}pt`);
check('the switch line carries its date, not just the time',
  twoCol.r2Text.indexOf('Dosing on at 4 Oct 7:30pm') !== -1);
check('both meter rows carry their date and time',
  twoCol.r2Text.indexOf('Meter at 4 Oct 8:00am') !== -1
  && twoCol.r2Text.indexOf('Meter at 5 Oct 8:00am') !== -1);
check('two readings on the same day are told apart',
  twoCol.sameDayText.indexOf('Meter at 4 Oct 8:00am') !== -1
  && twoCol.sameDayText.indexOf('Meter at 4 Oct 7:30pm') !== -1);
check('the moment goes in the label so the reading lines up',
  twoCol.r2Switch.meter === 225900, String(twoCol.r2Switch.meter));

/* ---------------- 4g. dates carried into the next report ---------------- */
console.log('\n4g. Sampling dates carried forward');

const carried = run(`carryDatesForward({
  ovine_daily:  { date: '2026-09-26' },
  mbm_weekly:   { date: '2026-09-22' },
  ovine_weekly: { date: '2026-09-19' },
  caustic:      { inUse: '500', backup: '200' },
  bio_running:  { choice: 'running' }
})`);
check('the sampling dates come across',
  carried.ovine_daily.date === '2026-09-26'
  && carried.mbm_weekly.date === '2026-09-22'
  && carried.ovine_weekly.date === '2026-09-19',
  JSON.stringify(carried));
check('only the date rows are carried',
  Object.keys(carried).sort().join(',') === 'mbm_weekly,ovine_daily,ovine_weekly',
  Object.keys(carried).sort().join(','));
check('a blank date is not carried as a blank',
  Object.keys(run("carryDatesForward({ ovine_daily: { date: '' } })")).length === 0);
check('nothing recorded carries nothing',
  Object.keys(run('carryDatesForward(null)')).length === 0);

/* ---------------- 5. empty and awkward ---------------- */
console.log('\n5. Empty and awkward input');

const empty = run(`
  (() => {
    state = blankState();
    state.values = {};          // truly empty, ignoring the defaults
    const ev = evaluate(state, null, [], []);
    const bytes = buildPdf(state, ev, null);
    return { len: bytes.length, head: String.fromCharCode(...bytes.slice(0, 8)),
             acts: ev.actions.leighton.length + ev.actions.hafiz.length,
             wa: buildWhatsApp(state, ev).map(m => m.text) };
  })()
`);
check('a blank report still produces a PDF', empty.len > 1000, `${empty.len} bytes`);
check('valid PDF header', empty.head.startsWith('%PDF-1.'));
check('nothing flagged when nothing entered', empty.acts === 0, String(empty.acts));
check('WhatsApp says all clear', empty.wa.every(t => t.includes('All checks clear')));
check('the default name appears', empty.wa[0].includes('HAFIZ SHAKEEB ARSLAN'));

const hostile = run(`
  (() => {
    state = blankState();
    state.reporter = "O'Brien \\\\ \\"acting\\"";
    state.site = 'Plant \u00B0 3 \u2013 m\u00B3 \u2705 \uD83D\uDE00';
    state.values.ph = { a: 'abc', b: '', c: null };
    state.values.flow_rate = { value: -5 };
    state.values.caustic = { inUse: 'x', backup: null, ibc: 'two' };
    state.values.ovine_daily = { date: 'not-a-date' };
    state.values.separators = { tallow: '', stick: 'many' };
    state.values.daf_clarity = { choice: 'nonexistent-option' };
    const ev = evaluate(state, { date: '2026-09-23', values: { caustic: { inUse: 10, backup: 10 } } }, [], []);
    const bytes = buildPdf(state, ev, null);
    return { tail: String.fromCharCode(...bytes.slice(-6)),
             ph: ev.items.ph.status, flow: ev.items.flow_rate.status,
             daily: ev.items.ovine_daily.status, clarity: ev.items.daf_clarity.status,
             sep: ev.items.separators.display };
  })()
`);
check('non-numeric pH stays blank', hostile.ph === 'blank', hostile.ph);
check('negative flow is a fault', hostile.flow === 'fault', hostile.flow);
check('unparseable date stays blank', hostile.daily === 'blank', hostile.daily);
check('an unknown choice value stays blank', hostile.clarity === 'blank', hostile.clarity);
check('mixed separator input does not crash', typeof hostile.sep === 'string', hostile.sep);
check('PDF still closes correctly', hostile.tail.includes('%%EOF'), hostile.tail);

/* ---------------- 6. overflow ---------------- */
console.log('\n6. Overflow handling');

const long = run(`
  (() => {
    state = blankState();
    Object.keys(ITEM_INDEX).forEach(id => {
      state.values[id] = { status: 'fault',
        note: 'Long note to force wrapping and page breaks. '.repeat(4), photos: [] };
    });
    const ev = evaluate(state, null, [], []);
    const bytes = buildPdf(state, ev, null);
    const all = String.fromCharCode(...bytes);
    return { faults: ev.counts.fault, pages: (all.match(/\\/Type \\/Page[^s]/g) || []).length,
             ok: all.startsWith('%PDF') };
  })()
`);
check('every item can be flagged', long.faults === itemIds.length, String(long.faults));
check('long report paginates', long.pages >= 4, `${long.pages} pages`);
check('long report is valid', long.ok);

/* ---------------- 7. text helpers ---------------- */
console.log('\n7. Text helpers');

check('bold is wider than regular',
  run('measure("Hello World", 10, true)') > run('measure("Hello World", 10, false)'));
check('wrapText splits long text', run('wrapText("one two three four five six seven", 9, false, 60).length') > 1);
check('emoji stripped for the PDF',
  run('toWinAnsi("ok \u2705 done").length') === run('toWinAnsi("ok  done").length'));
check('cubic metre sign survives', run('toWinAnsi("m\u00B3").includes(0xB3)'));
check('parentheses escaped', run('pdfStringBody(toWinAnsi("a(b)c"))') === 'a\\(b\\)c');

console.log('\n' + '='.repeat(46));
if (failures) {
  console.log(`FAILED ${failures} check(s)`);
  process.exit(1);
}
console.log('All smoke tests passed.');
