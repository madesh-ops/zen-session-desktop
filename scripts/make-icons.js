'use strict';

// Rasterises the brand SVGs into the icons Windows needs, and packs them into
// .ico files. Run with `npm run icons` (it runs under Electron, so Chromium
// does the SVG rendering — no image library to install).
//
// Which source is used at which size follows the brand set's own logic: the
// 16px artwork is the ultra-simplified one, everything larger uses the app
// icon, because below ~24px the thin sage arc and the inner dot turn to mush.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const BRAND = path.join(__dirname, '..', 'resources', 'brand');
const OUT = path.join(__dirname, '..', 'resources');

const APP_ICON = path.join(BRAND, 'zen-session-app-icon.svg');
const FAVICON_16 = path.join(BRAND, 'zen-session-favicon-16.svg');

// size -> source svg
const ICO_SIZES = [
  [16, FAVICON_16],
  [24, FAVICON_16],
  [32, APP_ICON],
  [48, APP_ICON],
  [64, APP_ICON],
  [128, APP_ICON],
  [256, APP_ICON]
];

// The tray gets PNGs, not an .ico. Electron reports an .ico as 256x256 and
// upscales it, which renders blurry in the notification area; a plain PNG plus
// its @2x representation is unambiguous. Both come from the 16px artwork —
// extra bold, no inner dot — because that is what survives being drawn at
// 16 logical pixels.
const TRAY_PNGS = [
  ['tray.png', 32, FAVICON_16],
  ['tray@2x.png', 64, FAVICON_16]
];

const TMP = path.join(require('os').tmpdir(), 'zen-icon-render');

let win = null;

// One window, reused. Creating and destroying a BrowserWindow per size, or
// loading long data: URLs repeatedly, both fail intermittently; a plain file
// load into a single window does not. The window stays comfortably larger than
// the biggest icon and each render is cropped out of its top-left corner, so
// Windows never clamps it to a minimum size.
const CANVAS = 300;

function ensureWindow() {
  if (win) return win;
  win = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false }
  });
  return win;
}

function writePage(svgPath, size) {
  fs.mkdirSync(TMP, { recursive: true });
  const svg = fs.readFileSync(svgPath, 'utf8');
  const svgFile = path.join(TMP, `art-${size}-${path.basename(svgPath)}`);
  fs.writeFileSync(svgFile, svg, 'utf8');

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    img{position:absolute;left:0;top:0;width:${size}px;height:${size}px}
  </style></head><body><img src="${path.basename(svgFile)}"></body></html>`;

  const htmlFile = path.join(TMP, `page-${size}-${path.basename(svgPath)}.html`);
  fs.writeFileSync(htmlFile, html, 'utf8');
  return htmlFile;
}

async function render(svgPath, size) {
  const w = ensureWindow();
  await w.loadFile(writePage(svgPath, size));
  // Give the SVG a frame or two to paint before grabbing it.
  await new Promise((r) => setTimeout(r, 200));

  let image = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  // On a scaled display the capture comes back larger than requested.
  if (image.getSize().width !== size) {
    image = image.resize({ width: size, height: size, quality: 'best' });
  }

  const png = image.toPNG();
  if (!png || png.length === 0) throw new Error(`empty render at ${size}px`);
  return png;
}

// Vista-era .ico: each entry may be a whole PNG rather than a DIB.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir[at] = size >= 256 ? 0 : size; // 0 means 256
    dir[at + 1] = size >= 256 ? 0 : size;
    dir[at + 2] = 0; // palette
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

async function makeIco(spec, outPath) {
  const entries = [];
  for (const [size, svgPath] of spec) {
    entries.push({ size, png: await render(svgPath, size) });
    process.stdout.write(`  ${size}px from ${path.basename(svgPath)}\n`);
  }
  fs.writeFileSync(outPath, buildIco(entries));
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`wrote ${path.relative(process.cwd(), outPath)} (${entries.length} sizes, ${kb} KB)\n`);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    console.log('app icon:');
    await makeIco(ICO_SIZES, path.join(OUT, 'icon.ico'));

    console.log('tray icon:');
    for (const [name, size, svgPath] of TRAY_PNGS) {
      fs.writeFileSync(path.join(OUT, name), await render(svgPath, size));
      console.log(`  ${name} (${size}px from ${path.basename(svgPath)})`);
    }
    console.log('');

    // A plain PNG as well, for anywhere that will not take an .ico.
    fs.writeFileSync(path.join(OUT, 'icon-256.png'), await render(APP_ICON, 256));
    console.log('wrote resources/icon-256.png');
  } catch (err) {
    console.error('icon generation failed:', err.message);
    app.exit(1);
    return;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
  app.exit(0);
});
