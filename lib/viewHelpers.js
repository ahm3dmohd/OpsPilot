// Small helpers available in every EJS template (registered on
// app.locals in server.js).
const fs = require('fs');
const path = require('path');

// ---- Icons (Lucide, ISC licence) ----
// Inlines the SVG so icons inherit text colour and need no extra request.
// Files are read once and cached.
const iconDir = path.dirname(require.resolve('lucide-static/package.json'));
const iconCache = {};

function icon(name, className = 'size-4') {
  if (!iconCache[name]) {
    const file = path.join(iconDir, 'icons', `${name}.svg`);
    iconCache[name] = fs
      .readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/, '')
      .replace(/\s+/g, ' ')
      .replace(/ width="24" height="24"/, '')
      .replace(/class="[^"]*"/, 'class="__CLASS__" aria-hidden="true" focusable="false"')
      .trim();
  }
  // className comes from our own templates, never from user input.
  return iconCache[name].replace('__CLASS__', className);
}

// ---- "3h ago" ----
function timeAgo(date, now = new Date()) {
  const seconds = Math.round((now - new Date(date)) / 1000);
  if (seconds < 60) return 'just now';
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ];
  for (const [unit, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return 'just now';
}

// Full timestamp for title="" tooltips next to timeAgo.
function fullDate(date) {
  return new Date(date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

// Hours as "1h 20m" / "3d 4h" for SLA clocks.
function duration(hours) {
  const h = Math.abs(hours);
  if (h < 1 / 60) return '<1m';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) {
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    return mins ? `${whole}h ${mins}m` : `${whole}h`;
  }
  const days = Math.floor(h / 24);
  const rest = Math.round(h - days * 24);
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

// "In Progress" -> "in-progress", for class names.
function slug(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '-');
}

// What the SLA column of a strip shows: the clock that's still running
// (first response first), or the overall result once both have stopped.
function slaClock(sla) {
  const running = sla.firstResponse.running && sla.firstResponse.state !== 'met' ? sla.firstResponse
    : sla.resolution.running ? sla.resolution : null;
  if (!running) {
    return { text: sla.overall === 'met' ? 'SLA met' : 'SLA missed', state: sla.overall === 'met' ? 'met' : 'breached', label: '' };
  }
  const which = running === sla.firstResponse ? 'response' : 'resolution';
  // Go by the state, not the rounded hours: a clock 10 seconds past its
  // target is breached, and must not read "0m left".
  if (running.state === 'breached') {
    return { text: `${duration(running.remainingHours)} over`, state: 'breached', label: `${which} overdue` };
  }
  return { text: `${duration(running.remainingHours)} left`, state: running.state, label: `to ${which}` };
}

module.exports = { icon, timeAgo, fullDate, duration, initials, slug, slaClock };
