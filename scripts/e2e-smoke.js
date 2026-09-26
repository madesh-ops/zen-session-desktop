'use strict';

/* End-to-end smoke test: launches the real app and drives it like a person.
 *
 * It never touches the real data file. Every run gets a throwaway profile
 * through ZEN_USER_DATA, and the windows are driven over Chromium's remote
 * debugging protocol: real mouse and key events, not calls into the code.
 *
 *   node scripts/e2e-smoke.js                       development build
 *   node scripts/e2e-smoke.js "dist\win-unpacked\Zen Session.exe"   packaged
 *
 * Takes a little over a minute, most of it waiting out a one-minute focus
 * session, because a completed session is the thing most worth proving.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGED = process.argv[2] ? path.resolve(process.argv[2]) : null;
const EXE = PACKAGED || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const problems = [];

function check(ok, label, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}

// --- launching -----------------------------------------------------------

function launch(profile, extraArgs = [], { debug = true } = {}) {
  const args = [...(PACKAGED ? [] : [ROOT]), ...(debug ? [`--remote-debugging-port=${PORT}`] : []), ...extraArgs];
  const child = spawn(EXE, args, {
    env: { ...process.env, ZEN_USER_DATA: profile, NODE_OPTIONS: '' },
    stdio: 'ignore',
    windowsHide: false
  });
  return child;
}

async function targets(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const main = list.find((t) => t.type === 'page' && t.url.endsWith('/index.html'));
      const pill = list.find((t) => t.type === 'page' && t.url.endsWith('/pill.html'));
      if (main && pill) return { main, pill };
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error('the app never exposed both windows');
}

async function gone(timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/list`);
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}

// --- a minimal CDP client --------------------------------------------------

async function connect(target, name) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
      return;
    }
    // Anything the page logs as an error, or throws, fails the run.
    if (data.method === 'Runtime.exceptionThrown') {
      const d = data.params.exceptionDetails;
      problems.push(`[${name}] exception: ${(d.exception && d.exception.description) || d.text}`);
    }
    if (data.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(data.params.type)) {
      problems.push(`[${name}] console.${data.params.type}: ${data.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
      problems.push(`[${name}] ${data.params.entry.source}: ${data.params.entry.text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const mouse = (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const clickAt = async (x, y, clickCount = 1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await mouse('mousePressed', x, y, { clickCount });
    await mouse('mouseReleased', x, y, { clickCount });
  };
  // Clicks the middle of whatever the selector finds, as a pointer would.
  const click = async (selector, clickCount = 1) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`${name}: nothing matches ${selector}`);
    await clickAt(box.x, box.y, clickCount);
  };
  const key = async (keyName, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk });
  };
  return { send, evaluate, mouse, click, clickAt, key, close: () => ws.close() };
}

// --- helpers ---------------------------------------------------------------

function profileDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zen-e2e-${tag}-`));
  return dir;
}

const dataFile = (profile) => path.join(profile, 'zen-session-data.json');
const readData = (profile) => JSON.parse(fs.readFileSync(dataFile(profile), 'utf8'));

function weekKeyOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function seed(profile) {
  const wk = weekKeyOf(new Date());
  fs.writeFileSync(
    dataFile(profile),
    JSON.stringify({
      settings: { theme: 'forest', focusMin: 25, autoStartBreaks: false, notify: false, showMedia: false },
      // One session split across midnight, plus one ordinary one: three
      // records, two sessions.
      sessions: [
        { id: 'sA-0', sessionId: 'sA', mode: 'focus', weekKey: wk, day: 1, startMin: 1430, endMin: 1440 },
        { id: 'sA-1', sessionId: 'sA', mode: 'focus', weekKey: wk, day: 2, startMin: 0, endMin: 15 },
        { id: 'old1', mode: 'focus', weekKey: wk, day: 2, startMin: 600, endMin: 625 }
      ],
      plan: []
    })
  );
}

const visible = (c) => c.evaluate('document.visibilityState');

// Chromium calls a window that has never been shown 'visible', so the state
// at launch is asked of Windows itself: which of our top-level windows are on
// screen, by title. The pill's title is plain "Zen Session"; the main window
// carries the clock in front of it.
function windowsOnScreen() {
  const script = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W { public delegate bool P(IntPtr h, IntPtr l);
[DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
public static List<string> List(int[] ids) { var r = new List<string>(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (Array.IndexOf(ids, (int)p) >= 0 && IsWindowVisible(h)) { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (s.Length > 0) r.Add(s.ToString()); } return true; }, IntPtr.Zero); return r; } }
"@
[W]::List([int[]](Get-Process -Name '${path.basename(EXE, '.exe')}').Id)`;
  const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  const titles = out.split(/\r?\n/).filter(Boolean);
  return { main: titles.some((t) => t !== 'Zen Session' && t.endsWith('Zen Session')), pill: titles.includes('Zen Session') };
}
const clock = (c) => c.evaluate("document.getElementById('clock').textContent");

async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --- the run -----------------------------------------------------------------

async function mainRun() {
  console.log('\nnormal launch');
  const profile = profileDir('main');
  seed(profile);
  const child = launch(profile);
  const t = await targets();
  const m = await connect(t.main, 'main');
  const p = await connect(t.pill, 'pill');
  await m.evaluate('document.fonts.ready.then(() => true)');
  await sleep(800);

  // Nothing is clicked until the app has proved it is on the seeded profile:
  // a run that somehow reached the real data file must not change it.
  const onSeed =
    (await m.evaluate('document.documentElement.dataset.theme')) === 'forest' && (await clock(m)) === '25:00';
  if (!onSeed) {
    child.kill();
    throw new Error('the app is not on the throwaway profile; stopped before touching anything');
  }

  const onScreen = windowsOnScreen();
  check(onScreen.main, 'main window is showing');
  check(!onScreen.pill, 'pill is hidden');
  check((await clock(m)) === '25:00', 'clock shows the stored focus length', await clock(m));
  check((await m.evaluate('document.documentElement.dataset.theme')) === 'forest', 'stored theme applied');

  // Start, run, pause.
  await m.click('#btn-primary');
  await sleep(2300);
  const running = await clock(m);
  check(running < '25:00' && running >= '24:50', 'timer counts down after Start', running);
  await m.click('#btn-primary');
  await sleep(300);
  const paused = await clock(m);
  await sleep(1300);
  check((await clock(m)) === paused, 'pause holds the clock', paused);

  // Bug 1, end to end: a theme change must not wipe the paused interval.
  await m.click('.rail-btn[data-view="settings"]');
  await sleep(500);
  await m.click('.theme-btn[data-theme="slate"]');
  await sleep(900);
  check((await m.evaluate('document.documentElement.dataset.theme')) === 'slate', 'theme switches');
  check((await clock(m)) === paused, 'paused progress survives a theme change', `${paused} -> ${await clock(m)}`);
  check(readData(profile).settings.theme === 'slate', 'theme saved to disk');

  // Sounds: the recording travels over IPC into a sandboxed renderer.
  await m.click('.rail-btn[data-view="sounds"]');
  await sleep(500);
  await m.click('#btn-sound');
  const recorded = await waitFor(
    () => m.evaluate('window.Ambience.isPlaying() && window.Ambience.isRecorded(window.Ambience.currentId() || "")'),
    8000,
    'a recorded sound to play'
  ).catch(() => false);
  check(recorded, 'a bundled recording decodes and plays', await m.evaluate('JSON.stringify(window.Ambience.stats())'));
  await m.click('#btn-sound');
  await sleep(300);
  check((await m.evaluate('window.Ambience.isPlaying()')) === false, 'sound stops');

  // Timetable: header, then draw, rename and remove a block with the mouse.
  await m.click('.rail-btn[data-view="timetable"]');
  await sleep(900);
  const header = await m.evaluate("document.getElementById('week-sub').textContent");
  check(/2 sessions completed/.test(header) && /50 m focused/.test(header), 'split session counted once', header);

  const today = (new Date().getDay() + 6) % 7;
  const lane = await m.evaluate(`(() => {
    const panel = document.querySelector('.grid-panel').getBoundingClientRect();
    const track = document.querySelectorAll('.daytrack')[${today}].getBoundingClientRect();
    const left = Math.max(track.left, panel.left + 110);
    return { x: left + 20, y: track.top + track.height / 2, right: Math.min(track.right, panel.right) - 20 };
  })()`);
  const blocksBefore = readData(profile).plan.length;
  const x1 = lane.x;
  const x2 = Math.min(lane.x + 180, lane.right);
  await m.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: lane.y });
  await m.mouse('mousePressed', x1, lane.y);
  for (let i = 1; i <= 12; i++) {
    await m.mouse('mouseMoved', x1 + ((x2 - x1) * i) / 12, lane.y);
    await sleep(16);
  }
  // Settle before letting go, so the release carries no flick.
  for (let i = 0; i < 6; i++) {
    await m.mouse('mouseMoved', x2, lane.y);
    await sleep(40);
  }
  await m.mouse('mouseReleased', x2, lane.y);
  await sleep(900);
  const afterAdd = readData(profile).plan;
  check(afterAdd.length === blocksBefore + 1, 'dragging on a day draws a block', `${blocksBefore} -> ${afterAdd.length}`);
  const block = afterAdd[afterAdd.length - 1];
  check(block && block.day === today && block.startMin % 15 === 0 && block.endMin > block.startMin, 'block snapped to the quarter hour', block && `${block.startMin}-${block.endMin}`);

  if (block) {
    await m.click(`.block[data-id="${block.id}"] .label`, 2);
    await sleep(300);
    await m.send('Input.insertText', { text: 'Write report' });
    await m.key('Enter', 'Enter', 13);
    await sleep(900);
    const renamed = readData(profile).plan.find((b) => b.id === block.id);
    check(renamed && renamed.label === 'Write report', 'double-click renames a block', renamed && renamed.label);

    await m.evaluate(`document.querySelector('.block[data-id="${block.id}"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    await m.click(`.block[data-id="${block.id}"] .remove`);
    await sleep(900);
    check(readData(profile).plan.length === blocksBefore, 'the remove button deletes it');
  }

  // Settings: a one-minute focus, then a real, completed session.
  await m.click('.rail-btn[data-view="timer"]');
  await sleep(400);
  await m.click('#btn-reset');
  await sleep(300);
  await m.click('.rail-btn[data-view="settings"]');
  await sleep(400);
  await m.evaluate("(() => { const i = document.getElementById('s-focus'); i.value = '1'; i.dispatchEvent(new Event('change')); })()");
  await sleep(700);
  check(readData(profile).settings.focusMin === 1, 'focus length saved');
  await m.click('.rail-btn[data-view="timer"]');
  await sleep(400);
  check((await clock(m)) === '01:00', 'an unstarted timer takes the new length', await clock(m));

  const sessionsBefore = readData(profile).sessions.length;
  await m.click('#btn-primary');
  console.log('  ..   waiting out a one-minute focus session');
  await waitFor(() => m.evaluate("document.documentElement.dataset.mode === 'short'"), 70000, 'the session to complete');
  await sleep(900);
  const sessions = readData(profile).sessions;
  const logged = sessions[sessions.length - 1];
  check(sessions.length === sessionsBefore + 1, 'a completed focus session is logged', `${sessionsBefore} -> ${sessions.length}`);
  check(logged && logged.sessionId && logged.endMin - logged.startMin === 1, 'it logs one minute, with a sessionId', logged && `${logged.startMin}-${logged.endMin}`);
  check((await clock(m)) === '05:00', 'the short break is up next', await clock(m));

  // Hand off to the pill and back.
  await m.click('#btn-pill');
  await sleep(1000);
  check((await visible(m)) === 'hidden', 'main window hides for the pill');
  check((await visible(p)) === 'visible', 'pill shows');
  check(/^\d\d:\d\d$/.test(await p.evaluate("document.getElementById('time').textContent")), 'pill shows the clock');
  check((await p.evaluate('document.documentElement.dataset.theme')) === 'slate', 'pill follows the theme');
  // The pill ignores the mouse until the cursor is over it, so this goes
  // through its own button rather than a coordinate.
  await p.evaluate("document.getElementById('btn-restore').click()");
  await sleep(1000);
  check((await visible(m)) === 'visible', 'the pill brings the window back');

  // Quit and make sure everything reached the disk.
  await m.evaluate('window.pomodoro.window.quit(), true');
  m.close();
  p.close();
  check(await gone(), 'quits cleanly');
  await sleep(500);
  const files = fs.readdirSync(profile);
  check(files.includes('zen-session-data.json.bak'), 'backup written');
  check(!files.some((f) => f.endsWith('.tmp')), 'no temp files left behind');
  const final = readData(profile);
  check(final.settings.focusMin === 1 && final.settings.theme === 'slate', 'settings survived the quit');
  child.kill();
  return profile;
}

async function pillAndSecondInstance(profile) {
  console.log('\nlaunch at login (--pill) and a second copy');
  const first = launch(profile, ['--pill']);
  const t = await targets();
  const m = await connect(t.main, 'main');
  const p = await connect(t.pill, 'pill');
  await sleep(1200);
  check((await visible(p)) === 'visible', '--pill shows only the pill');
  check((await visible(m)) === 'hidden', '--pill keeps the window off screen');

  const started = Date.now();
  const second = launch(profile, [], { debug: false });
  const code = await new Promise((res) => second.on('exit', res));
  check(Date.now() - started < 8000, 'a second copy leaves straight away', `exit ${code} after ${Date.now() - started} ms`);
  await sleep(1200);
  check((await visible(m)) === 'visible', 'and brings the running copy forward');

  await m.evaluate('window.pomodoro.window.quit(), true');
  m.close();
  p.close();
  check(await gone(), 'quits cleanly');
  first.kill();
}

async function recoversFromCorruption(profile) {
  console.log('\nrecovery from a damaged data file');
  fs.writeFileSync(dataFile(profile), '{"settings": {"theme": "slate", "foc');
  const child = launch(profile);
  const t = await targets();
  const m = await connect(t.main, 'main');
  const p = await connect(t.pill, 'pill');
  await sleep(1500);
  check((await m.evaluate('document.documentElement.dataset.theme')) === 'slate', 'settings restored from the backup');
  const aside = fs.readdirSync(profile).filter((f) => f.includes('corrupt'));
  check(aside.length === 1, 'the damaged file is kept aside', aside.join(', '));
  await m.evaluate('window.pomodoro.window.quit(), true');
  m.close();
  p.close();
  check(await gone(), 'quits cleanly');
  check(readData(profile).settings.focusMin === 1, 'data file is whole again');
  child.kill();
}

(async () => {
  console.log(`e2e smoke: ${PACKAGED ? 'packaged' : 'development'} build`);
  let profile;
  try {
    profile = await mainRun();
    await pillAndSecondInstance(profile);
    await recoversFromCorruption(profile);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${err.message}`);
  }

  console.log('\nconsole errors and exceptions');
  check(problems.length === 0, 'none', problems.length ? `${problems.length} found` : '');
  for (const line of problems) console.log(`       ${line}`);

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
