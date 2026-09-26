'use strict';

// The timetable is keyed by the Monday of the week a session or block belongs to.
// Day index is 0 = Monday ... 6 = Sunday, matching the grid rows top to bottom.

function dayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - dayIndex(d));
  return d;
}

function weekKey(date) {
  const m = mondayOf(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

module.exports = { dayIndex, mondayOf, weekKey, minutesOfDay };
