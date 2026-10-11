/* Builds a PDF from sample data by loading the browser scripts in a VM.
   Used to prove the PDF writer works before the app ever runs on a phone.

   Usage: node tools/build_test_pdf.js out.pdf [photoA.jpg photoB.jpg]
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WWW = path.join(__dirname, '..', 'www');
const outPath = process.argv[2] || 'out.pdf';
const photoPaths = process.argv.slice(3);

const sandbox = { console, JSON, Math, Date, Number, String, Array, Object, isFinite, Uint8Array };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

for (const file of ['config.js', 'pdf.js', 'report.js']) {
  vm.runInContext(fs.readFileSync(path.join(WWW, file), 'utf8'), ctx, { filename: file });
}

/* ---- sample data ---- */

const photos = {};
photoPaths.forEach((p, i) => {
  const bytes = new Uint8Array(fs.readFileSync(p));
  let w = 640, h = 480;
  for (let j = 2; j < bytes.length - 9; j++) {
    if (bytes[j] === 0xFF && (bytes[j + 1] === 0xC0 || bytes[j + 1] === 0xC2)) {
      h = (bytes[j + 5] << 8) | bytes[j + 6];
      w = (bytes[j + 7] << 8) | bytes[j + 8];
      break;
    }
  }
  photos['p' + i] = { bytes, width: w, height: h, dataUrl: '' };
});
const photoIds = Object.keys(photos);

/* Yesterday, so chemical usage has something to measure against. */
const previous = {
  date: '2026-09-23',
  values: { sat1: { value: 640 } }
};

const state = {
  date: '2026-09-29',
  lastCheckDate: '2026-09-28',
  reporter: 'HAFIZ SHAKEEB ARSLAN',
  site: 'AUSTRALIAN TALLOW PRODUCERS',
  reportPrefix: 'ATP-DOR',
  generalNote: 'Acid dosing pump checked twice during the shift.',
  thresholds: JSON.parse(JSON.stringify(vm.runInContext('DEFAULT_THRESHOLDS', ctx))),
  photos,
  values: {
    bio_running: { status: 'ok' },
    bio_target: { status: 'ok' },
    bio_vacuum: { status: 'ok' },
    bio1_rh: { choice: 'ok' },
    bio2_rh: { choice: 'fault', note: 'sensor still down' },

    // 1500 -> 1100, no delivery, so 400 L used (the example from the brief)
    caustic:    { prevInUse: 1000, prevBackup: 1000, inUse: 500, backup: 1000, ibc: 1 },
    // a delivery arrived: 1700 + 1000 - 2200 = 500 L used
    coagulant:  { prevInUse: 700, prevBackup: 1000, inUse: 700, backup: 1500, ibc: 1 },
    // away for a few days and deliveries could not be confirmed
    flocculant: { prevInUse: 700, prevBackup: 50, inUse: 550, backup: 0, unknownDelivery: true,
                  note: 'was away, deliveries not confirmed' },
    sulphuric:  { prevInUse: 1000, prevBackup: 0, inUse: 500, backup: 0, photos: photoIds.slice(0, 1) },

    daf_pumps:   { status: 'ok' },
    daf_paddles: { status: 'ok' },
    daf_clarity: { choice: 'turbid', photos: photoIds.slice(1, 2) },
    no_overflow: { status: 'ok' },
    waste_tanks: { status: 'ok' },
    sat1: { value: 600 },
    sat2: { value: 500 },
    ph: { a: 5.2, b: 7.1, c: 6.3 },
    tank1_mixer: { status: 'ok' },
    floc_mixer:  { status: 'ok' },
    flow_rate:   { value: 19 },

    pit_pump: { status: 'ok' },
    lamb_pit: { choice: 'clean' },
    beef_pit: { choice: 'heavy' },

    duct_lamb_cooker: { status: 'ok' },
    duct_beef_cooker: { status: 'ok' },
    duct_beef_press:  { status: 'ok' },
    duct_drier1: { status: 'ok' },
    duct_drier2: { status: 'fault', note: 'steaming from ducting' },
    duct_drier3: { status: 'ok' },

    boiler1_chem: { prevInUse: 900, inUse: 700 },
    boiler2_chem: { prevInUse: 600, inUse: 1000, added: 1000 },
    blowdown:   { choice: 'done' },
    water_test: { choice: 'notdone' },

    ovine_daily:  { date: '2026-09-20' },
    mbm_weekly:   { date: '2026-09-19' },
    ovine_weekly: { date: '2026-08-19' },
    ovine_bags:   { choice: 'prints' },
    separators:   { tallow: 5, stick: 5, status: 'ok' }
  }
};

sandbox.__state = state;
sandbox.__previous = previous;
const result = vm.runInContext(`
  (() => {
    const ev = evaluate(__state, __previous);
    const bytes = buildPdf(__state, ev, __previous);
    const wa = buildWhatsApp(__state, ev);
    return { bytes, counts: ev.counts, actions: ev.actions, wa,
             usage: {
               caustic: ev.items.caustic.sum,
               coagulant: ev.items.coagulant.sum,
               flocculant: ev.items.flocculant.sum
             } };
  })()
`, ctx);

fs.writeFileSync(outPath, Buffer.from(result.bytes));
console.log(`PDF written: ${outPath} (${result.bytes.length} bytes)`);
console.log('counts:', JSON.stringify(result.counts));

console.log('\nstock sums:');
Object.entries(result.usage).forEach(([k, sum]) => {
  if (!sum) { console.log(`  ${k}: (no sum)`); return; }
  console.log(`  ${k}:`);
  sum.rows.forEach(r => console.log(`     ${r.label.padEnd(24)} ${(r.detail||'').padEnd(14)} ${r.value}`));
  console.log(`     ${'-'.repeat(48)}`);
  console.log(`     ${sum.total.label.padEnd(24)} ${''.padEnd(14)} ${sum.total.value}`);
  if (sum.footer) console.log(`     ${sum.footer}`);
});

console.log('');
Object.entries(result.actions).forEach(([k, v]) => {
  console.log(`actions[${k}]: ${v.length}`);
  v.forEach(a => console.log(`   - [${a.status}] ${a.label}: ${a.reason}`));
});

const waPath = outPath.replace(/\.pdf$/, '') + '-whatsapp.txt';
fs.writeFileSync(waPath, result.wa.map(m => `=== ${m.owner} ===\n${m.text}`).join('\n\n\n'));
console.log(`\nWhatsApp text written: ${waPath}`);
