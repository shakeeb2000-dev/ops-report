/* ------------------------------------------------------------------
   Turns the captured form state into
     a) a professional PDF, and
     b) the two WhatsApp messages.
   ------------------------------------------------------------------ */

/* Taken from the ATP logo: deep forest green with a golden amber accent. */
const BRAND = {
  green:     [13, 105, 56],
  greenDark: [9, 78, 42],
  gold:      [240, 168, 30],
  ink:       [26, 32, 44],
  navy:      [13, 105, 56],   // headers follow the brand green
  slate:     [104, 114, 126],
  // Readings and values: near-black so they are easy to read at a glance.
  value:     [32, 38, 48],
  hairline:  [226, 230, 235],
  zebra:     [248, 250, 249],
  ok:        [13, 105, 56],
  watch:     [193, 128, 6],
  fault:     [183, 40, 40],
  todo:      [110, 118, 129],
  amberBg:   [255, 249, 235],
  redBg:     [253, 243, 242],
  okBg:      [240, 248, 243],
  sumBg:     [243, 248, 244],
  sumEdge:   [186, 213, 195],
  sumInk:    [12, 74, 42],
  chart:     [46, 133, 85],
  chartFaint:[224, 233, 227]
};

/* Which drawn glyph goes with each status. */
const STATUS_ICON = { ok: 'tick', watch: 'bang', fault: 'cross', todo: 'dash', blank: 'dash' };

const GENERIC_REASONS = new Set(['fault reported', 'needs monitoring', 'not completed']);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return `${DAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* The one style for a date shown as a date: 14/OCT/26.

   Defined once, here, because both the report and the morning sheet use it -
   the sheet's date boxes call this too - so the two can never drift apart.
   Returns '' for anything that is not a real YYYY-MM-DD date. */
function styleDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return '';
  return `${m[3]}/${MONTHS[month].toUpperCase()}/${m[1].slice(2)}`;
}

// Same, for the printed page: dates in tables and sentences.
function shortDate(iso) {
  if (!iso) return '-';
  return styleDate(iso) || iso;
}

/* The report's own date, top and bottom of every page: the weekday, then the
   date - "FRI 02/OCT/26". The weekday stays because a Monday report covering
   the weekend reads differently from a Tuesday one. */
function reportDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return `${DAYS[d.getDay()].toUpperCase()} ${styleDate(iso) || iso}`;
}

/* "7:30pm" from a 'YYYY-MM-DDTHH:MM' stamp. The switch times are read as
   times of day, and a 24-hour clock is slower to take in on a printed page. */
function clockTime(stamp) {
  const t = String(stamp || '').split('T')[1];
  if (!t) return '';
  const [hRaw, m] = t.split(':');
  const h = Number(hRaw);
  if (!isFinite(h)) return t;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}${suffix}`;
}

function reportNumber(state) {
  return `${state.reportPrefix || DEFAULT_PREFIX}-${state.date || ''}`;
}

