'use strict';

/* Builds resources/sounds/ from freely licensed field recordings.
 *
 * Run with `npm run sounds`. It is a development tool, not something the app
 * ever calls: the finished .ogg files are committed and shipped, and ffmpeg
 * comes from the ffmpeg-static devDependency, which electron-builder leaves
 * out of the installer.
 *
 * Each source is trimmed to one window that was chosen by measuring the
 * recording rather than by guessing — level spread, spectral flatness and the
 * absence of tonal frames (birdsong, voices, hum) — then loudness-matched so
 * switching sounds in the app does not jump, then made circular.
 *
 * The loop is the part worth understanding. A clip that simply repeats clicks
 * at the seam, because the last sample and the first are unrelated. So the
 * window is cut LOOP + TAIL seconds long and reassembled:
 *
 *     head = [0, TAIL)        mid = [TAIL, LOOP)        tail = [LOOP, LOOP+TAIL)
 *     loop = crossfade(tail, head) ++ mid
 *
 * The end of `mid` is the sample just before `tail` starts, and the crossfade
 * ends on `head`'s last sample, which is the sample just before `mid` starts.
 * Both joins are continuous, so the file can loop forever with nothing to
 * hear. The crossfade is equal-power (qsin) because the two sides are
 * uncorrelated noise; a linear one would dip in the middle.
 *
 * It is written as two afades into an unnormalised amix rather than with
 * acrossfade, which collapses to nothing when the overlap is as long as the
 * pieces it is given — which is exactly the case here.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'resources', 'sounds');
const CACHE = path.join(ROOT, '.sound-cache');

const LOOP = 40; // seconds of finished loop
const TAIL = 3; // seconds of circular crossfade
const LUFS = -20; // integrated loudness every sound is matched to

// Wikimedia rejects a user agent that names no way to reach whoever is running
// it — an anonymous one comes back as an HTML error page, not audio.
const UA = 'ZenSession-sound-build/1.0 (madeshmithran055@gmail.com)';

// start: where the chosen window begins, in seconds into the source.
const SOURCES = [
  {
    // Chosen to be worked under for hours rather than listened to. Of every
    // rain recording measured, this window is the steadiest: 0.8 dB of level
    // variation across 43 seconds and not one quarter-second that jumps above
    // its neighbours. Drips and gusts are what pull attention back out of a
    // page, so a bed for studying wants none of them.
    id: 'rain',
    start: 32,
    // Only the first 60 MB of a 329 MB, 96 kHz master: the window is at 32s.
    bytes: 60 * 1024 * 1024,
    // A shelf off the top. The source is an even hiss centred near 2.5 kHz,
    // and that brightness is what makes a rain bed tiring by the second hour.
    shape: 'highshelf=f=5000:g=-3.5',
    file: 'Calm_rain.wav',
    title: 'Calm rain',
    author: 'Zuvji',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
    page: 'https://commons.wikimedia.org/wiki/File:Calm_rain.wav',
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/cf/Calm_rain.wav'
  },
  {
    id: 'waves',
    start: 18,
    file: 'Ocean_Waves_on_a_Tropical_Beach.ogg',
    title: 'Ocean Waves on a Tropical Beach',
    author: 'Jarrod Stanley',
    license: 'CC0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    page: 'https://commons.wikimedia.org/wiki/File:Ocean_Waves_on_a_Tropical_Beach.ogg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/64/Ocean_Waves_on_a_Tropical_Beach.ogg'
  },
  {
    // Called "Nature" in the app; the recording is woodland air on a windy day.
    id: 'nature',
    start: 2,
    file: 'Bourne_woods_windy_2020-05-05_0757.mp3',
    title: 'Bourne woods, windy',
    author: 'Robert EA Harvey',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
    page: 'https://commons.wikimedia.org/wiki/File:Bourne_woods_windy_2020-05-05_0757.mp3',
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/a3/Bourne_woods_windy_2020-05-05_0757.mp3'
  },
  {
    id: 'fire',
    start: 3,
    file: 'WWS_Bonfireburning.ogg',
    title: 'Bonfire burning',
    author: 'Work With Sounds / Werstas',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0',
    page: 'https://commons.wikimedia.org/wiki/File:WWS_Bonfireburning.ogg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/7/70/WWS_Bonfireburning.ogg'
  }
];

// `bytes`, when a source sets it, asks for only the first part of the file.
// The window is near the start of these recordings, and one of them is 329 MB
// of 96 kHz masters for the sake of 43 seconds. A truncated WAV decodes fine:
// ffmpeg reads what is there and stops.
function download(url, dest, redirects = 0, bytes = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const headers = { 'User-Agent': UA };
    if (bytes) headers.Range = `bytes=0-${bytes - 1}`;
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1, bytes));
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(new Error(`${res.statusCode} for ${url}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function run(args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function mb(file) {
  return (fs.statSync(file).size / 1048576).toFixed(2);
}

async function build(source) {
  fs.mkdirSync(CACHE, { recursive: true });
  const raw = path.join(CACHE, source.file);
  if (!fs.existsSync(raw)) {
    process.stdout.write(`  downloading ${source.file} … `);
    await download(source.url, raw, 0, source.bytes || 0);
    process.stdout.write(`${mb(raw)} MB\n`);
  }

  // Loudness first, on the untouched window, so the crossfade below joins two
  // pieces that have already been through the same gain. Normalising after
  // the join would ride the level across the seam and undo it.
  const level = path.join(CACHE, `${source.id}-level.wav`);
  run([
    '-ss', String(source.start),
    '-t', String(LOOP + TAIL),
    '-i', raw,
    '-af', `highpass=f=28${source.shape ? ',' + source.shape : ''},loudnorm=I=${LUFS}:TP=-3:LRA=11`,
    '-ac', '2',
    '-ar', '44100',
    level
  ]);

  const out = path.join(OUT, `${source.id}.ogg`);
  run([
    '-i', level,
    '-filter_complex',
    [
      `[0:a]atrim=0:${TAIL},asetpts=N/SR/TB,afade=t=in:st=0:d=${TAIL}:curve=qsin[head]`,
      `[0:a]atrim=${TAIL}:${LOOP},asetpts=N/SR/TB[mid]`,
      `[0:a]atrim=${LOOP}:${LOOP + TAIL},asetpts=N/SR/TB,afade=t=out:st=0:d=${TAIL}:curve=qsin[tail]`,
      `[tail][head]amix=inputs=2:normalize=0[join]`,
      `[join][mid]concat=n=2:v=0:a=1[out]`
    ].join(';'),
    '-map', '[out]',
    '-c:a', 'libvorbis',
    '-q:a', '3',
    '-metadata', `title=${source.title}`,
    '-metadata', `artist=${source.author}`,
    '-metadata', `license=${source.license}`,
    '-metadata', `comment=${source.page}`,
    out
  ]);

  console.log(`  ${source.id}.ogg  ${mb(out)} MB  ${source.license}  (${source.title})`);
  return out;
}

function credits() {
  const lines = [
    '# Sound credits',
    '',
    'The recordings in this folder are excerpts from freely licensed field',
    'recordings on Wikimedia Commons, trimmed and loudness-matched by',
    '`scripts/fetch-sounds.js`. Each excerpt stays under the licence of the',
    'recording it came from — those licences are listed below, and they are',
    'separate from the MIT licence covering the rest of Zen Session.',
    '',
    'The synthesised beds in src/renderer/js/ambience.js are not listed: they',
    'are generated, not recorded, and only stand in if a file here is missing.',
    ''
  ];
  for (const s of SOURCES) {
    lines.push(
      `## ${s.id}.ogg`,
      '',
      `- **${s.title}** by ${s.author}`,
      `- Licence: [${s.license}](${s.licenseUrl})`,
      `- Source: ${s.page}`,
      `- Excerpt: ${LOOP}s from ${s.start}s in, normalised to ${LUFS} LUFS, looped with a ${TAIL}s circular crossfade`,
      ''
    );
  }
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), lines.join('\n'), 'utf8');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`Building ${SOURCES.length} loops into resources/sounds/`);
  for (const source of SOURCES) await build(source);
  credits();
  console.log('Wrote CREDITS.md. Sources are cached in .sound-cache/ and can be deleted.');
})().catch((err) => {
  console.error('\nSound build failed:', err.message);
  process.exit(1);
});
