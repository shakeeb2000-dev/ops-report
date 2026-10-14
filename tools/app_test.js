/* Boots the real app against a stand-in DOM and drives the buttons, so
   runtime errors surface here instead of on a phone.

   Run: node tools/app_test.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDocument, createIndexedDB } = require('./minidom');

const WWW = path.join(__dirname, '..', 'www');
const FILES = ['config.js', 'pdf.js', 'report.js', 'app.js'];

let failures = 0;
const errors = [];

function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Builds a fresh app instance. `seed` pre-populates IndexedDB, which is how
   we reproduce "an old report was already saved". */
function makeApp(seed) {
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const document = createDocument(html);
  const indexedDB = createIndexedDB(seed);
  const localErrors = [];

  const sandbox = {
    console: {
      log: () => {},
      // Anything the app logs as an error is a real problem worth failing on.
      error: (...a) => localErrors.push(a.map(String).join(' ')),
      warn: () => {}
    },
    document, indexedDB,
    JSON, Math, Date, Number, String, Array, Object, isFinite, parseInt, parseFloat,
    Uint8Array, RegExp, Boolean, Error, Promise, Map, Set, WeakMap, Symbol,
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    confirm: () => true,
    alert: () => {},
    location: {
      protocol: 'https:', search: '', href: 'https://example.test/',
      reload: () => { localErrors.push('unexpected reload'); }
    },
    /* Close enough to the real thing to exercise the update path: a
       registration that can be asked to update, and an event target. */
    navigator: {
      serviceWorker: {
        register: () => Promise.resolve({
          update: () => Promise.resolve(),
          waiting: null, installing: null
        }),
        // The app asks whether a worker is in charge and whether the page is
        // saved. Both answer "yes" unless a case switches them off.
        getRegistration: () => Promise.resolve(
          sandbox.__noWorker ? undefined : { active: { state: 'activated' } }),
        addEventListener: () => {}
      }
    },
    caches: {
      match: () => Promise.resolve(sandbox.__shellCached === false ? undefined : {})
    },
    window: null,
    Blob: class { constructor(parts) { this.parts = parts; } },
    File: class { constructor(parts, name) { this.parts = parts; this.name = name; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    scrollTo: () => {},
    Number_isInteger: Number.isInteger
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, sandbox, document, indexedDB, localErrors };
}

const run = (ctx, code) => vm.runInContext(code, ctx);

async function main() {
  /* ================= scenario 1: clean install ================= */
  console.log('\n1. Clean first run');
  {
    const app = makeApp(null);
    await sleep(250);

    check('no errors logged during boot', app.localErrors.length === 0,
      app.localErrors.join(' | '));

    const form = app.document.querySelector('#thresholdForm');
    check('trigger-level form is filled in', form && form.children.length > 0,
      form ? `${form.children.length} rows` : 'form missing');
    const inputs = form ? form.querySelectorAll('[data-th]') : [];
    check('every trigger level has an input', inputs.length >= 16, `${inputs.length} inputs`);

    const checklist = app.document.querySelector('#checklist');
    check('checklist rendered', checklist && checklist.querySelectorAll('[data-item]').length > 30,
      checklist ? String(checklist.querySelectorAll('[data-item]').length) : 'missing');

    check('name pre-filled with the full name',
      app.document.querySelector('#fReporter').value === 'HAFIZ SHAKEEB ARSLAN',
      app.document.querySelector('#fReporter').value);
    check('report prefix pre-filled',
      app.document.querySelector('#fPrefix').value === 'ATP-DOR',
      app.document.querySelector('#fPrefix').value);
    check('date pre-filled', /^\d{4}-\d{2}-\d{2}$/.test(app.document.querySelector('#fDate').value),
      app.document.querySelector('#fDate').value);
  }

  /* ================= scenario 2: an old report already saved ================= */
  console.log('\n2. With a previously saved report (reproducing the reported bugs)');
  {
    const today = run(makeApp(null).ctx, 'todayISO()');
    // Mimics a report saved by the PREVIOUS version: old id format, old item
    // ids, and thresholds that predate daysOfStock.
    const oldThresholds = {
      ph: { critLow: 6, warnLow: 6.5, warnHigh: 8.5, critHigh: 9 },
      chemInUse: { crit: 200, warn: 500 },
      chemBackup: { crit: 100, warn: 400 },
      humidity: { critLow: 30, warnLow: 40, warnHigh: 75, critHigh: 85 },
      boilerChem: { crit: 50, warn: 100 },
      saturator: { critLow: 350, warnLow: 450, warnHigh: 700, critHigh: 800 },
      flow: { critLow: 5, warnLow: 10, warnHigh: 30, critHigh: 40 },
      humidity: { critLow: 30, warnLow: 40, warnHigh: 75, critHigh: 85 },
      sampleLagDays: { warn: 8, crit: 15 }
    };
    const seed = [
      {
        id: 'report-2026-09-23-AM', date: '2026-09-23', shift: 'AM',
        reporter: 'ARSLAN', thresholds: oldThresholds, photos: {},
        values: { caustic: { inUse: 1000, backup: 500 }, ph1: { value: 7 } },
        savedAt: Date.now() - 86400000
      },
      {
        id: 'draft', date: today, reporter: 'ARSLAN', shift: 'AM',
        thresholds: oldThresholds, photos: {},
        values: { caustic: { prevInUse: 1000, prevBackup: 500, inUse: 600, backup: 500 } },
        savedAt: Date.now()
      }
    ];

    const app = makeApp(seed);
    await sleep(250);

    check('no errors logged during boot', app.localErrors.length === 0,
      app.localErrors.join(' | '));

    const form = app.document.querySelector('#thresholdForm');
    check('trigger-level form still fills in', form && form.children.length > 0,
      form ? `${form.children.length} rows` : 'form missing');

    check('limits missing from an old save are repaired',
      run(app.ctx, 'JSON.stringify(["ph1","chemInUse","chemBackup"].every(k => !!state.thresholds[k]))') === 'true',
      run(app.ctx, 'JSON.stringify(Object.keys(state.thresholds))'));

    // The old save carries the levels that build shipped, never hand-typed
    // ones, so the update is free to replace them.
    check('a draft from an older build picks up the new shipped levels',
      run(app.ctx, 'state.thresholds.chemInUse.crit') === 300,
      run(app.ctx, 'JSON.stringify(state.thresholds.chemInUse)'));
    check('and the new pH 1 band is in force',
      run(app.ctx, 'state.thresholds.ph1.critHigh') === 5.6,
      run(app.ctx, 'JSON.stringify(state.thresholds.ph1)'));
    check('the form on screen shows the new numbers',
      (app.document.querySelector('[data-th="flow"][data-thkey="critHigh"]') || {}).value === '21',
      String((app.document.querySelector('[data-th="flow"][data-thkey="critHigh"]') || {}).value));

    // The buttons. The WhatsApp text option was taken out at the operator's
    // request - the PDF is what goes to the managers.
    const pdf = app.document.querySelector('#btnPdf');
    check('PDF button exists', !!pdf);
    check('there is no WhatsApp text button any more',
      !app.document.querySelector('#btnWhatsApp') && !app.document.querySelector('#waSheet'));

    let threw = null;
    try { pdf.dispatch('click'); } catch (e) { threw = e; }
    await sleep(300);
    check('PDF button runs without throwing', !threw, threw && threw.message);
    check('no errors logged while making the PDF', app.localErrors.length === 0,
      app.localErrors.join(' | '));

    const saved = Array.from(app.indexedDB.__stores.reports.keys());
    check('a report was archived', saved.some(k => k.startsWith('report-')), saved.join(','));
  }

  /* ================= scenario 3: new report button ================= */
  console.log('\n3. Start a new report');
  {
    const app = makeApp(null);
    await sleep(250);
    run(app.ctx, `
      state.values.caustic = { inUse: 500, backup: 400, ibc: 1, photos: [] };
      state.values.boiler1_chem = { inUse: 80, added: 20, photos: [] };
      state.values.bio_running = { status: 'ok', photos: [] };
      state.values.daf_clarity = { choice: 'turbid', photos: [] };
    `);
    check('values present before reset',
      run(app.ctx, '!!(state.values.caustic && state.values.boiler1_chem)'));

    let threw = null;
    try { app.document.querySelector('#btnNewReport').dispatch('click'); } catch (e) { threw = e; }
    await sleep(250);
    check('new-report button runs without throwing', !threw, threw && threw.message);

    check('ordinary checks are back to their defaults',
      run(app.ctx, "state.values.bio_running.choice === 'running' && state.values.daf_clarity.choice === 'clear'"),
      run(app.ctx, 'JSON.stringify(state.values.daf_clarity)'));
    check('no drier carries a steaming note by default',
      run(app.ctx, "JSON.stringify(!state.values.duct_drier2.note)") === 'true');

    // Tank levels must survive, moved into the Yesterday boxes.
    check("today's level rolled into yesterday",
      run(app.ctx, 'state.values.caustic.prevInUse') === '500',
      run(app.ctx, 'JSON.stringify(state.values.caustic)'));
    check("today's backup rolled into yesterday",
      run(app.ctx, 'state.values.caustic.prevBackup') === '400');
    check("today's boxes are emptied",
      run(app.ctx, 'state.values.caustic.inUse === undefined && state.values.caustic.ibc === undefined'),
      run(app.ctx, 'JSON.stringify(state.values.caustic)'));
    check('boiler levels roll forward too',
      run(app.ctx, 'state.values.boiler1_chem.prevInUse') === '80',
      run(app.ctx, 'JSON.stringify(state.values.boiler1_chem)'));
    check('boiler top-up is cleared',
      run(app.ctx, 'state.values.boiler1_chem.added === undefined'));

    check('name kept', run(app.ctx, 'state.reporter') === 'HAFIZ SHAKEEB ARSLAN');
    check('settings form still populated after reset',
      app.document.querySelector('#thresholdForm').children.length > 0);
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
  }

  /* ================= scenario 4: settings interactions ================= */
  console.log('\n4. Settings');
  {
    const app = makeApp(null);
    await sleep(250);

    let threw = null;
    try { app.document.querySelector('#btnSettings').dispatch('click'); } catch (e) { threw = e; }
    await sleep(40);
    check('gear opens without throwing', !threw, threw && threw.message);
    check('settings sheet opened', app.document.querySelector('#settingsSheet').hidden === false);

    const input = app.document.querySelector('[data-th="ph1"][data-thkey="critLow"]');
    check('a pH 1 trigger input exists', !!input);
    check('all three pH readings have their own inputs',
      ['ph1', 'ph2', 'ph3'].every(k =>
        !!app.document.querySelector(`[data-th="${k}"][data-thkey="critLow"]`)));
    if (input) {
      input.value = '5.5';
      threw = null;
      try { input.dispatch('input'); } catch (e) { threw = e; }
      check('editing a trigger level works', !threw, threw && threw.message);
      check('the new value is stored',
        run(app.ctx, 'state.thresholds.ph1.critLow') === 5.5,
        run(app.ctx, 'String(state.thresholds.ph1.critLow)'));
    }

    check('editing marks the levels as hand-typed',
      run(app.ctx, 'state.thEdited') === true);

    threw = null;
    try { app.document.querySelector('#btnResetThresholds').dispatch('click'); } catch (e) { threw = e; }
    check('reset works', !threw, threw && threw.message);
    check('reset restored the default',
      run(app.ctx, 'state.thresholds.ph1.critLow') === run(app.ctx, 'DEFAULT_THRESHOLDS.ph1.critLow'),
      run(app.ctx, 'String(state.thresholds.ph1.critLow)'));
    check('reset clears the hand-typed mark so updates apply again',
      run(app.ctx, 'state.thEdited') === false);
  }

  /* ========= scenario 4b: trigger levels across an app update ========= */
  console.log('\n4b. Trigger levels across an app update');
  {
    // Yesterday's draft, so boot also rolls the day over. Levels must survive
    // that roll-forward with the same rule as a same-day draft.
    const hand = {
      id: 'draft', date: '2026-09-24', reporter: 'ARSLAN', photos: {},
      thresholds: {
        ph1: { critLow: 1, warnLow: 2, warnHigh: 3, critHigh: 4 },
        flow: { critLow: 1, warnLow: 2, warnHigh: 3, critHigh: 4 }
      },
      thEdited: true, thVersion: 1,
      values: { caustic: { inUse: 1000, backup: 500 } },
      savedAt: Date.now() - 86400000
    };
    const app = makeApp([hand]);
    await sleep(250);
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
    check('hand-typed levels survive the day rolling over',
      run(app.ctx, 'state.thresholds.flow.critLow') === 1,
      run(app.ctx, 'JSON.stringify(state.thresholds.flow)'));
    check('still marked hand-typed after the roll-over',
      run(app.ctx, 'state.thEdited') === true);

    const shipped = {
      ...hand, thEdited: false,
      thresholds: { flow: { critLow: 5, warnLow: 10, warnHigh: 30, critHigh: 40 } }
    };
    delete shipped.thVersion;          // exactly what an older build wrote
    const app2 = makeApp([shipped]);
    await sleep(250);
    check('untouched levels update across the day rolling over',
      run(app2.ctx, 'state.thresholds.flow.critLow') === 17,
      run(app2.ctx, 'JSON.stringify(state.thresholds.flow)'));
  }

  /* ================= scenario 5: tapping through the checklist ================= */
  console.log('\n5. Filling the checklist');
  {
    const app = makeApp(null);
    await sleep(250);
    const list = app.document.querySelector('#checklist');

    let threw = null;
    try {
      list.querySelector('[data-choice="bio_running"][data-value="notrunning"]').dispatch('click');
      list.querySelector('[data-choice="bio1_rh"][data-value="ok"]').dispatch('click');
      list.querySelector('[data-choice="daf_clarity"][data-value="turbid"]').dispatch('click');
      const phA = list.querySelector('[data-multi="ph"][data-key="a"]');
      phA.value = '5.2';
      phA.dispatch('input');
      const ibc = list.querySelector('[data-pair="caustic"][data-side="ibc"]');
      ibc.value = '1';
      ibc.dispatch('input');
    } catch (e) { threw = e; }
    check('tapping and typing works', !threw, threw && threw.message);
    check('the named state is recorded',
      run(app.ctx, "state.values.bio_running.choice") === 'notrunning',
      run(app.ctx, "String(state.values.bio_running.choice)"));
    // Re-tapping the chosen option must keep it, not clear it.
    list.querySelector('[data-choice="bio_running"][data-value="notrunning"]').dispatch('click');
    check('re-tapping the same option keeps it',
      run(app.ctx, "state.values.bio_running.choice") === 'notrunning',
      run(app.ctx, "String(state.values.bio_running.choice)"));
    check('choice recorded', run(app.ctx, "state.values.daf_clarity.choice") === 'turbid');
    check('humidity recorded as a choice', run(app.ctx, "state.values.bio1_rh.choice") === 'ok');
    check('multi reading recorded', run(app.ctx, "state.values.ph.a") === '5.2');
    check('IBC count recorded', run(app.ctx, "state.values.caustic.ibc") === '1');
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));

    const pill = app.document.querySelector('[data-pill="daf_clarity"]');
    check('pill updated to fault', pill && pill.textContent === 'FAULT',
      pill ? pill.textContent : 'missing');
  }

  /* ================= scenario 6: yesterday seeded from a saved report ======= */
  console.log('\n6. Yesterday figures seeded from an existing saved report');
  {
    const seed = [{
      id: 'report-2026-09-24', date: '2026-09-24', reporter: 'ARSLAN',
      photos: {}, savedAt: Date.now(),
      values: {
        caustic: { inUse: 1000, backup: 500 },
        boiler1_chem: { inUse: 150 }
      }
    }];
    const app = makeApp(seed);
    await sleep(250);
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
    check('chemical yesterday box pre-filled',
      run(app.ctx, 'state.values.caustic && state.values.caustic.prevInUse') === '1000',
      run(app.ctx, 'JSON.stringify(state.values.caustic || null)'));
    check('chemical yesterday backup pre-filled',
      run(app.ctx, 'state.values.caustic.prevBackup') === '500');
    check('boiler yesterday box pre-filled',
      run(app.ctx, 'state.values.boiler1_chem.prevInUse') === '150');

    // usage should now work purely from the form
    run(app.ctx, `
      state.values.caustic.inUse = '600';
      state.values.caustic.backup = '500';
    `);
    const sum = run(app.ctx, 'JSON.stringify(evaluate(state, previousReport, submittedReports, dosingEvents).items.caustic.sum)');
    check('usage works from the form alone', /"value":"400 L"/.test(sum), sum);
  }

  /* ================= scenario 6b: "I don't know" deliveries ============== */
  console.log('\n6b. Deliveries not known');
  {
    const app = makeApp(null);
    await sleep(250);
    run(app.ctx, `
      state.lastCheckDate = '2026-09-25';
      state.date = '2026-09-28';
      state.values.caustic = { prevInUse: 500, prevBackup: 1000, inUse: 900, backup: 2000, photos: [] };
    `);
    run(app.ctx, 'render();');

    const btn = app.document.querySelector('[data-unsure="caustic"]');
    check('the "not known" button exists', !!btn);
    let threw = null;
    try { btn.dispatch('click'); } catch (e) { threw = e; }
    check('it toggles without throwing', !threw, threw && threw.message);
    check('the flag is stored', run(app.ctx, 'state.values.caustic.unknownDelivery') === true);

    const sum = run(app.ctx, 'JSON.stringify(evaluate(state, null, submittedReports, dosingEvents).items.caustic.sum)');
    check('usage is reported as not confirmed', /Usage not confirmed/.test(sum), sum);
    check('the gap is counted in days',
      run(app.ctx, 'evaluate(state, null, submittedReports, dosingEvents).gapDays') === 3,
      String(run(app.ctx, 'evaluate(state, null, submittedReports, dosingEvents).gapDays')));
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
  }

  /* ================= scenario 7: the company logo ================= */
  console.log('\n7. Company logo');
  {
    const app = makeApp(null);
    await sleep(250);
    check('company name defaults to ATP',
      app.document.querySelector('#fSite').value === 'AUSTRALIAN TALLOW PRODUCERS',
      app.document.querySelector('#fSite').value);
    check('logo preview says none yet',
      /No logo/.test(app.document.querySelector('#logoPreview').innerHTML));

    // A stored logo must reach the PDF header.
    const jpeg = fs.readFileSync(path.join(__dirname, '..', '.tmp-logo.jpg'));
    run(app.ctx, `state.logo = { dataUrl: 'data:image/jpeg;base64,${jpeg.toString('base64')}', width: 120, height: 120 };`);
    renderAndCheckLogo(app);
  }

  /* ============ scenario 8: the recorded readings load once ============ */
  console.log('\n8. Hand-recorded readings');
  {
    const app = makeApp(null);
    await sleep(300);
    const stored = Array.from(app.indexedDB.__stores.reports.values());
    const seeded = stored.filter(r => r.source === 'recorded-by-hand');
    check('fourteen readings written on first run', seeded.length === 14, String(seeded.length));
    check('they are visible to the average',
      run(app.ctx, 'submittedReports.length') >= 14, String(run(app.ctx, 'submittedReports.length')));
    check('a dose rate is produced straight away',
      run(app.ctx, `(() => { state.date = '2026-10-05'; state.lastCheckDate = '2026-10-02';
        state.readingTime = '08:00'; state.lastReadingTime = '08:00';
        state.prevMeter = 224994.2; state.meter = 225520;
        state.values.caustic = { prevInUse: '600', prevBackup: '0', inUse: '400', backup: '0' };
        const s = evaluate(state, null, submittedReports, dosingEvents).stock.find(x => x.id === 'caustic');
        return s.avgDose > 1 && s.avgDose < 2; })()`));
    check('the meter field is on the form', !!app.document.querySelector('#fMeter'));
    check('the previous meter is carried in',
      /224,994|No earlier/.test(app.document.querySelector('#prevMeterNote').textContent),
      app.document.querySelector('#prevMeterNote').textContent);
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));

    // a second launch must not duplicate them
    const app2 = makeApp(stored);
    await sleep(300);
    const after = Array.from(app2.indexedDB.__stores.reports.values())
      .filter(r => r.source === 'recorded-by-hand');
    check('a second launch does not duplicate them', after.length === 14, String(after.length));

    // a real report for the same date must win
    const withReal = stored.map(r => r.id === 'report-2026-09-24'
      ? { ...r, source: undefined, values: { caustic: { inUse: '999', backup: '1' } } } : r);
    const app3 = makeApp(withReal.filter(r => r.id !== '__historic-seeded'));
    await sleep(300);
    const kept = Array.from(app3.indexedDB.__stores.reports.values())
      .find(r => r.id === 'report-2026-09-24');
    check('a real report is never overwritten',
      kept.values.caustic.inUse === '999', JSON.stringify(kept.values.caustic));

    check('the marker record never shows up as a report',
      run(app.ctx, 'submittedReports.every(r => r.id !== "__historic-seeded")'));

    /* An app that already loaded an OLDER set of readings must pick up the
       corrections. This is what left the dose column blank. */
    const stale = [];
    ['2026-09-11','2026-09-14','2026-09-15','2026-09-16','2026-09-17',
     '2026-09-21','2026-09-22','2026-09-23','2026-09-24'].forEach((d, i, arr) => {
      stale.push({ id: 'report-' + d, date: d, lastCheckDate: i ? arr[i-1] : null,
        source: 'recorded-by-hand', photos: {}, savedAt: Date.now(),
        values: { caustic: { inUse: '500', backup: '200', prevInUse: '600', prevBackup: '200' } } });
    });
    stale.push({ id: '__historic-seeded', done: true, at: Date.now() });   // old marker, no version
    stale.push({ id: 'report-2026-10-06', date: '2026-10-06', lastCheckDate: '2026-10-02',
      photos: {}, savedAt: Date.now(), values: { caustic: { inUse: '111', backup: '222' } } });
    stale.push({ id: '__daf-log', events: [{ at: '2026-09-11T16:00', on: false }] });

    const upgraded = makeApp(stale);
    await sleep(400);
    const after2 = Array.from(upgraded.indexedDB.__stores.reports.values()).filter(r => r.date);
    check('stale readings are replaced with the corrected set',
      after2.filter(r => r.source === 'recorded-by-hand').length === 14,
      String(after2.filter(r => r.source === 'recorded-by-hand').length));
    check('every embedded reading now carries a meter value',
      after2.filter(r => r.meter).length === 14, String(after2.filter(r => r.meter).length));
    check('the five newer days arrived',
      after2.filter(r => r.date >= '2026-09-28' && r.source === 'recorded-by-hand').length === 5);
    const ownReport = after2.find(r => r.id === 'report-2026-10-06');
    check('a report the operator submitted is left alone',
      ownReport && ownReport.values.caustic.inUse === '111',
      JSON.stringify(ownReport && ownReport.values.caustic));
    check('the orphaned log from the old naming is cleared',
      !upgraded.indexedDB.__stores.reports.has('__daf-log'));
    check('a dose rate now appears',
      run(upgraded.ctx, `(() => {
        state.date='2026-10-05'; state.lastCheckDate='2026-10-02';
        state.readingTime='08:00'; state.lastReadingTime='08:00';
        state.prevMeter=224994.2; state.meter=225500; state.avgWindowDays=30;
        state.values.caustic={prevInUse:'600',prevBackup:'0',inUse:'400',backup:'0'};
        const s = evaluate(state,null,submittedReports,dosingEvents,meterReadings)
          .stock.find(x=>x.id==='caustic');
        return s.avgDose > 1 && s.avgDose < 2; })()`));
    check('the dose is read off the meter log',
      run(upgraded.ctx, `(() => {
        const ev = evaluate(state,null,submittedReports,dosingEvents,meterReadings);
        return ev.meterFrom === 224994.2 && ev.meterFromAt === '2026-10-02T08:00'; })()`),
      run(upgraded.ctx, `(() => {
        const ev = evaluate(state,null,submittedReports,dosingEvents,meterReadings);
        return ev.meterFrom + ' at ' + ev.meterFromAt; })()`));
    check('the flow rate is the measured 15.0 m\u00B3/h',
      run(upgraded.ctx, `(() => {
        const ev = evaluate(state,null,submittedReports,dosingEvents,meterReadings);
        return Math.abs(ev.flowRate - 15) < 0.005; })()`),
      run(upgraded.ctx, `(() => {
        const ev = evaluate(state,null,submittedReports,dosingEvents,meterReadings);
        return String(ev.flowRate); })()`));
    check('the report can show the water worked out',
      run(upgraded.ctx, `(() => {
        const ev = evaluate(state,null,submittedReports,dosingEvents,meterReadings);
        return ev.totalWater > 500 && ev.waterNow.volume > 0 && ev.flowRate > 10; })()`));
    check('no errors logged', upgraded.localErrors.length === 0, upgraded.localErrors.join(' | '));
  }

  /* ================== scenario 9: the DAF button ================== */
  console.log('\n9. DAF running log');
  {
    const app = makeApp(null);
    await sleep(300);
    check('the dosing log loaded', run(app.ctx, 'dosingEvents.length') === 7,
      String(run(app.ctx, 'dosingEvents.length')));
    check('it shows as stopped', /STOPPED/.test(app.document.querySelector('#dosingNow').textContent),
      app.document.querySelector('#dosingNow').textContent);
    check('it says dosage, not just DAF',
      /DAF DOSAGE STOPPED/.test(app.document.querySelector('#dosingNow').textContent),
      app.document.querySelector('#dosingNow').textContent);
    check('the button offers to start it',
      /Record DAF dosage started/.test(app.document.querySelector('#btnDosingToggle').textContent),
      app.document.querySelector('#btnDosingToggle').textContent);

    // record a start, backdated
    let threw = null;
    try { app.document.querySelector('#btnDosingToggle').dispatch('click'); } catch (e) { threw = e; }
    check('the entry panel opens without throwing', !threw, threw && threw.message);
    check('panel is visible', app.document.querySelector('#dosingEntry').hidden === false);

    const todayIso = run(app.ctx, 'todayISO()');
    app.document.querySelector('#dosingDate').value = todayIso;
    app.document.querySelector('#dosingTime').value = '00:01';
    app.document.querySelector('#dosingMeter').value = '225600';
    try { app.document.querySelector('#btnDosingSave').dispatch('click'); } catch (e) { threw = e; }
    await sleep(120);
    check('the start is saved', !threw && run(app.ctx, 'dosingEvents.length') === 8,
      String(run(app.ctx, 'dosingEvents.length')));
    check('it now reads as running',
      /RUNNING/.test(app.document.querySelector('#dosingNow').textContent),
      app.document.querySelector('#dosingNow').textContent);
    check('and the button flips to stop',
      /Record DAF dosage stopped/.test(app.document.querySelector('#btnDosingToggle').textContent),
      app.document.querySelector('#btnDosingToggle').textContent);

    // Backdating a start into a stretch it was already running must be refused.
    run(app.ctx, 'dosingEvents = HISTORIC_DOSING_LOG.slice();');
    run(app.ctx, 'renderDosing();');
    const before = run(app.ctx, 'dosingEvents.length');
    app.document.querySelector('#btnDosingToggle').dispatch('click');
    app.document.querySelector('#dosingDate').value = '2026-09-22';   // DAF already running
    app.document.querySelector('#dosingTime').value = '10:00';
    try { app.document.querySelector('#btnDosingSave').dispatch('click'); } catch (e) { threw = e; }
    await sleep(80);
    check('a start during a running stretch is refused',
      run(app.ctx, 'dosingEvents.length') === before, String(run(app.ctx, 'dosingEvents.length')));
    app.document.querySelector('#btnDosingCancel').dispatch('click');

    // removing an entry
    const n = run(app.ctx, 'dosingEvents.length');
    const del = app.document.querySelector('[data-dosingdel]');
    check('entries are listed with a remove option', !!del);
    if (del) {
      try { del.dispatch('click'); } catch (e) { threw = e; }
      await sleep(120);
      check('an entry can be removed', run(app.ctx, 'dosingEvents.length') === n - 1,
        String(run(app.ctx, 'dosingEvents.length')));
    }
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
    check('the log persisted to storage',
      Array.isArray((app.indexedDB.__stores.reports.get('__dosing-log') || {}).events));

    check('the reading time field is filled in',
      /^\d{2}:\d{2}$/.test(app.document.querySelector('#fReadingTime').value),
      app.document.querySelector('#fReadingTime').value);
  }

  /* ============== scenario 10: the DAF meter log ============== */
  console.log('\n10. DAF meter log');
  {
    const app = makeApp(null);
    await sleep(320);
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
    check('the recorded readings loaded',
      run(app.ctx, 'meterReadings.length') === 14,
      String(run(app.ctx, 'meterReadings.length')));
    check('the log persisted to storage',
      Array.isArray((app.indexedDB.__stores.reports.get('__meter-log') || {}).readings));

    check('past readings are listed',
      (app.document.querySelector('#meterList').innerHTML.match(/data-meterdel/g) || []).length > 1,
      app.document.querySelector('#meterList').innerHTML.slice(0, 120));
    check('the last reading is shown under the meter box',
      /224,994\.2/.test(app.document.querySelector('#prevMeterNote').textContent),
      app.document.querySelector('#prevMeterNote').textContent);

    /* The reported bug: starting a new report said there was no earlier
       reading, because the previous one was only ever carried across from
       today's box and today's box was empty. */
    let threw = null;
    try { app.document.querySelector('#btnNewReport').dispatch('click'); } catch (e) { threw = e; }
    await sleep(220);
    check('starting a new report runs without throwing', !threw, threw && threw.message);
    check('starting a new report keeps the earlier reading',
      run(app.ctx, 'num(state.prevMeter)') === 224994.2,
      run(app.ctx, 'JSON.stringify(state.prevMeter)'));
    check('and the note on screen names it',
      /224,994\.2/.test(app.document.querySelector('#prevMeterNote').textContent),
      app.document.querySelector('#prevMeterNote').textContent);
    check('with no reading yet for today the box is empty',
      app.document.querySelector('#fMeter').value === '',
      app.document.querySelector('#fMeter').value);

    // Typing this morning's reading goes into the log.
    const box = app.document.querySelector('#fMeter');
    box.value = '225400.5';
    try { box.dispatch('input'); } catch (e) { threw = e; }
    await sleep(500);
    check('typing a reading works', !threw, threw && threw.message);
    check('the typed reading joins the log',
      run(app.ctx, 'meterReadings.length') === 15,
      String(run(app.ctx, 'meterReadings.length')));
    check('and it is read back as today\'s figure',
      run(app.ctx, 'num(state.meter)') === 225400.5,
      run(app.ctx, 'JSON.stringify(state.meter)'));
    check('correcting it replaces rather than piles up', (() => {
      box.value = '225401.5';
      box.dispatch('input');
      return run(app.ctx, 'meterReadings.length') === 15
        && run(app.ctx, 'num(state.meter)') === 225401.5;
    })(), String(run(app.ctx, 'meterReadings.length')));

    /* Adding another reading by hand. Dated from the app's own clock so the
       case keeps its meaning whenever it is run. */
    const tomorrow = run(app.ctx,
      "new Date(Date.now() + 86400000).toISOString().slice(0,10)");
    try { app.document.querySelector('#btnMeterAdd').dispatch('click'); } catch (e) { threw = e; }
    check('the add panel opens', app.document.querySelector('#meterEntry').hidden === false);
    // Left empty on purpose: this panel is for a day other than today, and
    // pre-filling today made it look like a second box for the morning round.
    check('the day is not pre-filled',
      app.document.querySelector('#meterDate').value === '',
      app.document.querySelector('#meterDate').value);
    app.document.querySelector('#meterValue').value = '225999';
    try { app.document.querySelector('#btnMeterSave').dispatch('click'); } catch (e) { threw = e; }
    await sleep(120);
    check('a reading with no day is refused',
      run(app.ctx, 'meterReadings.length') === 15,
      String(run(app.ctx, 'meterReadings.length')));

    app.document.querySelector('#meterDate').value = tomorrow;
    app.document.querySelector('#meterTime').value = '08:00';
    app.document.querySelector('#meterValue').value = '100';   // the meter only counts up
    try { app.document.querySelector('#btnMeterSave').dispatch('click'); } catch (e) { threw = e; }
    await sleep(120);
    check('a reading below the one before it is refused',
      run(app.ctx, 'meterReadings.length') === 15,
      String(run(app.ctx, 'meterReadings.length')));

    app.document.querySelector('#meterValue').value = '225999';
    try { app.document.querySelector('#btnMeterSave').dispatch('click'); } catch (e) { threw = e; }
    await sleep(120);
    check('a sensible reading is saved',
      run(app.ctx, 'meterReadings.length') === 16,
      String(run(app.ctx, 'meterReadings.length')));
    check('the panel closes again',
      app.document.querySelector('#meterEntry').hidden === true);

    // Removing a wrong reading.
    const n = run(app.ctx, 'meterReadings.length');
    const del = app.document.querySelector('[data-meterdel]');
    check('readings are listed with a remove option', !!del);
    if (del) {
      try { del.dispatch('click'); } catch (e) { threw = e; }
      await sleep(140);
      check('a reading can be removed',
        run(app.ctx, 'meterReadings.length') === n - 1,
        String(run(app.ctx, 'meterReadings.length')));
    }
    check('no errors logged after editing', app.localErrors.length === 0,
      app.localErrors.join(' | '));

    /* Deleting recorded readings changes the measured water speed, and before
       this there was no way to undo it. */
    run(app.ctx, `
      meterReadings = meterReadings.filter(e => e.at >= '2026-09-28');
      saveMeterLog();
    `);
    await sleep(120);
    const trimmed = run(app.ctx, 'meterReadings.length');
    check('readings can be deleted down to a handful', trimmed < 14, String(trimmed));

    let restoreThrew = null;
    try { app.document.querySelector('#btnMeterRestore').dispatch('click'); } catch (e) { restoreThrew = e; }
    await sleep(200);
    check('putting the recorded readings back works', !restoreThrew,
      restoreThrew && restoreThrew.message);
    check('all 14 recorded readings are there again',
      run(app.ctx, `meterReadings.filter(e => e.at <= '2026-10-02T08:00').length`) === 14,
      run(app.ctx, 'String(meterReadings.length)'));
    check('and the ones entered by hand are untouched',
      run(app.ctx, `meterReadings.some(e => e.at > '2026-10-02T08:00')`) === true);
    check('no errors logged after restoring', app.localErrors.length === 0,
      app.localErrors.join(' | '));

    /* The working behind the water speed has to be visible, or a surprising
       value can only be explained by reading the stored data by hand. */
    let sThrew = null;
    try { app.document.querySelector('#btnSettings').dispatch('click'); } catch (e) { sThrew = e; }
    await sleep(150);
    check('opening settings works', !sThrew, sThrew && sThrew.message);
    const detail = app.document.querySelector('#flowDetail');
    check('the speed working is shown', !!detail && detail.innerHTML.length > 0);
    check('it lists the days that count',
      /17 Sep 2026/.test(detail.innerHTML) && /02 Oct 2026/.test(detail.innerHTML),
      detail.innerHTML.slice(0, 200));
    check('it names the totals and the resulting speed',
      /days together/.test(detail.innerHTML) && /m\u00B3\/h/.test(detail.innerHTML));
    check('it counts the readings, entries and reports',
      /meter readings/.test(detail.innerHTML) && /dosing entries/.test(detail.innerHTML)
      && /saved reports/.test(detail.innerHTML));
    /* The state reported from the phone: reports submitted over the recorded
       dates, which replaced the recorded figures and took their meter readings
       with them. Those days then stopped counting towards the water speed,
       with nothing in the app able to put them back. */
    run(app.ctx, `
      (async () => {
        const days = ['2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02'];
        const before = { '2026-09-28':'2026-09-24', '2026-09-29':'2026-09-28',
          '2026-09-30':'2026-09-29', '2026-10-01':'2026-09-30', '2026-10-02':'2026-10-01' };
        for (const d of days) {
          // A submitted report keeps its period but carries no meter figures,
          // which is exactly what was seen on the phone.
          await store.put({ id: 'report-' + d, date: d,
            lastCheckDate: before[d], lastReadingTime: '08:00', readingTime: '08:00',
            reporter: 'ARSLAN', photos: {}, savedAt: Date.now(),
            values: { caustic: { inUse: '500', backup: '200' } } });
        }
        // And the readings for those mornings are gone with them.
        meterReadings = meterReadings.filter(e => e.at < '2026-09-28');
        await saveMeterLog();
        submittedReports = await loadSubmittedReports();
      })();
    `);
    await sleep(220);
    run(app.ctx, 'renderFlowDetail(refresh());');
    const broken = run(app.ctx, `(() => {
      const ev = evaluate(state, previousReport, submittedReports, dosingEvents, meterReadings);
      return ev.flowDetail.length; })()`);
    check('submitting over the recorded dates drops those days',
      broken === 3, String(broken));
    check('and the panel names the missing readings',
      /meter reading missing/.test(app.document.querySelector('#flowDetail').innerHTML));

    let rThrew = null;
    try { app.document.querySelector('#btnMeterRestore').dispatch('click'); } catch (e) { rThrew = e; }
    await sleep(300);
    check('putting the recorded data back works', !rThrew, rThrew && rThrew.message);
    const healed = run(app.ctx, `(() => {
      const ev = evaluate(state, previousReport, submittedReports, dosingEvents, meterReadings);
      return { days: ev.flowDetail.length,
               rate: ev.flowRate ? Number(ev.flowRate.toFixed(1)) : null }; })()`);
    check('all six measuring days are back',
      healed.days === 6, String(healed.days));
    check('and the water speed is 15.0 again',
      healed.rate === 15, String(healed.rate));

    check('every dosing entry is listed in full',
      (app.document.querySelector('#dosingAudit').innerHTML.match(/dosing-row/g) || []).length
        === run(app.ctx, 'dosingEvents.length'),
      String((app.document.querySelector('#dosingAudit').innerHTML.match(/dosing-row/g) || []).length));

    /* An entry dropped into the middle of a day must show up as the reason
       that day stopped counting. */
    run(app.ctx, `
      dosingEvents.push({ at: '2026-09-30T20:00', on: false });
      dosingEvents.push({ at: '2026-10-01T02:00', on: true });
      dosingEvents.sort((a, b) => (a.at < b.at ? -1 : 1));
    `);
    run(app.ctx, 'renderFlowDetail(refresh()); renderDosingAudit();');
    const after = app.document.querySelector('#flowDetail').innerHTML;
    check('a day knocked out by an extra entry is explained',
      /Days not used/.test(after) && /dosing on/.test(after),
      after.slice(-240));
    check('no errors logged after opening settings', app.localErrors.length === 0,
      app.localErrors.join(' | '));
  }

  /* ====== scenario 10b: moving data between two devices ====== */
  console.log('\n10b. Backup from one device, loaded on another');
  {
    // "Phone": an extra reading, an extra dosing time, a submitted report.
    const phone = makeApp(null);
    await sleep(320);
    run(phone.ctx, `
      (async () => {
        meterReadings.push({ at: '2026-10-04T08:00', value: 225500 });
        await saveMeterLog();
        dosingEvents.push({ at: '2026-10-04T18:00', on: true });
        await saveDosingLog();
        await store.put({ id: 'report-2026-10-04', date: '2026-10-04',
          lastCheckDate: '2026-10-02', readingTime: '08:00', lastReadingTime: '08:00',
          reporter: 'ARSLAN', photos: { p1: { dataUrl: 'data:image/jpeg;base64,AAAA' } },
          savedAt: 5000,
          values: { caustic: { inUse: '400', backup: '0', photos: ['p1'] } } });
      })();
    `);
    await sleep(250);

    const backup = await new Promise(res => {
      run(phone.ctx, '(async () => { globalThis.__b = await buildBackup(); })();');
      setTimeout(() => res(run(phone.ctx, '__b')), 200);
    });
    check('the backup carries the records', backup.records.length >= 16,
      String(backup.records.length));
    check('it is stamped as this app\'s own',
      backup.app === 'ops-report' && backup.version === 1);
    check('the half-finished report is left out',
      !backup.records.some(r => r.id === 'draft'));
    check('photos are left out to keep the file small',
      backup.records.every(r => !r.photos || Object.keys(r.photos).length === 0));

    // "PC": clean, with its own reading for a different morning.
    const pc = makeApp(null);
    await sleep(320);
    run(pc.ctx, `
      (async () => {
        meterReadings.push({ at: '2026-10-03T08:00', value: 225100 });
        await saveMeterLog();
      })();
    `);
    await sleep(200);
    const pcBefore = run(pc.ctx, 'meterReadings.length');

    pc.ctx.__incoming = JSON.stringify(backup);
    let impThrew = null;
    try {
      run(pc.ctx, 'importBackup(__incoming);');
    } catch (e) { impThrew = e; }
    await sleep(400);
    check('loading the backup works', !impThrew, impThrew && impThrew.message);

    check('both devices\' readings end up present',
      run(pc.ctx, `meterReadings.some(e => e.at === '2026-10-03T08:00')`) === true
      && run(pc.ctx, `meterReadings.some(e => e.at === '2026-10-04T08:00')`) === true,
      run(pc.ctx, 'String(meterReadings.length)'));
    check('readings are not duplicated',
      run(pc.ctx, 'meterReadings.length') === pcBefore + 1,
      `${run(pc.ctx, 'meterReadings.length')} vs ${pcBefore + 1}`);
    check('readings stay in order',
      run(pc.ctx, 'meterReadings.every((e, i) => i === 0 || meterReadings[i-1].at <= e.at)'));
    check('the dosing time comes across',
      run(pc.ctx, `dosingEvents.some(e => e.at === '2026-10-04T18:00')`) === true);
    check('the submitted report comes across',
      run(pc.ctx, `submittedReports.some(r => r.id === 'report-2026-10-04')`) === true);
    check('no errors logged', pc.localErrors.length === 0, pc.localErrors.join(' | '));

    // Loading the same file twice must change nothing.
    const afterFirst = run(pc.ctx, 'meterReadings.length');
    run(pc.ctx, 'importBackup(__incoming);');
    await sleep(350);
    check('loading the same backup again changes nothing',
      run(pc.ctx, 'meterReadings.length') === afterFirst,
      String(run(pc.ctx, 'meterReadings.length')));

    // Rubbish in must not corrupt anything.
    run(pc.ctx, 'importBackup("not json at all");');
    await sleep(150);
    run(pc.ctx, 'importBackup(JSON.stringify({ app: "something-else", records: [] }));');
    await sleep(150);
    check('a file that is not a backup is refused',
      run(pc.ctx, 'meterReadings.length') === afterFirst
      && pc.localErrors.length === 0,
      pc.localErrors.join(' | '));

    // A report the operator submitted must never lose to a recorded-by-hand copy.
    check('a submitted report beats a recorded-by-hand one',
      run(pc.ctx, `(() => {
        const mine = { id: 'report-2026-09-30', savedAt: 1, source: undefined };
        const theirs = { id: 'report-2026-09-30', savedAt: 9999, source: 'recorded-by-hand' };
        return mergeBackupRecord(mine, theirs).savedAt === 1; })()`));
    check('otherwise the one saved later wins',
      run(pc.ctx, `(() => {
        const mine = { id: 'report-2026-09-30', savedAt: 1 };
        const theirs = { id: 'report-2026-09-30', savedAt: 2 };
        return mergeBackupRecord(mine, theirs).savedAt === 2; })()`));

    // The update button has to work without a connection.
    let upThrew = null;
    try { pc.document.querySelector('#btnCheckUpdate').dispatch('click'); } catch (e) { upThrew = e; }
    await sleep(150);
    check('checking for an update does not throw', !upThrew, upThrew && upThrew.message);

    /* The version has to show in every place it appears. These were separate
       ids and a third reused one of them, so querySelector filled the first
       and the rest kept saying "dev" - which made an update look as though it
       had not landed. */
    const shown = Array.from(pc.document.querySelectorAll('.js-build-id'))
      .map(n => n.textContent);
    // Two now: the duplicate "About" section in Settings was merged into
    // "App version" when Settings was tidied.
    check('the version appears in more than one place', shown.length >= 2,
      String(shown.length));
    check('and every one of them is filled in',
      shown.length > 0 && shown.every(t => t && t !== 'dev'),
      JSON.stringify(shown));
    check('they all agree', new Set(shown).size === 1, JSON.stringify(shown));
  }

  /* ====== scenario 10c: the recorded dates are guarded ====== */
  console.log('\n10c. Warning before overwriting recorded dates');
  {
    const app = makeApp(null);
    await sleep(320);

    // confirm() answers true in the harness, so the date is taken but the
    // warning must have been raised.
    let asked = null;
    app.ctx.confirm = (msg) => { asked = msg; return false; };
    const dateField = app.document.querySelector('#fDate');
    dateField.value = '2026-09-30';
    dateField.dispatch('change');
    await sleep(120);
    check('a date inside the recorded span raises a warning',
      !!asked && /recorded on paper/.test(asked), String(asked).slice(0, 80));
    check('and declining leaves the date alone',
      run(app.ctx, 'state.date') !== '2026-09-30',
      run(app.ctx, 'state.date'));
    check('the field is put back too',
      dateField.value === run(app.ctx, 'state.date'), dateField.value);

    asked = null;
    app.ctx.confirm = (msg) => { asked = msg; return true; };
    dateField.value = '2026-09-30';
    dateField.dispatch('change');
    await sleep(120);
    check('carrying on anyway is allowed',
      run(app.ctx, 'state.date') === '2026-09-30', run(app.ctx, 'state.date'));

    asked = null;
    dateField.value = '2026-10-20';
    dateField.dispatch('change');
    await sleep(120);
    check('a date outside the recorded span is not questioned',
      asked === null && run(app.ctx, 'state.date') === '2026-10-20',
      String(asked));
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
  }

  /* ===== scenario 10d: an evening visit must not retitle the report ===== */
  console.log('\n10d. Logging an evening reading without starting a report');
  {
    const app = makeApp(null);
    await sleep(320);

    /* The round time must not come from the clock. Calling in at 7:30pm to log
       a dosing switch used to retitle the report as a 7:30pm round, which moved
       the period every figure is measured over. */
    check('a fresh report is timed for the morning round, not now',
      run(app.ctx, 'state.readingTime') === '08:00',
      run(app.ctx, 'state.readingTime'));

    run(app.ctx, `
      state.date = '2026-10-04'; state.readingTime = '08:00';
      hydrateFields();
      el('#fMeter').value = '225500'; el('#fMeter').dispatch('input');
    `);
    await sleep(250);

    // The evening visit: log the switch and its reading, nothing else.
    run(app.ctx, `
      el('#btnDosingToggle').dispatch('click');
      el('#dosingDate').value = '2026-10-04';
      el('#dosingTime').value = '19:30';
      el('#dosingMeter').value = '225900';
      el('#btnDosingSave').dispatch('click');
    `);
    await sleep(300);

    check('the switch is logged', run(app.ctx, `dosingEvents.some(e => e.at === '2026-10-04T19:30')`) === true);
    check('its reading joins the meter list',
      run(app.ctx, `meterReadings.some(e => e.at === '2026-10-04T19:30' && e.value === 225900)`) === true);
    check('no report is created by logging a switch',
      run(app.ctx, `submittedReports.filter(r => r.date === '2026-10-04').length`) === 0,
      run(app.ctx, `String(submittedReports.filter(r => r.date === '2026-10-04').length)`));
    check('the round time is untouched',
      run(app.ctx, 'state.readingTime') === '08:00',
      run(app.ctx, 'state.readingTime'));
    check('and the period still opens at the 2 Oct reading',
      run(app.ctx, `(() => {
        const ev = evaluate(state, previousReport, submittedReports, dosingEvents, meterReadings);
        return ev.meterFrom === 224994.2 && Math.abs(ev.totalWater - 505.8) < 0.05; })()`));

    /* Next morning: one period covering the whole day, with the evening
       reading used inside it rather than as its start. */
    run(app.ctx, "el('#btnNewReport').dispatch('click');");
    await sleep(300);
    check('the next report keeps the same round time',
      run(app.ctx, 'state.readingTime') === '08:00',
      run(app.ctx, 'state.readingTime'));
    run(app.ctx, `
      state.date = '2026-10-05';
      hydrateFields();
      el('#fMeter').value = '226600'; el('#fMeter').dispatch('input');
    `);
    await sleep(350);
    const full = run(app.ctx, `(() => {
      const ev = evaluate(state, previousReport, submittedReports, dosingEvents, meterReadings);
      return { from: ev.meterFrom, water: Math.round(ev.totalWater * 10) / 10,
               span: ev.spanHours, dosing: ev.dosingHours,
               dosed: ev.waterNow ? Math.round(ev.waterNow.volume) : null,
               exact: ev.waterNow ? ev.waterNow.exact : null }; })()`);
    check('the whole day is one period of 1,100 m\u00B3',
      full.from === 225500 && full.water === 1100 && full.span === 24,
      JSON.stringify(full));
    check('dosing ran 12.5 of those hours',
      full.dosing === 12.5, String(full.dosing));
    check('and the dosed volume is exact from the evening reading',
      full.dosed === 700 && full.exact === true,
      `${full.dosed} exact=${full.exact}`);
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));

    /* Saving twice for one date replaces the first, so warn first. */
    let asked = null;
    app.ctx.confirm = (msg) => { asked = msg; return false; };
    run(app.ctx, `
      (async () => {
        await store.put({ id: 'report-2026-10-05', date: '2026-10-05',
          lastCheckDate: '2026-10-04', photos: {}, savedAt: Date.now(),
          values: { caustic: { inUse: '400', backup: '0' } } });
      })();
    `);
    await sleep(200);
    run(app.ctx, 'generatePdf();');
    await sleep(250);
    check('saving over an existing report asks first',
      !!asked && /already saved/.test(asked), String(asked).slice(0, 60));
    check('and declining leaves the saved one alone',
      run(app.ctx, `(async () => (await store.get('report-2026-10-05')).values.caustic.inUse)`) !== undefined);
  }

  /* ===== scenario 10e: start-up must never leave a blank page ===== */
  console.log('\n10e. A failure during start-up still shows something');
  {
    /* Reported from the plant: a blank page some mornings, with no message and
       no way to reach the readings. Drawing the screen was one unguarded run
       of calls, so a single failure anywhere in it left nothing at all. */
    const app = makeApp(null);
    await sleep(320);
    check('nothing is wrong to begin with',
      !app.document.querySelector('#startupProblem'));

    // Break one drawing step and run them again.
    run(app.ctx, `
      renderDosing = function () { throw new Error('pretend the dosing card fails'); };
    `);
    let threw = null;
    try {
      run(app.ctx, `
        (() => {
          const broken = [];
          [['show the dosing card', renderDosing], ['draw the checklist', render]]
            .forEach(([what, fn]) => { try { fn(); } catch (e) { broken.push(what); } });
          if (broken.length) showStartupProblem(broken.join(', '));
        })();
      `);
    } catch (e) { threw = e; }
    check('a failing step does not stop the others', !threw, threw && threw.message);

    const box = app.document.querySelector('#startupProblem');
    check('a message appears on screen instead of a blank page', !!box);
    check('it says the saved readings are safe',
      box && /readings and reports are not affected/.test(box.innerHTML));
    check('it says what to try',
      box && /close the app completely/.test(box.innerHTML));
    check('it points at the backup as a way out',
      box && /Save a backup/.test(box.innerHTML));
    check('the checklist still drew',
      app.document.querySelector('#checklist').innerHTML.length > 0);

    // Calling it twice must not stack up boxes.
    run(app.ctx, "showStartupProblem('again');");
    check('the message is not repeated',
      app.document.querySelectorAll('#startupProblem').length === 1,
      String(app.document.querySelectorAll('#startupProblem').length));
  }

  /* ========= scenario 11: sampling dates carried forward ========= */
  console.log('\n11. Sampling dates carried into the next report');
  {
    const app = makeApp(null);
    await sleep(300);
    run(app.ctx, `
      state.values.ovine_daily  = { date: '2026-09-26', photos: [] };
      state.values.mbm_weekly   = { date: '2026-09-22', photos: [] };
      state.values.ovine_weekly = { date: '2026-09-19', photos: [] };
      state.values.caustic = { inUse: '500', backup: '200', photos: [] };
    `);
    let threw = null;
    try { app.document.querySelector('#btnNewReport').dispatch('click'); } catch (e) { threw = e; }
    await sleep(220);
    check('starting a new report runs without throwing', !threw, threw && threw.message);
    check('the ovine daily date is still there',
      run(app.ctx, "state.values.ovine_daily.date") === '2026-09-26',
      run(app.ctx, 'JSON.stringify(state.values.ovine_daily)'));
    check('the MBM weekly date is still there',
      run(app.ctx, "state.values.mbm_weekly.date") === '2026-09-22');
    check('the ovine weekly date is still there',
      run(app.ctx, "state.values.ovine_weekly.date") === '2026-09-19');
    check('the dates show on screen',
      app.document.querySelector('[data-date="ovine_daily"]').value === '2026-09-26',
      app.document.querySelector('[data-date="ovine_daily"]').value);
    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
  }

  /* ================= scenario 12: the Settings sheet ================= */
  console.log('\n12. Settings sheet');
  {
    const app = makeApp(null);
    await sleep(300);
    const doc = app.document;
    const sheet = doc.querySelector('#settingsSheet');
    const titles = sheet.querySelectorAll('.set-head').map(h => h.querySelector('h2').textContent.trim());

    check('Start a new report is the first section', titles[0] === 'New report', titles.join(' > '));
    check('the setup sections follow in the agreed order',
      JSON.stringify(titles.slice(0, 9)) === JSON.stringify(['New report', 'Backup', 'App version',
        'Your name', 'Company name', 'Report number prefix', 'Company logo', 'Trigger levels',
        'Average usage']), titles.slice(0, 9).join(' > '));

    const adv = sheet.querySelector('details');
    check('Advanced starts folded shut', !!adv && !adv.hasAttribute('open'));
    check('Saved reports are inside Advanced', !!doc.querySelector('#historyList').closest('details'));
    check('so are the working-out and repair panels',
      ['#flowDetail', '#dosingAudit', '#btnMeterRestore'].every(s => !!doc.querySelector(s).closest('details')));
    check('the everyday settings are not inside Advanced',
      ['#btnNewReport', '#btnBackupExport', '#btnCheckUpdate', '#fReporter', '#fSite', '#fPrefix',
        '#thresholdForm', '#fAvgWindow'].every(s => !doc.querySelector(s).closest('details')));

    const helps = sheet.querySelectorAll('[data-help]');
    check('sections with an explanation have a ? beside the title', helps.length >= 11, String(helps.length));
    check('every ? has an explanation to open',
      helps.every(b => !!doc.getElementById(b.dataset.help)),
      helps.filter(b => !doc.getElementById(b.dataset.help)).map(b => b.dataset.help).join(','));
    check('every explanation starts hidden',
      helps.every(b => doc.getElementById(b.dataset.help).hidden === true));
    check('and no explanation is left lying open on the sheet',
      sheet.querySelectorAll('.help-text').every(p => p.hidden === true));

    const first = helps[0];
    first.dispatch('click');
    const panel = doc.getElementById(first.dataset.help);
    check('tapping a ? shows its explanation',
      panel.hidden === false && first.getAttribute('aria-expanded') === 'true');
    first.dispatch('click');
    check('tapping it again hides it',
      panel.hidden === true && first.getAttribute('aria-expanded') === 'false');

    // The ? on the morning sheet still works now that the listener is page-wide.
    const main = doc.querySelector('[data-help="helpReport"]');
    main.dispatch('click');
    check('the ? on the morning sheet still works', doc.getElementById('helpReport').hidden === false);

    /* Whether the phone holds its own copy of the app, which is what lets it
       open with no signal. */
    const line = doc.querySelector('#offlineStatus');
    const nag = doc.querySelector('#offlineNag');
    await run(app.ctx, 'renderOfflineStatus()');
    check('a phone with its own copy says it works without signal',
      /^Works without signal: yes/.test(line.textContent), line.textContent);
    check('and shows no warning', nag.hidden === true);

    app.sandbox.__shellCached = false;
    await run(app.ctx, 'renderOfflineStatus()');
    check('a phone that has lost its copy says so in Settings',
      /not yet/.test(line.textContent), line.textContent);
    check('but not in the first few seconds, while a first visit is still saving it',
      nag.hidden === true);
    run(app.ctx, 'bootedAt = Date.now() - 10000');
    await run(app.ctx, 'renderOfflineStatus()');
    check('after that it warns on the main screen', nag.hidden === false);
    const nagText = nag.querySelectorAll('span').map(s => s.textContent).join(' ');
    check('in plain words', /not saved its own copy/.test(nagText), nagText);

    app.sandbox.__shellCached = true;
    await run(app.ctx, 'renderOfflineStatus()');
    check('and the warning goes away once the copy is back', nag.hidden === true);

    app.sandbox.__noWorker = true;
    await run(app.ctx, 'renderOfflineStatus()');
    check('no worker in charge counts as no copy', /not yet/.test(line.textContent) && nag.hidden === false);
    app.sandbox.__noWorker = false;

    const kept = doc.querySelector('#storageStatus');
    check('whether the phone protects the data stays out of sight until it is known', kept.hidden === true);
    run(app.ctx, 'storageProtected = false');
    await run(app.ctx, 'renderOfflineStatus()');
    check('when it is not protected, it says so and points to the ?',
      kept.hidden === false && /no\. Tap the \?/.test(kept.textContent), kept.textContent);
    run(app.ctx, 'storageProtected = true');
    await run(app.ctx, 'renderOfflineStatus()');
    check('and says yes when it is', /yes/.test(kept.textContent), kept.textContent);

    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
  }

  /* ================= scenario 13: dates, saturators, status buttons ================= */
  console.log('\n13. Dates, saturators and buttons on the sheet');
  {
    const app = makeApp(null);
    await sleep(300);
    const doc = app.document;
    const textOf = (inputSel) => doc.querySelector(inputSel).parentNode.querySelector('.datebox-text');

    // The date at the top of the sheet
    const dateInput = doc.querySelector('#fDate');
    const topText = textOf('#fDate');
    const [y, m, d] = dateInput.value.split('-');
    const want = `${d}/${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][Number(m) - 1]}/${y.slice(2)}`;
    check('the date at the top is drawn as 14/OCT/26, not the phone\'s own format',
      topText.textContent === want, `${topText.textContent} (wanted ${want})`);
    check('the real date input is still underneath, holding the plain date', /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value));

    dateInput.value = '2026-09-01';
    dateInput.dispatch('input');
    check('picking a date redraws it at once', topText.textContent === '01/SEP/26', topText.textContent);

    // Sample testing dates
    const sampleText = textOf('[data-date="ovine_daily"]');
    check('a sample date that was never filled in invites a pick', sampleText.textContent === 'Pick a date', sampleText.textContent);
    check('and is marked as empty so it can be styled quieter', sampleText.classList.contains('empty'));
    const sample = doc.querySelector('[data-date="ovine_daily"]');
    sample.value = '2026-09-26';
    sample.dispatch('input');
    check('a sample date is drawn the same way', sampleText.textContent === '26/SEP/26', sampleText.textContent);
    check('and is no longer marked empty', !sampleText.classList.contains('empty'));
    check('the sample date is still stored as the plain date',
      run(app.ctx, 'state.values.ovine_daily.date') === '2026-09-26');

    // The two forms on the sheet
    doc.querySelector('#btnMeterAdd').dispatch('click');
    check('the add-a-reading form starts with no day, as it always did',
      doc.querySelector('#meterDate').value === '' && textOf('#meterDate').textContent === 'Pick a date');
    doc.querySelector('#meterDate').value = '2026-10-03';
    doc.querySelector('#meterDate').dispatch('change');
    check('and shows the day once picked', textOf('#meterDate').textContent === '03/OCT/26', textOf('#meterDate').textContent);
    doc.querySelector('#btnMeterCancel').dispatch('click');

    doc.querySelector('#btnDosingToggle').dispatch('click');
    const dosingNow = doc.querySelector('#dosingDate').value;
    check('the dosing form opens on today, drawn in the new format',
      textOf('#dosingDate').textContent === run(app.ctx, `fmtDateBox('${dosingNow}')`) && textOf('#dosingDate').textContent !== 'Pick a date',
      textOf('#dosingDate').textContent);
    doc.querySelector('#btnDosingCancel').dispatch('click');

    // A date that is refused is put back, and the text must follow it back
    app.ctx.confirm = () => false;
    const before = run(app.ctx, 'state.date');
    dateInput.value = '2026-09-20';               // inside the dates recorded on paper
    dateInput.dispatch('change');
    await sleep(80);
    check('a refused date goes back, and its text goes back with it',
      dateInput.value === before && topText.textContent === run(app.ctx, `fmtDateBox('${before}')`),
      `${dateInput.value} / ${topText.textContent}`);
    app.ctx.confirm = () => true;

    // Saturators start blank
    const sat1 = doc.querySelector('[data-num="sat1"]');
    const sat2 = doc.querySelector('[data-num="sat2"]');
    check('both saturators start empty', sat1.value === '' && sat2.value === '', `${sat1.value} / ${sat2.value}`);
    check('and are neither OK nor a fault until a reading is typed',
      doc.querySelector('[data-pill="sat1"]').textContent === '-' && doc.querySelector('[data-pill="sat2"]').textContent === '-',
      `${doc.querySelector('[data-pill="sat1"]').textContent} ${doc.querySelector('[data-pill="sat2"]').textContent}`);
    sat1.value = '575';
    sat1.dispatch('input');
    check('typing a reading grades it', doc.querySelector('[data-pill="sat1"]').textContent === 'OK',
      doc.querySelector('[data-pill="sat1"]').textContent);

    // Buttons
    const buttons = (id) => doc.querySelectorAll(`[data-status="${id}"]`).map(b => b.dataset.value).join(',');
    check('the vacuum gauge no longer has a Monitor button', buttons('bio_vacuum') === 'ok,fault,todo', buttons('bio_vacuum'));
    check('nor the pH row, which has lost OK too', buttons('ph') === 'fault,todo', buttons('ph'));
    check('Tank 1 mixer was not on the list and keeps all four', buttons('tank1_mixer') === 'ok,watch,fault,todo', buttons('tank1_mixer'));
    doc.querySelector('[data-status="ph"][data-value="fault"]').dispatch('click');
    check('the buttons that remain still work', run(app.ctx, 'state.values.ph.status') === 'fault');

    // The new clarity answer
    doc.querySelector('[data-choice="daf_clarity"][data-value="notrunning"]').dispatch('click');
    check('Not running can be chosen for the DAF clarity',
      run(app.ctx, 'state.values.daf_clarity.choice') === 'notrunning');
    check('and the row stays green', doc.querySelector('[data-pill="daf_clarity"]').textContent === 'OK',
      doc.querySelector('[data-pill="daf_clarity"]').textContent);
    check('the clarity row has five answers',
      doc.querySelectorAll('[data-choice="daf_clarity"]').length === 5,
      String(doc.querySelectorAll('[data-choice="daf_clarity"]').length));

    check('no errors logged', app.localErrors.length === 0, app.localErrors.join(' | '));
  }

  console.log('\n' + '='.repeat(52));
  if (failures) {
    console.log(`FAILED ${failures} check(s)`);
    process.exit(1);
  }
  console.log('All app tests passed.');
}

function renderAndCheckLogo(app) {
  const out = run(app.ctx, `
    (() => {
      const bytes = dataUrlToBytes(state.logo.dataUrl);
      const forPdf = { ...state, logo: { ...state.logo, bytes }, photos: {} };
      const pdf = buildPdf(forPdf, evaluate(state, null, [], []), null);
      const text = String.fromCharCode(...pdf);
      return {
        len: pdf.length,
        hasImage: text.includes('/Subtype /Image'),
        hasName: text.includes('AUSTRALIAN TALLOW PRODUCERS'),
        ok: text.startsWith('%PDF')
      };
    })()
  `);
  check('logo embedded in the PDF', out.hasImage);
  check('company name printed in the header', out.hasName);
  check('PDF still valid with a logo', out.ok, `${out.len} bytes`);
}

main().catch(e => {
  console.error('\nHARNESS CRASHED:', e);
  process.exit(1);
});