/* "less than a day" / "1 day" / "2.8 days" / "14 days" */
function fmtDays(n) {
  if (n === null || n === undefined) return '';
  if (n < 1) return 'less than a day';
  const rounded = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  if (rounded === 1) return '1 day';
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} days`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------
   Evaluation
   ------------------------------------------------------------------ */

function evaluate(state, previous, history, dosingEvents, meterLog) {
  // Always work from a complete set of thresholds, so a report saved by an
  // older version cannot bring the calculation down with a missing limit.
  const thresholds = mergeThresholds(state.thresholds);
  const gapDays = daysBetween(state.lastCheckDate, state.date);
  const submitted = history || [];
  const avgWindow = state.avgWindowDays || DEFAULT_AVG_WINDOW;
  const daf = dosingEvents || [];

  // Flow rate while dosing, measured only from exact periods. Used to fill in
  // any stretch where the meter was not noted at the switch.
  const log = meterLog || [];

  /* This morning's reading: the newest one up to the reading time.

     An exact timestamp match is too brittle. The reading is filed under the
     time the round was done, so editing that time afterwards left the reading
     stranded at the old moment and the report found nothing for today - which
     printed an opening meter line with no closing one, no water total, and an
     estimated volume over a period of an hour and a half. */
  const nowStamp = readingStamp(state.date, state.readingTime);
  const sameDay = meterSorted(log)
    .filter(e => e.at <= nowStamp && String(e.at).split('T')[0] === state.date);
  const toEntry = sameDay.length ? sameDay[sameDay.length - 1] : null;
  const meterTo = toEntry ? num(toEntry.value) : num(state.meter);
  const meterToAt = toEntry ? toEntry.at : (num(state.meter) !== null ? nowStamp : null);

  /* The reading this report measures from.

     It has to be the one taken at the last tank check, because that is the
     period the chemical usage covers. Taking the newest earlier reading
     instead loses water: a reading noted at 6pm when the dosing was switched
     on would open the next report at 6pm, and the water that passed between
     the morning check and 6pm would fall into no report at all. Readings
     inside the period still count, as anchors that make the dosed volume
     exact rather than estimated.

     It must also genuinely come first. The last-check date and time are
     carried over from the previous report, so editing this report's date or
     reading time can leave that moment at or after this one - which printed
     the two readings in reverse, water of -400 m3, and "0.0 of those
     -11.5 hrs". When that happens the newest reading before this report's own
     moment is used instead. */
  let openedBy = meterOpening(log, state.lastCheckDate, state.lastReadingTime, nowStamp);
  if (openedBy && meterToAt && openedBy.at >= meterToAt) {
    openedBy = meterBefore(log, meterToAt);
  }
  const meterFrom = openedBy ? num(openedBy.value) : num(state.prevMeter);

  /* One record per morning, today's being whatever is on screen.

     Submitting a report archives it, so from that moment the same morning
     exists both in storage and on screen. Counting both would weight that day
     twice - in the averages and in the measured flow rate alike - so the saved
     copy of today is dropped and the live one used in its place. */
  const periods = submitted
    .filter(r => r.date !== state.date)
    .concat([{
      date: state.date, lastCheckDate: state.lastCheckDate,
      readingTime: state.readingTime, lastReadingTime: state.lastReadingTime,
      meter: meterTo, prevMeter: meterFrom,
      values: state.values
    }]);

  const flowRate = daf.length ? dosingFlowRate(periods, daf, log) : null;

  /* The stretch the water figures describe: exactly the two readings shown.

     Hours and water must come from the same two moments. They used to be
     measured over different periods - the water from the meter readings, the
     hours from the tank-check date - so the report could print a water figure
     next to "dosing was on 0.0 hrs", which reads as nonsense. */
  const spanFrom = openedBy ? openedBy.at
    : (state.lastCheckDate ? readingStamp(state.lastCheckDate, state.lastReadingTime) : null);
  const spanTo = meterToAt || nowStamp;
  const spanHours = (spanFrom && toMs(spanFrom) !== null && toMs(spanTo) !== null)
    ? Math.round(((toMs(spanTo) - toMs(spanFrom)) / 3600000) * 100) / 100
    : null;
  /* Both ends must be known, the period must run forwards, and the meter must
     not have gone backwards across it. Reporting any of those anyway is what
     produced blocks that made no sense. */
  const spanWhole = !!(spanFrom && spanTo && meterFrom !== null && meterTo !== null
    && spanHours !== null && spanHours > 0 && meterTo >= meterFrom);
  /* The on/off switches inside the period, with the meter reading at each.

     Without these the report shows only the two period readings, so the
     reading the dosed volume is actually measured from never appears anywhere
     - which makes the dosed figure look as though it came from the wrong
     number. */
  /* Strictly before the closing moment. A switch at the exact end of a period
     starts or stops the dosing for the *next* one and contributes nothing
     here, so listing it put "Dosing switched on 7:30pm" directly above
     "0.0 hrs dosing" and read as a contradiction. */
  const switches = spanFrom
    ? daf
      .filter(e => e && e.at && e.at >= spanFrom && e.at < spanTo)
      .slice()
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .map(e => {
        const logged = meterAtStamp(log, e.at);
        return { at: e.at, on: !!e.on, meter: logged !== null ? logged : num(e.meter) };
      })
    : [];

  const dosingHours = (daf.length && spanWhole)
    ? dosingHoursBetween(daf, spanFrom, spanTo) : null;
  const waterNow = (daf.length && spanWhole)
    ? dosedWater(spanFrom, spanTo, meterFrom, meterTo, daf, flowRate, log) : null;

  const result = {
    items: {}, counts: { ok: 0, watch: 0, fault: 0, todo: 0, blank: 0 },
    actions: {}, gapDays, dosingHours,
    waterNow, flowRate,
    // The two moments the water figures cover, so the report can label them.
    spanFrom, spanTo, spanHours, switches,
    /* Including the one at the closing moment, so the report can explain that
       the dosing started right at the end rather than leave a bare zero. */
    allSwitches: spanFrom
      ? daf.filter(e => e && e.at && e.at >= spanFrom && e.at <= spanTo)
        .map(e => ({ at: e.at, on: !!e.on }))
      : [],
    /* What stops the water being worked out, so the report can say so instead
       of printing a block with holes in it - or nothing at all, which is what
       a period that did not make sense used to produce. */
    meterMissing: meterTo === null ? 'today'
      : (meterFrom === null ? 'earlier' : (spanWhole ? null : 'period')),
    /* The days the water speed is measured from, with their figures.

       Carried out of here so the app can show the working. The speed is an
       average over past days and there is no way to tell from the number alone
       which days went into it, which makes a surprising value impossible to
       account for without reading the stored data by hand. */
    flowDetail: daf.length ? flowRateDays(periods, daf, log) : [],
    flowAll: daf.length ? flowRateCandidates(periods, daf, log) : [],
    flowDays: daf.length ? dosingFlowDays(periods, daf, log) : 0,
    meterFrom, meterTo,
    // When the earlier reading was actually taken. The last stock check and
    // the last meter reading are not always the same morning, so the label has
    // to come from the reading itself rather than from the stock date.
    meterFromAt: openedBy ? openedBy.at : (state.prevMeterAt || null),
    // Only a period that makes sense gets a water figure. A negative one is
    // never a real reading of the plant, only a sign of muddled dates.
    totalWater: spanWhole ? meterTo - meterFrom : null,
    lastCheckDate: state.lastCheckDate || null, stock: []
  };

  CHECKLIST.forEach(section => {
    result.actions[section.id] = [];
    section.groups.forEach(group => {
      group.items.forEach(item => {
        const v = (state.values && state.values[item.id]) || {};
        const manual = v.status && v.status !== STATUS.BLANK ? v.status : null;

        let status = STATUS.BLANK;
        let display = '-';
        let reason = '';
        const extra = [];
        let sum = null;
        // Set for a chemical judged on days left: REORDER, ORDER SOON or REFILL.
        let stockAction = null;

        if (item.type === 'status') {
          status = manual || STATUS.BLANK;
          display = STATUS_META[status].label;

        } else if (item.type === 'choice') {
          const auto = gradeChoice(item, v.choice);
          status = manual || auto;
          display = v.choice ? choiceLabel(item, v.choice) : (manual ? STATUS_META[status].label : '-');
          if (v.choice && needsAction(status)) reason = choiceLabel(item, v.choice).toLowerCase();

        } else if (item.type === 'number') {
          const n = num(v.value);
          status = manual || (n === null ? STATUS.BLANK : gradeNumber(n, item.threshold, thresholds));
          if (n === null) {
            display = manual ? 'No reading' : '-';
          } else {
            display = fmtQty(n, item.decimals) + (item.unit ? ' ' + item.unit : '');
            reason = numberReason(item, n, item.threshold, thresholds, status);
          }

        } else if (item.type === 'multi') {
          const readings = item.fields.map(f => num(v[f.key]));
          const any = readings.some(r => r !== null);
          status = manual || gradeMulti(item, v, thresholds);
          if (!any) {
            display = manual ? 'Not recorded' : '-';
          } else if (item.display === 'labelled') {
            display = item.fields
              .map((f, i) => `${f.label} ${readings[i] === null ? '-' : fmtQty(readings[i], item.decimals)}`)
              .join(', ');
          } else {
            display = readings
              .map(r => r === null ? '-' : fmtQty(r, item.decimals)).join(' / ');
          }
          if (any) reason = multiReason(item, readings, thresholds, status);

        } else if (item.type === 'stock') {
          const inUse = num(v.inUse);
          const backup = item.hasBackup ? num(v.backup) : null;
          const onHand = stockOnHand(item, v);
          const hasAny = onHand !== null;

          const usage = stockUsage(item, v, gapDays);

          // Average across the window, over one record per morning.
          const stats = usageStats(item, periods,
            avgWindow, state.date, daf, flowRate, log);

          // Chemicals are judged on litres per cubic metre treated; the boiler
          // tanks stay on calendar days.
          const byDose = item.topUp === 'ibc' && stats.avgDose;
          const waterLeft = byDose ? waterLeftFromDose(onHand, stats.avgDose) : null;
          const hoursLeft = item.topUp === 'ibc' && stats.avgPerHour
            ? hoursLeftFromAverage(onHand, stats.avgPerHour) : null;
          const left = byDose && stats.waterPerDay
            ? waterLeft / stats.waterPerDay
            : (item.topUp === 'ibc' && hoursLeft !== null && stats.hoursPerDay
                ? hoursLeft / stats.hoursPerDay
                : daysLeftFromAverage(onHand, stats.avgPerDay));

          /* The four delivered chemicals are judged on how long they will last
             once that is known; until then, and always for the boiler tanks,
             on their litre levels. "Known" means at least two days of usage
             behind it - the same bar the stock sum sets before it will quote an
             average. One day alone is too jumpy to judge on, and the colour
             must not claim more than the sum underneath it does. */
          const rateKnown = stats.daysCovered >= 2;
          const byDays = hasAny && item.hasBackup && item.topUp === 'ibc' && rateKnown
            ? chemicalByDays({
              inUse, backup, onHand, daysLeft: left,
              perDosingDay: stats.avgPerHour ? stats.avgPerHour * 24 : null
            }, thresholds)
            : null;
          if (byDays) stockAction = byDays.action;
          const levelStatus = !hasAny ? STATUS.BLANK
            : byDays ? byDays.status
              : item.hasBackup
                ? gradeChemical(v, thresholds)
                : gradeNumber(v.inUse, item.threshold, thresholds);

          status = manual || levelStatus;
          display = hasAny
            ? (item.hasBackup
                ? `${fmtQty(inUse)} ${item.unit} in use / ${fmtQty(backup)} ${item.unit} backup`
                : `${fmtQty(inUse)} ${item.unit}`)
            : (manual ? 'Not measured' : '-');

          if (usage) {
            sum = buildStockSum(item, v, usage, left, state, stats,
              dosingHours, hoursLeft, waterNow, waterLeft);
          }

          const bits = [];
          if (hasAny) {
            if (byDays) {
              bits.push(...byDays.reasons);
            } else if (item.hasBackup) {
              const lvl = chemicalReason(v, thresholds);
              if (lvl) bits.push(lvl);
            } else {
              const lvl = numberReason(item, inUse, item.threshold, thresholds, levelStatus);
              if (lvl) bits.push(lvl);
            }
          }
          if (usage && usage.unconfirmed) bits.push('usage not confirmed');
          if (usage && usage.missingLitres > 0) {
            bits.push(usage.missingIbcs > 0
              ? `stock rose unexpectedly - at least ${plural(usage.missingIbcs, 'IBC')} not recorded`
              : `stock rose unexpectedly - ${fmtQty(usage.missingLitres)} ${item.unit} not accounted for`);
          }
          reason = bits.join(', ');

          result.stock.push({
            id: item.id, label: item.label, unit: item.unit, onHand,
            kind: item.topUp === 'ibc' ? 'chemical' : 'boiler',
            avgPerDay: stats.avgPerDay, avgPerHour: stats.avgPerHour,
            avgDose: stats.avgDose, waterCovered: stats.waterCovered,
            waterExact: stats.waterExact, waterLeft,
            daysCovered: stats.daysCovered, hoursCovered: stats.hoursCovered,
            hoursLeft, daysLeft: left,
            unconfirmed: !!(usage && usage.unconfirmed),
            status,
            // How urgent the days-left figure itself is, apart from the usage
            // tank, so the stock table colours "15 days" by the 15 days.
            daysStatus: byDays ? byDays.daysStatus : null
          });

        } else if (item.type === 'date') {
          // Recorded for the record only - no automatic grading. A date that
          // cannot be read counts as nothing recorded.
          const iso = v.date;
          const valid = !!iso && !isNaN(new Date(iso + 'T00:00:00').getTime());
          status = manual || (valid ? STATUS.OK : STATUS.BLANK);
          if (valid) {
            display = `sampled to ${shortDate(iso)}`;
          } else {
            display = manual ? 'No date recorded' : '-';
          }
        }

        if (!reason && needsAction(status)) {
          if (status === STATUS.FAULT) reason = 'fault reported';
          else if (status === STATUS.WATCH) reason = 'needs monitoring';
          else if (status === STATUS.TODO) reason = 'not completed';
        }

        result.counts[status] = (result.counts[status] || 0) + 1;
        const photos = (v.photos || []).filter(id => state.photos && state.photos[id]);
        const optBadge = item.type === 'choice' ? optionBadge(item, v.choice) : null;
        const badge = item.type === 'stock'
          ? (stockAction && !manual && needsAction(status) ? stockAction : stockBadge(item, status, reason))
          : (optBadge || STATUS_META[status].short);
        result.items[item.id] = {
          status, badge, display, reason, extra, sum,
          // A red badge should never be a mystery, so the explanation is
          // printed - unless it is generic, or just repeats the value already
          // shown on the row.
          showReason: needsAction(status) && !!reason
            && !GENERIC_REASONS.has(reason)
            && reason.toLowerCase() !== String(display).toLowerCase(),
          // When the badge spells out the action, repeating the value beside it
          // is noise - and on a narrow row the two would collide.
          hideDisplay: !!optBadge,
          note: v.note || '', photos
        };

        if (needsAction(status)) {
          result.actions[section.id].push({
            label: item.label, group: group.title, groupNumber: group.number,
            status, display, reason: reason || STATUS_META[status].label.toLowerCase(),
            note: v.note || ''
          });
        }
      });
    });
  });

  Object.keys(result.actions).forEach(k => {
    result.actions[k].sort((a, b) =>
      SEVERITY_ORDER.indexOf(b.status) - SEVERITY_ORDER.indexOf(a.status));
  });

  // Worst first: fewest days of stock, unconfirmed last.
  result.stock.sort((a, b) => {
    if (a.daysLeft === null && b.daysLeft === null) return 0;
    if (a.daysLeft === null) return 1;
    if (b.daysLeft === null) return -1;
    return a.daysLeft - b.daysLeft;
  });

  result.verdict = buildVerdict(result);
  return result;
}

/* Joins the footer parts as sentences.

   They are written as fragments so they can be assembled in whatever
   combination the day calls for, which is why the first letter is raised here
   rather than in each one. Separating with full stops rather than dots reads
   as English instead of a list of readings. */
function sentences(parts) {
  return parts
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join('. ') + '.';
}

/* The lines of the stock sum, ready to print as a block. */
function buildStockSum(item, v, usage, left, state, stats, dosingHours, hoursLeft, waterNow, waterLeft) {
  const u = item.unit;
  const lastLabel = state.lastCheckDate
    ? `Last check (${shortDate(state.lastCheckDate)})`
    : 'Last check';

  const rows = [];
  rows.push({
    label: lastLabel,
    detail: item.hasBackup
      ? `${fmtQty(num(v.prevInUse) || 0)} + ${fmtQty(num(v.prevBackup) || 0)}`
      : '',
    value: `${fmtQty(usage.prevTotal)} ${u}`
  });

  if (usage.unconfirmed) {
    rows.push({ label: 'Delivered since', detail: 'not known', value: '?' });
  } else if (item.topUp === 'ibc') {
    rows.push({
      label: 'Delivered since',
      detail: usage.ibcs > 0 ? plural(usage.ibcs, 'IBC') : 'none',
      value: `+${fmtQty(usage.topUp)} ${u}`
    });
  } else {
    rows.push({
      label: 'Added since',
      detail: '',
      value: `+${fmtQty(usage.topUp)} ${u}`
    });
  }

  rows.push({
    label: 'On site now',
    detail: item.hasBackup
      ? `${fmtQty(num(v.inUse) || 0)} + ${fmtQty(num(v.backup) || 0)}`
      : '',
    value: `${fmtQty(usage.todayTotal)} ${u}`
  });

  const period = usage.days > 1 ? ` over ${plural(usage.days, 'day')}` : '';
  let total, footer = '';

  if (usage.unconfirmed) {
    total = { label: 'Usage not confirmed', value: '-' };
    footer = 'Deliveries during this period are unknown, so usage cannot be worked out.';
  } else if (usage.missingLitres > 0) {
    total = { label: 'Usage not confirmed', value: '-' };
    footer = usage.missingIbcs > 0
      ? `Stock is higher than it should be - at least ${plural(usage.missingIbcs, 'IBC')} arrived without being recorded.`
      : `Stock is higher than it should be - ${fmtQty(usage.missingLitres)} ${item.unit} was added without being recorded.`;
  } else {
    // Chemicals are reported per cubic metre of water treated - the only
    // figure that stays comparable whatever the plant was doing.
    if (item.topUp === 'ibc' && waterNow && waterNow.volume > 0) {
      rows.push({
        label: 'Water dosed',
        detail: `${fmtQty(dosingHours || 0, 1)} hrs dosing${waterNow.exact ? '' : ', estimated'}`,
        value: `${fmtQty(waterNow.volume, 0)} m\u00B3`
      });
    }
    total = { label: `Used${period}`, value: `${fmtQty(usage.used)} ${u}` };

    /* Said in plain words, in the order a reader needs them: what it used
       today, what it normally uses, and how long the stock will last. The old
       wording ("average 1.45 L/m3 over 3196 m3") packed three different ideas
       into one line of shorthand and read as jargon. */
    const parts = [];
    if (item.topUp === 'ibc' && waterNow && waterNow.volume > 0) {
      parts.push(`That is ${fmtQty(usage.used / waterNow.volume, 2)} ${u} of chemical `
        + `for every 1 m\u00B3 of water treated`);
    }
    if (item.topUp === 'ibc' && stats && stats.avgDose) {
      parts.push(`Normally ${fmtQty(stats.avgDose, 2)} ${u} per m\u00B3`);
      if (waterLeft !== null) {
        let bit = `the stock on site will treat about ${fmtQty(waterLeft, 0)} m\u00B3 more water`;
        if (left !== null) bit += `, roughly ${fmtDays(left)}`;
        parts.push(bit);
      }
      if (!stats.waterExact) parts.push('some water amounts are estimates');
    } else if (stats && stats.avgPerDay && stats.daysCovered >= 2) {
      parts.push(`Average use ${fmtQty(stats.avgPerDay)} ${u}/day over ${plural(stats.daysCovered, 'day')}`);
      if (left !== null) parts.push(`about ${fmtDays(left)} left`);
    } else if (usage.days > 1 && usage.used > 0) {
      parts.push(`That is ${fmtQty(usage.perDay)} ${u} per day`);
      parts.push('not enough history yet for an average');
    } else {
      parts.push('Not enough history yet for an average');
    }
    footer = sentences(parts);
  }
  return { rows, total, footer };
}

/* The one line at the top of the report.

   The numbers in it have to add up. It used to count only the faults but then
   name and count everything else as well - "5 faults: A, B, C, plus 3 more" -
   which reads as eight problems when there were six. Now the total comes
   first, its make-up second, and the names plus "and N more" equal the total. */
function buildVerdict(result) {
  const all = [].concat(...Object.values(result.actions));
  /* Checks left blank are not things to act on, but the NOT DONE box under
     this line counts them, so they are named here too - otherwise "1 not done"
     sits directly above a box saying 2. */
  const blank = (result.counts && result.counts.blank) || 0;
  const leftBlank = blank ? ` ${plural(blank, 'check')} ${blank === 1 ? 'was' : 'were'} left blank.` : '';
  if (!all.length) {
    return {
      tone: 'ok',
      text: blank ? `Nothing needs action today.${leftBlank}` : 'All checks clear - nothing needs action today.'
    };
  }
  const n = (s) => all.filter(a => a.status === s).length;
  const faults = n(STATUS.FAULT), watch = n(STATUS.WATCH), todo = n(STATUS.TODO);

  const kinds = [];
  if (faults) kinds.push(plural(faults, 'fault'));
  if (watch) kinds.push(`${watch} to monitor`);
  if (todo) kinds.push(`${todo} not done`);

  // Actions are sorted worst first, so the few named are the most serious.
  const named = all.slice(0, 3).map(a => a.label);
  const more = all.length - named.length;
  const names = more > 0 ? `${named.join(', ')} and ${more} more` : listOf(named);

  let text;
  if (kinds.length === 1) {
    text = faults ? `${plural(faults, 'fault')} to deal with`
      : watch ? `${plural(watch, 'item')} to monitor`
        : `${plural(todo, 'check')} not done`;
  } else {
    text = `${all.length} things need attention (${listOf(kinds)})`;
  }
  return { tone: faults ? 'fault' : 'watch', text: `${text}: ${names}.${leftBlank}` };
}

function numberReason(item, n, thresholdKey, thresholds, status) {
  if (!needsAction(status)) return '';
  const t = thresholds[thresholdKey];
  const d = item.decimals || 0;
  const unit = item.unit ? ' ' + item.unit : '';
  if (!t) return 'out of range';
  if (t.critLow !== undefined) {
    if (n <= t.critLow) return `${fmtQty(n, d)}${unit} - at or below the ${fmtQty(t.critLow, d)} limit`;
    if (n >= t.critHigh) return `${fmtQty(n, d)}${unit} - at or above the ${fmtQty(t.critHigh, d)} limit`;
    if (n <= t.warnLow) return `${fmtQty(n, d)}${unit} - drifting low`;
    if (n >= t.warnHigh) return `${fmtQty(n, d)}${unit} - drifting high`;
  } else if (t.crit !== undefined) {
    if (n <= t.crit) return `only ${fmtQty(n, d)}${unit} left`;
    if (n <= t.warn) return `running low at ${fmtQty(n, d)}${unit}`;
  }
  return 'out of range';
}

/* Names the readings in a multi-field row that are out of range, using each
   field's own limits. */
function multiReason(item, readings, thresholds, status) {
  if (!needsAction(status)) return '';
  const d = item.decimals || 0;
  const faults = [], warns = [];
  readings.forEach((r, i) => {
    if (r === null) return;
    const key = item.fields[i].threshold || item.threshold;
    if (!key) return;
    const g = gradeNumber(r, key, thresholds);
    const tag = `reading ${item.fields[i].label} (${fmtQty(r, d)})`;
    if (g === STATUS.FAULT) faults.push({ tag, key });
    else if (g === STATUS.WATCH) warns.push({ tag, key });
  });

  const phrases = [];
  if (faults.length) {
    // Limits can differ per reading, so only quote one when they all share it.
    const keys = new Set(faults.map(f => f.key));
    let limit = ' the limit';
    if (keys.size === 1) {
      const t = thresholds[faults[0].key];
      if (t && t.critLow !== undefined) {
        limit = ` the ${fmtQty(t.critLow, d)}-${fmtQty(t.critHigh, d)} limit`;
      }
    }
    phrases.push(`${listOf(faults.map(f => f.tag))} outside${limit}`);
  }
  if (warns.length) phrases.push(`${listOf(warns.map(w => w.tag))} drifting`);
  return phrases.length ? phrases.join('; ') : 'out of range';
}

function listOf(arr) {
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

/* Why a chemical is flagged on its litre levels - the rule used until there is
   enough history to know how fast it goes (see chemicalByDays).

   "Empty" and "no backup" are only ever said of nothing at all. Anything at or
   under the fault level used to be called "usage tank empty", so a tank with
   200 L in it told the managers it was empty. */
function chemicalReason(v, thresholds) {
  const bits = [];
  const inUse = num(v.inUse), backup = num(v.backup);
  // Backup first: with nothing in reserve, refilling is not an option.
  if (backup !== null) {
    const tb = thresholds.chemBackup;
    if (backup <= 0) bits.push('no backup stock');
    else if (backup <= tb.crit) bits.push(`backup very low (${fmtQty(backup)} L)`);
    else if (tb.warn > tb.crit && backup <= tb.warn) bits.push(`backup low (${fmtQty(backup)} L)`);
  }
  if (inUse !== null) {
    const ti = thresholds.chemInUse;
    if (inUse <= EMPTY_TANK) bits.push('usage tank empty');
    else if (inUse <= ti.crit) bits.push(`usage tank very low (${fmtQty(inUse)} L)`);
    else if (inUse <= ti.warn) bits.push(`usage tank low (${fmtQty(inUse)} L)`);
  }
  return bits.join(', ');
}

/* Judges a delivered chemical on how long it will last, not on litres.

   One set of litre levels treated all four chemicals alike, but they go at
   very different rates: in the recorded figures 400 L of flocculant lasted
   about 13 days while 600 L of caustic lasted about 2. How long the stock
   lasts is what decides when to order or refill, so that is what the colour
   follows. Two questions, each with its own trigger levels in Settings:

     - the stock on site (usage tank + backup): is it time to order?
     - the usage tank on its own, at the rate it empties while dosing: is it
       time to refill it from the backup? Judged at the dosing rate rather
       than the calendar average, so a quiet weekend in the average cannot hide
       a tank that will run dry tomorrow.

   An empty usage tank is always a fault. Returns null while the app does not
   yet know how fast the chemical goes; the caller then falls back to litres.
   Only the colour and its explanation are decided here - every figure comes
   from the existing usage and days-left working, unchanged. */
function chemicalByDays(s, thresholds) {
  if (s.daysLeft === null || s.daysLeft === undefined || !isFinite(s.daysLeft)) return null;
  const td = thresholds.chemDays;
  const tt = thresholds.chemTankDays;
  const reasons = [];

  // Stock on site: when to order.
  let daysStatus = STATUS.OK;
  if (s.daysLeft <= td.crit) daysStatus = STATUS.FAULT;
  else if (s.daysLeft <= td.warn) daysStatus = STATUS.WATCH;
  if (daysStatus !== STATUS.OK) {
    const onSite = `${fmtQty(s.onHand)} L on site`;
    if (s.onHand <= 0) reasons.push('none left on site');
    else if (s.daysLeft < 1) reasons.push(`less than a day of stock left (${onSite})`);
    else if (daysStatus === STATUS.FAULT) reasons.push(`only ${fmtDays(s.daysLeft)} of stock left (${onSite})`);
    else reasons.push(`about ${fmtDays(s.daysLeft)} of stock left (${onSite})`);
  }

  // The usage tank: when to refill. Only asked when there is backup to refill
  // from - with none, the tank is the whole stock and the question above has
  // already said everything.
  let tankStatus = STATUS.OK;
  if (s.backup !== null && s.backup > 0 && s.inUse !== null) {
    if (s.inUse <= EMPTY_TANK) {
      tankStatus = STATUS.FAULT;
      reasons.push('usage tank empty');
    } else {
      const tankDays = s.perDosingDay
        ? s.inUse / s.perDosingDay
        : (s.onHand > 0 ? s.daysLeft * s.inUse / s.onHand : 0);
      if (tankDays <= tt.crit) tankStatus = STATUS.FAULT;
      else if (tankDays <= tt.warn) tankStatus = STATUS.WATCH;
      if (tankStatus !== STATUS.OK) {
        reasons.push(`usage tank down to ${fmtQty(s.inUse)} L, `
          + (tankDays < 1 ? 'less than a day' : `about ${fmtDays(tankDays)}`) + ' of dosing');
      }
    }
  }

  const status = worstOf([daysStatus, tankStatus]);
  // When both ask for something, running out on site is the bigger problem,
  // so ordering is the action named.
  let action = null;
  if (needsAction(daysStatus) && SEVERITY_ORDER.indexOf(daysStatus) >= SEVERITY_ORDER.indexOf(tankStatus)) {
    action = daysStatus === STATUS.FAULT ? 'REORDER' : 'ORDER SOON';
  } else if (needsAction(tankStatus)) {
    action = 'REFILL';
  }
  return { status, daysStatus, reasons, action };
}

/* ------------------------------------------------------------------
   PDF
   ------------------------------------------------------------------ */

function buildPdf(state, evaluated, previous) {
  const doc = new PdfDoc();
  const L = PT.margin;
  const R = PT.pageW - PT.margin;
  const W = doc.contentWidth;

  /* ---- 1. header band (first page only) ---- */
  const bandH = 84;
  doc.rect(0, 0, PT.pageW, bandH, { fill: BRAND.green });
  doc.rect(0, bandH, PT.pageW, 3.2, { fill: BRAND.gold });   // brand accent rule

  let textX = L;
  if (state.logo && state.logo.bytes) {
    const boxH = 46;
    const scale = Math.min(boxH / state.logo.height, boxH / state.logo.width);
    const lw = state.logo.width * scale;
    const lh = state.logo.height * scale;
    const pad = 4;
    doc.rect(L, (bandH - lh) / 2 - pad, lw + pad * 2, lh + pad * 2, { fill: [255, 255, 255] });
    const name = doc.addImage(state.logo.bytes, state.logo.width, state.logo.height);
    doc.drawImage(name, L + pad, (bandH - lh) / 2, lw, lh);
    textX = L + lw + pad * 2 + 14;
  }

  doc.text((state.site || DEFAULT_SITE).toUpperCase(), textX, 33,
    { size: 13.5, bold: true, colour: [255, 255, 255], tracking: 0.5 });
  doc.text('DAILY OPERATIONS REPORT', textX, 49,
    { size: 8, colour: BRAND.gold, tracking: 1.5 });
  doc.text(reportNumber(state), textX, 64, { size: 7.6, colour: [196, 222, 206] });
  doc.text(reportDate(state.date), R, 39,
    { size: 11, bold: true, colour: [255, 255, 255], align: 'right' });
  doc.text(state.reporter || DEFAULT_REPORTER, R, 54,
    { size: 7.8, colour: [196, 222, 206], align: 'right' });
  doc.y = bandH + 19;

  /* ---- 2. one-line verdict ---- */
  const v = evaluated.verdict;
  const vColour = v.tone === 'fault' ? BRAND.fault : v.tone === 'watch' ? BRAND.watch : BRAND.ok;
  const vLines = wrapText(v.text, 10, true, W - 40);
  const vH = 14 + vLines.length * 13;
  const vBg = v.tone === 'fault' ? BRAND.redBg : v.tone === 'watch' ? BRAND.amberBg : BRAND.okBg;
  doc.roundRect(L, doc.y, W, vH, 7, { fill: vBg, stroke: vColour, lineWidth: 0.8 });
  doc.icon(STATUS_ICON[v.tone === 'ok' ? 'ok' : v.tone], L + 16, doc.y + vH / 2, 11, vColour);
  vLines.forEach((line, i) => {
    doc.text(line, L + 30, doc.y + 17 + i * 13, { size: 10, bold: true, colour: vColour });
  });
  doc.y += vH + 13;

  /* ---- 3. counters ---- */
  const cards = [
    ['OK', evaluated.counts.ok || 0, BRAND.ok],
    ['MONITOR', evaluated.counts.watch || 0, BRAND.watch],
    ['FAULT', evaluated.counts.fault || 0, BRAND.fault],
    ['NOT DONE', (evaluated.counts.todo || 0) + (evaluated.counts.blank || 0), BRAND.todo]
  ];
  const gap = 8;
  const cw = (W - gap * (cards.length - 1)) / cards.length;
  cards.forEach(([label, count, colour], i) => {
    const x = L + i * (cw + gap);
    doc.roundRect(x, doc.y, cw, 42, 6, { fill: [253, 254, 253], stroke: BRAND.hairline });
    doc.roundRect(x, doc.y, 3.4, 42, 1.7, { fill: colour });
    doc.text(String(count), x + 12, doc.y + 24, { size: 17, bold: true, colour });
    doc.text(label, x + 12, doc.y + 35, { size: 6.4, bold: true, colour: BRAND.slate, tracking: 0.5 });
  });
  doc.y += 42 + 10;

  // One slim bar showing the whole split at a glance.
  const totalChecks = cards.reduce((a, c) => a + c[1], 0) || 1;
  const barH = 6;
  doc.roundRect(L, doc.y, W, barH, barH / 2, { fill: [238, 241, 239] });
  let bx = L;
  cards.forEach(([, count, colour]) => {
    if (!count) return;
    const seg = (count / totalChecks) * W;
    doc.rect(bx, doc.y, seg, barH, { fill: colour });
    bx += seg;
  });
  // tidy the rounded ends back over the square segments
  doc.y += barH + 16;

  /* ---- 4. action required ---- */
  CHECKLIST.forEach(section => {
    const actions = evaluated.actions[section.id];
    if (!actions.length) return;
    const faults = actions.filter(a => a.status === STATUS.FAULT);

    const lines = actions.map(a => {
      let s = a.reason ? `${a.label} - ${a.reason}` : a.label;
      if (a.note) s += ` (${a.note})`;
      return { text: s, status: a.status };
    });

    let bodyH = 0;
    const wrapped = lines.map(l => wrapText(l.text, 9, false, W - 46));
    wrapped.forEach(w => { bodyH += w.length * 12.5; });
    const boxH = 27 + bodyH + 8;
    doc.ensure(boxH + 10);

    const bg = faults.length ? BRAND.redBg : BRAND.amberBg;
    const edge = faults.length ? BRAND.fault : BRAND.watch;
    doc.roundRect(L, doc.y, W, boxH, 7, { fill: bg, stroke: edge, lineWidth: 0.8 });
    doc.roundRect(L, doc.y, 3.6, boxH, 1.8, { fill: edge });
    doc.text(`ACTION REQUIRED \u00B7 ${section.owner.toUpperCase()}`, L + 15, doc.y + 17,
      { size: 8.6, bold: true, colour: edge, tracking: 0.7 });

    let ay = doc.y + 31;
    lines.forEach((l, i) => {
      doc.rect(L + 16, ay - 5.5, 5, 5, { fill: STATUS_META[l.status].colour });
      wrapped[i].forEach((w, j) => {
        doc.text(w, L + 27, ay + j * 12.5, { size: 9, colour: BRAND.ink });
      });
      ay += wrapped[i].length * 12.5;
    });
    doc.y += boxH + 12;
  });

  /* ---- 4a. notes, on the first page ----
     They used to come last, after every checklist row - on a normal day alone
     on a page of their own at the very end - so the one part written specially
     for the managers was the part most likely to be missed. The operator's own
     line breaks are kept: wrapText alone would run them into one paragraph. */
  const noteText = String(state.generalNote || '').trim();
  if (noteText) {
    const leading = 12.5;
    const paras = noteText.split(/\n+/).map(p => p.trim()).filter(Boolean)
      .map(p => wrapText(p, 9, false, W - 30));
    const bodyH = paras.reduce((h, lines) => h + lines.length * leading, 0) + (paras.length - 1) * 3;
    const boxH = 27 + bodyH + 8;
    doc.ensure(boxH + 10);
    doc.roundRect(L, doc.y, W, boxH, 7, { fill: [250, 251, 252], stroke: BRAND.hairline, lineWidth: 0.8 });
    doc.roundRect(L, doc.y, 3.6, boxH, 1.8, { fill: BRAND.green });
    doc.text('NOTES', L + 15, doc.y + 17, { size: 8.6, bold: true, colour: BRAND.green, tracking: 0.7 });
    let ny = doc.y + 31;
    paras.forEach(lines => {
      lines.forEach(line => {
        doc.text(line, L + 15, ny, { size: 9, colour: BRAND.ink });
        ny += leading;
      });
      ny += 3;
    });
    doc.y += boxH + 12;
  }

  /* ---- 4b. DAF water, told in the order it happens ---- */
  if (evaluated.meterMissing) {
    /* Nothing can be worked out from one reading, so the block says which one
       is missing rather than printing the few figures it does have. Half a
       period reads as though the plant did something odd, when in fact a
       reading simply has not been entered. */
    let ask;
    if (evaluated.meterMissing === 'today') {
      ask = 'No DAF meter reading has been entered for this report, so the water '
        + 'treated and the chemical doses cannot be worked out. Enter this '
        + "morning's reading in the app and the figures will appear.";
    } else if (evaluated.meterMissing === 'earlier') {
      // Accurate whether no reading exists at all or none falls before this
      // report's own moment, which are both this case.
      ask = 'There is no earlier DAF meter reading to measure this report '
        + 'against, so the water treated and the chemical doses cannot be '
        + 'worked out yet. From the next report on they will be.';
    } else {
      ask = 'The meter readings for this report do not make a period that can '
        + 'be measured - check the report date and the time the readings were '
        + 'taken, and that each reading is higher than the one before it.';
    }
    const askLines = wrapText(ask, 8.4, false, W - 28);
    const boxH = 12 + askLines.length * 12 + 6;
    doc.ensure(20 + boxH + 14);

    doc.text('WATER TREATED SINCE THE LAST REPORT', L, doc.y + 10,
      { size: 8.6, bold: true, colour: BRAND.green, tracking: 0.9 });
    doc.y += 15;
    doc.rect(L, doc.y, 26, 2, { fill: BRAND.gold });
    doc.y += 6;
    doc.roundRect(L, doc.y, W, boxH, 6,
      { fill: BRAND.amberBg, stroke: BRAND.watch, lineWidth: 0.7 });
    askLines.forEach((t, i) => {
      doc.text(t, L + 14, doc.y + 18 + i * 12, { size: 8.4, colour: BRAND.ink });
    });
    doc.y += boxH + 14;

  } else if (evaluated.dosingHours !== null && evaluated.dosingHours !== undefined) {
    const fromDate = String(evaluated.spanFrom).split('T')[0];
    const toDate = String(evaluated.spanTo || state.date).split('T')[0];
    const dosed = evaluated.waterNow && evaluated.waterNow.volume > 0
      ? evaluated.waterNow.volume : null;

    /* Every moment carries its date as well as its time.

       A report can span two days, so a bare "7:30pm" does not say which one -
       and when both meter readings fall on the same date, two rows both
       labelled "4 Oct" are impossible to tell apart. */
    const stamp = (s) => `${shortDate(String(s).split('T')[0])} ${clockTime(s)}`;

    const lines = [];
    lines.push([`Meter at ${stamp(evaluated.spanFrom)}`,
      `${fmtQty(evaluated.meterFrom, 1)} m\u00B3`, false]);
    lines.push([`Meter at ${stamp(evaluated.spanTo)}`,
      `${fmtQty(evaluated.meterTo, 1)} m\u00B3`, false]);
    if (evaluated.totalWater !== null) {
      lines.push(['Water through the plant', `${fmtQty(evaluated.totalWater, 1)} m\u00B3`, false]);
    }
    // Spelling out the whole period makes the dosing hours readable: "14 hrs"
    // means nothing until you know the period was 24.
    lines.push(['Chemical was dosing for',
      evaluated.spanHours
        ? `${fmtQty(evaluated.dosingHours, 1)} of those ${fmtQty(evaluated.spanHours, 1)} hrs`
        : `${fmtQty(evaluated.dosingHours, 1)} hrs`, false]);

    /* Each switch inside the period, naming the reading the dosed volume is
       measured from. This is the line whose absence made the dosed figure look
       as though it had been worked out from the wrong reading. The moment goes
       in the label so the reading itself lines up with the other figures. */
    (evaluated.switches || []).slice(0, 3).forEach(s => {
      lines.push([`Dosing ${s.on ? 'on' : 'off'} at ${stamp(s.at)}`,
        s.meter !== null && s.meter !== undefined
          ? `${fmtQty(s.meter, 1)} m\u00B3`
          : 'meter not noted', false]);
    });
    if (dosed !== null) {
      lines.push(['Water that got chemical',
        `${fmtQty(dosed, 0)} m\u00B3${evaluated.waterNow.exact ? '' : '  (estimated)'}`, true]);
    }
    // Only worth printing when something was actually dosed. "Average flow
    // while dosing" sitting under "dosing for 0.0 hrs" invites the question of
    // which of the two is wrong, when neither is.
    /* "Average flow", not "speed": it is the water the meter recorded divided
       by the hours, over the days the dosing ran right through. Called "water
       speed" it sat in the same report as the Flow rate check - the figure the
       flow is set to - and read as a second opinion on the same number. */
    if (evaluated.flowRate && evaluated.dosingHours > 0) {
      lines.push(['Average flow while dosing',
        `${fmtQty(evaluated.flowRate, 1)} m\u00B3/h`, false]);
    }

    /* The closing sentence has to make sense of whatever the figures say,
       including the awkward cases - dosing switched off for the whole period
       used to print a bare "0.0 hrs" with no hint of what that meant. */
    let note;
    if (evaluated.dosingHours <= 0) {
      note = 'The chemical dosing was off for this whole period, so none of this '
        + 'water was dosed and there are no dose figures below.';
      // Said plainly, because "off all period" next to a dosing start earlier
      // the same day is otherwise read as a contradiction.
      const startsNext = (evaluated.allSwitches || [])
        .find(s => s.on && s.at >= evaluated.spanTo);
      if (startsNext) {
        note += ` The dosing was switched on at ${clockTime(startsNext.at)}, at the`
          + ' very end of this period, so it counts towards the next report.';
      }
    } else if (dosed !== null) {
      note = 'Further down, each chemical gives the litres of chemical used for every '
        + `1 m\u00B3 of this ${fmtQty(dosed, 0)} m\u00B3.`;
      if (!evaluated.waterNow.exact) {
        note += ' The meter was not noted when the dosing was switched, so this'
          + ' volume is the dosing hours times the average flow above';
        note += evaluated.flowDays
          ? `, which is measured from ${plural(evaluated.flowDays, 'earlier day')} `
            + 'when the dosing ran right through.'
          : '.';
        note += ' Noting the meter at the switch makes it exact.';
      }
    } else {
      note = 'Add a meter reading for each morning and the water dosed can be '
        + 'worked out.';
    }
    const noteLines = wrapText(note, 7.8, false, W - 4);

    /* Two columns rather than one long list.

       Seven stacked rows took up as much of the page as a whole checklist
       section, which pushed the figures a reader actually compares far apart.
       Side by side they fit in half the height and stay on one screen. */
    const rowH = 14;
    const half = Math.ceil(lines.length / 2);
    const boxH = 10 + half * rowH + 8;
    doc.ensure(20 + boxH + 10 + noteLines.length * 10 + 10);

    doc.text('WATER TREATED SINCE THE LAST REPORT', L, doc.y + 10,
      { size: 8.6, bold: true, colour: BRAND.green, tracking: 0.9 });
    doc.y += 15;
    doc.rect(L, doc.y, 26, 2, { fill: BRAND.gold });
    doc.y += 6;

    doc.roundRect(L, doc.y, W, boxH, 6,
      { fill: BRAND.sumBg, stroke: BRAND.sumEdge, lineWidth: 0.7 });

    const colW = W / 2;
    const mid = L + colW;
    // A hairline keeps the eye from reading across the two columns as one row.
    if (lines.length > half) {
      doc.rect(mid, doc.y + 7, 0.6, boxH - 14, { fill: BRAND.sumEdge });
    }

    lines.forEach(([label, value, strong], i) => {
      const col = i < half ? 0 : 1;
      const row = i < half ? i : i - half;
      const x = L + col * colW;
      const y = doc.y + 10 + row * rowH;
      doc.text(label, x + 13, y, { size: 8.2, bold: strong, colour: BRAND.sumInk });
      doc.text(value, x + colW - 13, y,
        { size: strong ? 9 : 8.6, bold: strong, colour: BRAND.sumInk, align: 'right' });
    });
    doc.y += boxH + 8;
    noteLines.forEach((t, i) => {
      doc.text(t, L, doc.y + 8 + i * 10, { size: 7.8, colour: BRAND.slate, italic: true });
    });
    doc.y += 10 + noteLines.length * 10;
  }

  /* ---- 5. stock at a glance, as IBCs ----
     Each chemical as its own IBCs: a big one for the usage tank filled to its
     level, with a black arrow at the level, and small ones beside it for the
     backup. The two levels are what this section is for; the dose and days
     left are given under each chemical further down. It takes exactly the
     space the table did, so nothing after it moves. */
  if (evaluated.stock.some(s => s.kind === 'chemical')) {
    drawStockIbcs(doc, evaluated, state);
  }

  /* ---- 6. detail sections ---- */
  const photoOrder = [];

  CHECKLIST.forEach(section => {
    doc.ensure(64);
    doc.roundRect(L, doc.y, W, 22, 4, { fill: BRAND.green });
    doc.rect(L + 10, doc.y + 7, 2.4, 8, { fill: BRAND.gold });
    doc.text(`${section.number}.  ${section.owner.toUpperCase()}`, L + 18, doc.y + 15,
      { size: 9, bold: true, colour: [255, 255, 255], tracking: 0.8 });
    doc.y += 22 + 11;

    section.groups.forEach(group => {
      const heading = `${group.number}  ${group.title}` + (group.note ? `  (${group.note})` : '');
      const compactItems = group.items.filter(i => i.compact && evaluated.items[i.id].sum);
      const rest = group.items.filter(i => !compactItems.includes(i));
      // Plain OK checks go two to a line at the end of the group (drawOkGrid);
      // anything with something to say keeps a full row of its own.
      const okItems = rest.filter(i => squashable(i, evaluated.items[i.id]));
      const normalItems = rest.filter(i => !okItems.includes(i));
      const allOk = group.items.every(i => evaluated.items[i.id].status === STATUS.OK);

      // A heading must never sit alone at the foot of a page, so the space for
      // the heading plus whatever follows it first is reserved together.
      const firstBlock = compactItems.length
        ? 16 + compactItems.length * 18
        : normalItems.length ? itemHeight(doc, normalItems[0], evaluated.items[normalItems[0].id])
          : okItems.length ? OK_GRID_ROW + 2 : 0;
      doc.ensure(18 + 4 + firstBlock);

      doc.text(heading, L, doc.y + 9, { size: 9, bold: true, colour: BRAND.green });
      // A whole group in order says so on its heading, so it can be passed over
      // at a glance.
      if (allOk) {
        doc.text(`ALL ${group.items.length} OK`, R, doc.y + 9,
          { size: 7.2, bold: true, colour: BRAND.ok, align: 'right', tracking: 0.5 });
      }
      doc.y += 13;
      doc.hline(L, R, doc.y, BRAND.green, 0.8);
      doc.rect(L, doc.y - 0.4, 24, 1.6, { fill: BRAND.gold });
      doc.y += 5;

      // Compact stock rows: everything on one line, in a small table.
      if (compactItems.length) drawCompactStock(doc, compactItems, evaluated, L, R, W);

      normalItems.forEach((item, idx) => {
        const ev = evaluated.items[item.id];
        const rowH = 19;
        // Keep the row together with its sum block and any reason line.
        if (doc.ensure(itemHeight(doc, item, ev))) {
          doc.text(`${heading} (continued)`, L, doc.y + 9,
            { size: 8.4, bold: true, colour: BRAND.slate });
          doc.y += 16;
        }
        if (idx % 2 === 1) doc.rect(L, doc.y, W, rowH, { fill: BRAND.zebra });

        doc.text(item.label, L + 7, doc.y + 13, { size: 8.8, colour: BRAND.ink });
        doc.badge(ev.badge, STATUS_ICON[ev.status], R - 6, doc.y + 3.5, STATUS_META[ev.status].colour);

        // Skip the value when the badge beside it already says the same thing,
        // e.g. an OK / Fault pick.
        const badgeSaysIt = ev.hideDisplay || String(ev.display).toLowerCase()
          === STATUS_META[ev.status].label.toLowerCase();
        if (item.type !== 'status' && !badgeSaysIt) {
          doc.text(ev.display, R - 84, doc.y + 13,
            { size: 9.2, colour: BRAND.value, align: 'right' });
        }
        doc.y += rowH;

        // Why it is flagged, so a coloured badge is never a mystery.
        if (ev.showReason) {
          const h = doc.paragraph(ev.reason, L + 16, doc.y, W - 40,
            { size: 8, colour: STATUS_META[ev.status].colour, leading: 10.5 });
          doc.y += h + 1;
        }

        if (ev.sum) drawStockSum(doc, ev.sum, L, R, W);

        if (ev.photos.length) {
          ev.photos.forEach(pid => {
            photoOrder.push({ photoId: pid, label: item.label, group: group.title, owner: section.owner });
          });
          const refs = ev.photos.map((_, i) =>
            `Photo ${photoOrder.length - ev.photos.length + i + 1}`).join(', ');
          doc.ensure(13);
          doc.text(`see ${refs}`, L + 16, doc.y + 9, { size: 8.2, colour: [52, 92, 150] });
          doc.y += 12;
        }
        if (ev.note) {
          const h = doc.paragraph(`Note: ${ev.note}`, L + 16, doc.y, W - 32,
            { size: 8.4, colour: BRAND.value, leading: 11, italic: true });
          doc.y += h + 2;
        }
      });
      if (okItems.length) drawOkGrid(doc, okItems, evaluated, heading, L, W);
      doc.hline(L, R, doc.y, BRAND.hairline);
      doc.y += 14;
    });
  });

  /* ---- 7. (the notes are on the first page, section 4a) ---- */

  /* ---- 8. photo appendix ---- */
  if (photoOrder.length) {
    doc.newPage();
    doc.rect(L, doc.y, W, 22, { fill: BRAND.navy });
    doc.text('PHOTO APPENDIX', L + 10, doc.y + 15,
      { size: 9.4, bold: true, colour: [255, 255, 255] });
    doc.y += 22 + 12;

    const colW = (W - 14) / 2;
    let col = 0;
    let rowTop = doc.y;

    photoOrder.forEach((entry, i) => {
      const photo = state.photos[entry.photoId];
      if (!photo) return;
      const scale = Math.min(colW / photo.width, 200 / photo.height);
      const dw = photo.width * scale;
      const dh = photo.height * scale;
      const blockH = dh + 34;

      if (col === 0 && rowTop + blockH > doc.bottomLimit) {
        doc.newPage();
        rowTop = doc.y;
      }
      const x = L + col * (colW + 14);
      const name = doc.addImage(photo.bytes, photo.width, photo.height);
      doc.rect(x, rowTop, colW, dh + 2, { fill: [246, 247, 249] });
      doc.drawImage(name, x + (colW - dw) / 2, rowTop + 1, dw, dh);
      doc.text(`Photo ${i + 1} \u00B7 ${entry.label}`, x, rowTop + dh + 15,
        { size: 8, bold: true, colour: BRAND.ink });
      doc.text(`${entry.owner} \u00B7 ${entry.group}`, x, rowTop + dh + 26,
        { size: 7.8, colour: BRAND.value });

      if (col === 1) {
        rowTop += blockH + 14;
        doc.y = rowTop;
        col = 0;
      } else {
        col = 1;
      }
    });
  }

  const footer = `${state.site || DEFAULT_SITE} \u00B7 ${reportNumber(state)} \u00B7 ${reportDate(state.date)}`;
  return doc.build(footer);
}

/* ---- the OK checks of a group, two to a line ----

   Six rows of "Drier 1 ... OK" told the managers six times what one line can,
   and a normal day ran to four pages, most of it rows that were fine. A check
   that has something to say - a problem, a note, a photo, a stock sum, or one
   left blank - still gets its full row. The rest are listed here, by name and
   with their reading where they have one, so every check is still accounted
   for. */
const OK_GRID_ROW = 15;

function squashable(item, ev) {
  return ev.status === STATUS.OK && item.type !== 'stock'
    && !ev.sum && !ev.note && !(ev.photos && ev.photos.length) && !ev.showReason;
}

// The reading worth printing beside a name: not "OK" again, and not a value
// that only repeats the name ("Within target - Within target").
function okValue(item, ev) {
  if (item.type === 'status' || ev.hideDisplay) return '';
  const d = String(ev.display == null ? '' : ev.display);
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!d || d === '-' || same(d, STATUS_META[ev.status].label) || same(d, item.label)) return '';
  return d;
}

// Shortens text to fit, ending in "..." - never lets a cell run into the next.
function fitText(str, size, bold, maxW) {
  if (measure(str, size, bold) <= maxW) return str;
  let s = str;
  while (s.length > 1 && measure(`${s}...`, size, bold) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

function drawOkGrid(doc, items, evaluated, heading, L, W) {
  const gap = 14;
  const colW = (W - gap) / 2;
  const size = 8.4;
  for (let i = 0; i < items.length; i += 2) {
    if (doc.ensure(OK_GRID_ROW + 2)) {
      doc.text(`${heading} (continued)`, L, doc.y + 9,
        { size: 8.4, bold: true, colour: BRAND.slate });
      doc.y += 16;
    }
    [items[i], items[i + 1]].forEach((item, c) => {
      if (!item) return;
      const ev = evaluated.items[item.id];
      const x = L + c * (colW + gap);
      const base = doc.y + 10.6;
      doc.icon('tick', x + 8, doc.y + OK_GRID_ROW / 2, 7, BRAND.ok);

      // The reading is right-aligned in its column, so the two columns read
      // as a tidy table; the name gets whatever room the reading leaves.
      const right = x + colW - 4;
      const value = okValue(item, ev);
      const valueW = value ? Math.min(measure(value, size, false), colW * 0.55) : 0;
      const shown = value ? fitText(value, size, false, valueW) : '';
      const labelMax = colW - 22 - (value ? valueW + 10 : 0);
      doc.text(fitText(item.label, size, false, labelMax), x + 18, base, { size, colour: BRAND.ink });
      if (shown) doc.text(shown, right, base, { size, colour: BRAND.value, align: 'right' });
    });
    doc.y += OK_GRID_ROW;
  }
  doc.y += 3;
}

/* How tall a detail row will be once its sum, reason and note are included.
   Used to stop a row being split across a page break. */
function itemHeight(doc, item, ev) {
  let h = 19;
  if (ev.showReason) h += wrapText(ev.reason, 8, false, doc.contentWidth - 40).length * 10.5 + 1;
  if (ev.sum && !item.compact) h += sumHeight(sum_wrapWidth(doc), ev.sum) + 4;
  if (ev.photos && ev.photos.length) h += 12;
  if (ev.note) h += wrapText(`Note: ${ev.note}`, 8, false, doc.contentWidth - 32).length * 10.5 + 2;
  return h;
}

function sum_wrapWidth(doc) { return doc.contentWidth; }

function sumHeight(W, sum) {
  const footerLines = sum.footer ? wrapText(sum.footer, 8.6, false, W - 60) : [];
  return 8 + sum.rows.length * 14 + 20 + (footerLines.length * 11) + 8;
}

/* Boiler dose tanks, one line each with the whole movement on it. */
function drawCompactStock(doc, items, evaluated, L, R, W) {
  const rowH = 18;
  // The badge sits hard right, so every column stops well clear of it.
  const cols = {
    label: L + 8,
    last: L + W * 0.34,
    added: L + W * 0.455,
    now: L + W * 0.57,
    used: L + W * 0.685,
    avg: L + W * 0.80
  };

  doc.roundRect(L, doc.y, W, 15, 3, { fill: [240, 246, 242] });
  doc.text('TANK', cols.label, doc.y + 10.5, { size: 6.6, bold: true, colour: BRAND.slate, tracking: 0.6 });
  [['LAST CHECK', cols.last], ['ADDED', cols.added], ['NOW', cols.now],
   ['USED', cols.used], ['AVG / DAY', cols.avg]].forEach(([t, x]) => {
      doc.text(t, x, doc.y + 10.5,
        { size: 6.6, bold: true, colour: BRAND.slate, align: 'right', tracking: 0.6 });
    });
  doc.y += 15;

  items.forEach((item, i) => {
    const ev = evaluated.items[item.id];
    const sum = ev.sum;
    if (doc.ensure(rowH + 2)) doc.y += 2;
    if (i % 2 === 1) doc.rect(L, doc.y, W, rowH, { fill: BRAND.zebra });
    doc.rect(L, doc.y, 2.5, rowH, { fill: STATUS_META[ev.status].colour });

    const base = { size: 8.8, colour: BRAND.ink };
    doc.text(item.label, cols.label, doc.y + 12.5, base);
    doc.text(sum.rows[0].value, cols.last, doc.y + 12.5, { ...base, align: 'right', colour: BRAND.value });
    doc.text(sum.rows[1].value, cols.added, doc.y + 12.5, { ...base, align: 'right', colour: BRAND.value });
    doc.text(sum.rows[2].value, cols.now, doc.y + 12.5, { ...base, align: 'right' });
    doc.text(sum.total.value, cols.used, doc.y + 12.5, { ...base, align: 'right', bold: true });
    const st = (evaluated.stock || []).find(x => x.id === item.id);
    doc.text(st && st.avgPerDay ? `${fmtQty(st.avgPerDay)} ${item.unit}` : '-',
      cols.avg, doc.y + 12.5, { ...base, align: 'right', colour: BRAND.value });
    doc.badge(ev.badge, STATUS_ICON[ev.status], R - 6, doc.y + 2.5, STATUS_META[ev.status].colour);
    doc.y += rowH;

    if (ev.showReason) {
      const h = doc.paragraph(ev.reason, cols.label + 9, doc.y, W - 60,
        { size: 7.8, colour: STATUS_META[ev.status].colour, leading: 10 });
      doc.y += h + 1;
    }
    if (ev.note) {
      const h = doc.paragraph(`Note: ${ev.note}`, cols.label + 9, doc.y, W - 60,
        { size: 7.8, colour: BRAND.slate, leading: 10 });
      doc.y += h + 1;
    }
  });
  doc.y += 6;
}

/* The stock sum, printed as a proper bordered block. This is the number the
   managers act on, so it gets real size and contrast. */
function drawStockSum(doc, sum, L, R, W) {
  const rowH = 14;
  const footerLines = sum.footer ? wrapText(sum.footer, 8.6, false, W - 60) : [];
  const boxH = sumHeight(W, sum);
  doc.ensure(boxH + 4);

  const x = L + 12;
  const w = W - 24;
  doc.roundRect(x, doc.y, w, boxH, 6, { fill: BRAND.sumBg, stroke: BRAND.sumEdge, lineWidth: 0.7 });

  const labelX = x + 12;
  const detailX = x + w * 0.52;
  const valueX = x + w - 12;
  let y = doc.y + 8;

  sum.rows.forEach(row => {
    doc.text(row.label, labelX, y + 10, { size: 8.6, colour: BRAND.sumInk });
    if (row.detail) {
      doc.text(row.detail, detailX, y + 10,
        { size: 8.8, colour: BRAND.sumInk, align: 'right' });
    }
    doc.text(row.value, valueX, y + 10,
      { size: 9.2, bold: true, colour: BRAND.sumInk, align: 'right' });
    y += rowH;
  });

  doc.hline(labelX, valueX, y + 2, BRAND.sumEdge, 0.8);
  y += 4;
  doc.text(sum.total.label, labelX, y + 12, { size: 10.5, bold: true, colour: BRAND.sumInk });
  doc.text(sum.total.value, valueX, y + 12,
    { size: 11.5, bold: true, colour: BRAND.sumInk, align: 'right' });
  y += 18;

  footerLines.forEach((line, i) => {
    doc.text(line, labelX, y + 9.5 + i * 11, { size: 8.6, colour: BRAND.sumInk });
  });

  doc.y += boxH + 4;
}

/* ------------------------------------------------------------------
   Chemical stock at a glance, as IBCs
   ------------------------------------------------------------------
   Reads only what the report already has: the usage tank and backup levels
   as typed on the sheet, and each chemical's status from evaluate(), whose
   OK / Monitor / Fault colours tint the liquid. */

const STOCK_BLOCK_H = 133;   // exactly the height the table took
const STOCK_CARD_TOP = 21;   // below the heading and its gold rule
const STOCK_CARD_H = 96;

const IBC_LOOK = {
  body: [244, 247, 245], cage: [178, 188, 182], frame: [104, 114, 108],
  cap: [96, 104, 100], pallet: [120, 128, 124], pill: [255, 255, 255],
  liquid: {
    ok: [96, 184, 128], watch: [242, 182, 60], fault: [228, 110, 104],
    todo: [190, 196, 200], blank: [190, 196, 200]
  },
  surface: {
    ok: [52, 140, 86], watch: [196, 136, 18], fault: [186, 60, 56],
    todo: [150, 156, 160], blank: [150, 156, 160]
  }
};

function pdfNum(n) { return n.toFixed(2); }

// A rounded rectangle as a bare path, to be clipped to.
function roundRectPath(doc, x, y, w, h, r) {
  const yb = doc.flip(y + h);
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = 0.5523 * rad;
  const f = pdfNum;
  doc.op(`${f(x + rad)} ${f(yb)} m`);
  doc.op(`${f(x + w - rad)} ${f(yb)} l`);
  doc.op(`${f(x + w - rad + k)} ${f(yb)} ${f(x + w)} ${f(yb + rad - k)} ${f(x + w)} ${f(yb + rad)} c`);
  doc.op(`${f(x + w)} ${f(yb + h - rad)} l`);
  doc.op(`${f(x + w)} ${f(yb + h - rad + k)} ${f(x + w - rad + k)} ${f(yb + h)} ${f(x + w - rad)} ${f(yb + h)} c`);
  doc.op(`${f(x + rad)} ${f(yb + h)} l`);
  doc.op(`${f(x + rad - k)} ${f(yb + h)} ${f(x)} ${f(yb + h - rad + k)} ${f(x)} ${f(yb + h - rad)} c`);
  doc.op(`${f(x)} ${f(yb + rad)} l`);
  doc.op(`${f(x)} ${f(yb + rad - k)} ${f(x + rad - k)} ${f(yb)} ${f(x + rad)} ${f(yb)} c`);
  doc.op('h');
}

function clipTo(doc, x, y, w, h, r, draw) {
  doc.op('q');
  roundRectPath(doc, x, y, w, h, r);
  doc.op('W n');
  draw();
  doc.op('Q');
}

function strokeLine(doc, x1, y1, x2, y2, colour, width) {
  doc.op(`${fmtColour(colour)} RG`);
  doc.op(`${pdfNum(width)} w`);
  doc.op(`${pdfNum(x1)} ${pdfNum(doc.flip(y1))} m ${pdfNum(x2)} ${pdfNum(doc.flip(y2))} l S`);
}

/* One IBC seen from the front - cap, bottle, steel cage, valve, pallet - with
   the bottle filled to `level` (0 to 1). (x, y) is the top left; h includes
   the pallet. Returns where the bottle is, so an arrow can point at the level. */
function drawIbcShape(doc, x, y, w, h, level, status) {
  const t = IBC_LOOK;
  const capH = Math.max(2, h * 0.06);
  const capW = w * 0.24;
  const palletH = h * 0.14;
  const bodyY = y + capH;
  const bodyH = h - capH - palletH;
  const r = Math.max(1.5, w * 0.07);
  const lv = Math.max(0, Math.min(1, level || 0));

  doc.roundRect(x + (w - capW) / 2, y, capW, capH + 1.5, 1, { fill: t.cap });
  doc.roundRect(x, bodyY, w, bodyH, r, { fill: t.body });
  if (lv > 0) {
    clipTo(doc, x, bodyY, w, bodyH, r, () => {
      const top = bodyY + bodyH * (1 - lv);
      doc.rect(x, top, w, bodyY + bodyH - top, { fill: t.liquid[status] || t.liquid.blank });
      doc.rect(x, top, w, Math.min(1.4, bodyH * lv), { fill: t.surface[status] || t.surface.blank });
    });
  }
  const lw = Math.max(0.45, w * 0.012);
  [1, 2].forEach(i => strokeLine(doc, x + (w * i) / 3, bodyY + 0.6, x + (w * i) / 3, bodyY + bodyH - 0.6, t.cage, lw));
  [1, 2].forEach(i => strokeLine(doc, x + 0.6, bodyY + (bodyH * i) / 3, x + w - 0.6, bodyY + (bodyH * i) / 3, t.cage, lw));
  doc.roundRect(x, bodyY, w, bodyH, r, { stroke: t.frame, lineWidth: Math.max(0.7, w * 0.022) });
  doc.rect(x + w / 2 - w * 0.07, bodyY + bodyH - 1, w * 0.14, palletH * 0.42, { fill: t.cap });
  const deckY = y + h - palletH + palletH * 0.22;
  doc.rect(x - w * 0.02, deckY, w * 1.04, palletH * 0.36, { fill: t.pallet });
  const footW = w * 0.15;
  [x + w * 0.03, x + (w - footW) / 2, x + w * 0.97 - footW].forEach(fx => {
    doc.rect(fx, deckY, footW, y + h - deckY, { fill: t.pallet });
  });
  return { bodyY, bodyH, surfaceY: bodyY + bodyH * (1 - lv) };
}

/* The backup: one small IBC per 1,000 L, stacked two high as they stand in
   the store, each filled to its share. No backup is one empty IBC, the same
   as an empty usage tank. More than two shows two, marked with the count. */
function drawBackupIbcs(doc, x, bottom, w, hEach, litres, status) {
  const gap = 2;
  const b = litres && litres > 0 ? litres : 0;
  if (!b) {
    drawIbcShape(doc, x, bottom - hEach, w, hEach, 0, status);
    return;
  }
  const n = Math.ceil(b / IBC_LITRES - 1e-9);
  const full = Math.floor(b / IBC_LITRES + 1e-9);
  for (let i = 0; i < Math.min(n, 2); i++) {
    const level = i < full ? 1 : (b - full * IBC_LITRES) / IBC_LITRES;
    drawIbcShape(doc, x, bottom - (i + 1) * hEach - i * gap, w, hEach, level, status);
  }
  if (n > 2) {
    const label = `x${n}`;
    const pw = measure(label, 6, true) + 7;
    const cy = bottom - 2 * hEach - gap + hEach * 0.45;
    doc.roundRect(x + (w - pw) / 2, cy - 5, pw, 10, 5,
      { fill: IBC_LOOK.pill, stroke: IBC_LOOK.frame, lineWidth: 0.5 });
    doc.text(label, x + w / 2, cy + 2.2, { size: 6, bold: true, colour: BRAND.ink, align: 'center' });
  }
}

// A small black arrow, pointing right at the level in the usage tank.
function levelArrow(doc, tipX, y) {
  doc.op(`${fmtColour(BRAND.ink)} rg`);
  doc.op(`${pdfNum(tipX)} ${pdfNum(doc.flip(y))} m `
    + `${pdfNum(tipX - 6)} ${pdfNum(doc.flip(y - 3.4))} l `
    + `${pdfNum(tipX - 6)} ${pdfNum(doc.flip(y + 3.4))} l h f`);
}

function drawStockIbcs(doc, evaluated, state) {
  doc.ensure(STOCK_BLOCK_H + 6);
  const L = PT.margin;
  const W = doc.contentWidth;
  const y0 = doc.y;

  doc.text('CHEMICAL STOCK AT A GLANCE', L, y0 + 10,
    { size: 8.6, bold: true, colour: BRAND.green, tracking: 0.9 });
  doc.text('Large: usage tank  \u00B7  Small: backup', L + W, y0 + 10,
    { size: 6.8, colour: BRAND.slate, align: 'right' });
  doc.rect(L, y0 + 15, 26, 2, { fill: BRAND.gold });

  const gap = 8;
  const cw = (W - gap * 3) / 4;
  const cy = y0 + STOCK_CARD_TOP;
  const ch = STOCK_CARD_H;
  // Always the same order, so each chemical is in the same place every day.
  chemicalItems().forEach((item, i) => {
    const v = (state.values && state.values[item.id]) || {};
    const inUse = num(v.inUse);
    const backup = item.hasBackup ? num(v.backup) : null;
    const status = (evaluated.items[item.id] && evaluated.items[item.id].status) || STATUS.BLANK;
    const colour = STATUS_META[status].colour;
    const strong = status === STATUS.FAULT || status === STATUS.WATCH;
    const cx = L + i * (cw + gap);

    doc.roundRect(cx, cy, cw, ch, 6, { fill: [252, 253, 252], stroke: BRAND.hairline, lineWidth: 0.7 });
    doc.roundRect(cx, cy, 3.4, ch, 1.7, { fill: colour });
    doc.text(fitText(item.label, 8.2, true, cw - 18), cx + 11, cy + 13,
      { size: 8.2, bold: true, colour: BRAND.ink });

    const bigW = 54, bigH = 56, smallW = 28, smallH = 27;
    const gx = cx + 3 + (cw - 3 - (bigW + 9 + smallW)) / 2;
    const tank = drawIbcShape(doc, gx, cy + 19, bigW, bigH, (inUse || 0) / IBC_LITRES, status);
    // Only when there is a level to point at - not for one never typed in.
    if (inUse !== null) levelArrow(doc, gx - 1.8, tank.surfaceY);
    drawBackupIbcs(doc, gx + bigW + 9, cy + 19 + bigH, smallW, smallH, backup, status);

    const amount = (n) => (n === null ? '-' : `${fmtQty(n)} ${item.unit}`);
    doc.text(amount(inUse), gx + bigW / 2, cy + 86,
      { size: 9.6, bold: true, colour: strong ? colour : BRAND.ink, align: 'center' });
    doc.text(amount(backup), gx + bigW + 9 + smallW / 2, cy + 86,
      { size: 7.8, bold: true, colour: backup ? BRAND.ink : BRAND.slate, align: 'center' });
    doc.text('IN USE', gx + bigW / 2, cy + 93.5,
      { size: 5.4, bold: true, colour: BRAND.slate, align: 'center', tracking: 0.5 });
    doc.text('BACKUP', gx + bigW + 9 + smallW / 2, cy + 93.5,
      { size: 5.4, bold: true, colour: BRAND.slate, align: 'center', tracking: 0.5 });
  });
  doc.y = y0 + STOCK_BLOCK_H;
}
