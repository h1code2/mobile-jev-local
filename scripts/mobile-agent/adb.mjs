import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Keycodes used by the local AdbDevice transport (KEYCODE_* constants).
export const KEYCODE = {
  back: 4,
  home: 3,
  recent: 187,
  moveEnd: 123,
  del: 67,
  ctrlLeft: 113,
  a: 29,
};

// Argument arrays only: no shell interpolation on the host. `adb shell` joins the
// arguments and the on-device shell parses them, which is where quoting matters.
export async function runAdb(args, { timeoutMs = 20_000, binary = false } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('adb arguments must be an array of strings.');
  try {
    const { stdout } = await execFile('adb', args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8',
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8');
  } catch (error) {
    const text = (field) =>
      typeof field === 'string' ? field : Buffer.isBuffer(field) ? field.toString('utf8') : '';
    const detail = [text(error.stderr), error.message]
      .join(' ')
      .trim()
      .split('\n')[0]
      .replace(/^error:\s*/i, '');
    throw new Error(
      `adb ${args[0]} failed: ${error.killed ? 'timed out' : detail || 'unknown error'}`,
    );
  }
}

const NAMED_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

export function decodeXmlEntities(value) {
  return value.replace(/&(?:lt|gt|quot|apos|amp|#x?[0-9a-fA-F]+);/g, (entity) => {
    if (NAMED_ENTITIES[entity]) return NAMED_ENTITIES[entity];
    const code =
      entity[2] === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isSafeInteger(code) && code > 0 ? String.fromCodePoint(code) : entity;
  });
}

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// A small tolerant parser: uiautomator output is well-formed but varies across
// Android builds, and pulling in a DOM dependency is unnecessary.
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  for (const match of xml.matchAll(TAG)) {
    const [, closing, name, attrsText = '', selfClose] = match;
    if (closing) {
      const found = stack.findLastIndex((node) => node.name === name);
      if (found > 0) stack.length = found; // Pop back to the matching open tag.
      continue;
    }
    const attrs = {};
    for (const attr of attrsText.matchAll(ATTR))
      attrs[attr[1]] = decodeXmlEntities(attr[2] ?? attr[3] ?? '');
    const node = { name, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

export function boundsFromString(value) {
  const match =
    typeof value === 'string' ? value.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/) : null;
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return { left, top, right, bottom };
}

const EDITABLE_CLASSES = [
  'android.widget.EditText',
  'android.widget.AutoCompleteTextView',
  'android.widget.MultiAutoCompleteTextView',
];

// Convert one parsed <node> into the camelCase shape summarizeState() consumes.
export function uiaNodeFromXml(node) {
  const a = node.attrs || {};
  const bounds = boundsFromString(a.bounds);
  return {
    className: a.class || '',
    text: a.text || '',
    resourceId: a['resource-id'] || '',
    contentDescription: a['content-desc'] || '',
    packageName: a.package || '',
    isEditable: EDITABLE_CLASSES.includes(a.class),
    isClickable: a.clickable === 'true',
    isEnabled: a.enabled !== 'false',
    isFocused: a.focused === 'true',
    isScrollable: a.scrollable === 'true',
    isPassword: a.password === 'true',
    isCheckable: a.checkable === 'true',
    isChecked: a.checked === 'true',
    isSelected: a.selected === 'true',
    isVisibleToUser: a['visible-to-user'] !== 'false',
    ...(bounds ? { boundsInScreen: bounds } : {}),
    children: (node.children || []).filter((child) => child.name === 'node').map(uiaNodeFromXml),
  };
}

// Build the Mobilerun-compatible raw state from a `uiautomator dump` payload.
export function stateFromDump(
  xml,
  { packageName = '', keyboardVisible = false, screen = null } = {},
) {
  const start = xml.indexOf('<');
  const end = xml.lastIndexOf('>');
  if (start < 0 || end <= start)
    throw new Error(
      'uiautomator returned no XML hierarchy; the screen may be animated. Retry, or go HOME first.',
    );
  const document = parseXml(xml.slice(start, end + 1));
  const roots = document.children
    .filter((node) => node.name === 'hierarchy')
    .flatMap((hierarchy) =>
      hierarchy.children.filter((child) => child.name === 'node').map(uiaNodeFromXml),
    );
  const bounds = [];
  const walk = (node) => {
    if (node.boundsInScreen) bounds.push(node.boundsInScreen);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  const width = Math.max(0, ...bounds.map((b) => b.right));
  const height = Math.max(0, ...bounds.map((b) => b.bottom));
  const screenBounds = width >= 100 && height >= 100 ? { width, height } : screen;
  if (!screenBounds || screenBounds.width < 1 || screenBounds.height < 1)
    throw new Error('UI state is missing valid screen bounds.');
  return {
    device_context: { screen_bounds: { width: screenBounds.width, height: screenBounds.height } },
    phone_state: { packageName, currentApp: packageName, keyboardVisible },
    a11y_tree: { children: roots },
  };
}

// mCurrentFocus=Window{abc123 u0 com.android.settings/com.android.settings.Settings}
export function parseCurrentFocus(dumpsysOutput) {
  const line = String(dumpsysOutput)
    .split('\n')
    .find((l) => l.includes('mCurrentFocus='));
  if (!line) return '';
  const match = line.match(/mCurrentFocus=Window\{[^}]*\}/);
  if (!match) return '';
  const tokens = match[0]
    .slice(match[0].indexOf('{') + 1, -1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const withSlash = tokens.find((token) => token.includes('/'));
  const candidate = (withSlash ? withSlash.split('/')[0] : tokens.at(-1)) || '';
  return /^(\w+\.)+\w+$/.test(candidate) ? candidate : '';
}

// mResumedActivity: ActivityRecord{c6b7980 u0 com.android.settings/.Settings t38}
// Some builds lack mCurrentFocus; the resumed activity names the same package.
export function parseResumedActivity(dumpsysOutput) {
  for (const line of String(dumpsysOutput).split('\n')) {
    if (!/topResumedActivity|mResumedActivity/.test(line)) continue;
    const match = line.match(/ActivityRecord\{[^}]*\s((?:\w+\.)+\w+)\//);
    if (match) return match[1];
  }
  return '';
}

// mInputShown=true when the soft keyboard is visible.
export function parseInputShown(dumpsysOutput) {
  const line = String(dumpsysOutput)
    .split('\n')
    .find((l) => l.includes('mInputShown='));
  return Boolean(line) && line.includes('mInputShown=true');
}

// `adb devices -l`: R58Nxxxxxxxx device product:... model:Pixel_5 ...
export function parseDeviceList(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map((line) => line.split(/\s+/))
    .filter((tokens) => tokens.length >= 2 && /^[\w.,:_-]+$/.test(tokens[0]))
    .map(([id, state, ...rest]) => ({
      id,
      state: state === 'device' ? 'ready' : state,
      name:
        (rest.find((token) => token.startsWith('model:')) || '').slice(6).replace(/_/g, ' ') || id,
    }));
}

// Labels feed OPEN_APP candidates, so a wrong guess actively misleads the model:
// `com.twitter.android` capitalized to "Android" once hijacked a "dark theme in
// Android Settings" goal. Known apps get real names; generic segments do not
// become labels at all, so those apps are reached through the launcher instead.
const WELL_KNOWN_LABELS = {
  'com.android.settings': 'Settings',
  'com.android.deskclock': 'Clock',
  'com.android.calculator2': 'Calculator',
  'com.android.calendar': 'Calendar',
  'com.android.camera': 'Camera',
  'com.android.chrome': 'Chrome',
  'com.android.contacts': 'Contacts',
  'com.android.dialer': 'Phone',
  'com.android.documentsui': 'Files',
  'com.android.email': 'Email',
  'com.android.gallery3d': 'Gallery',
  'com.android.messaging': 'Messaging',
  'com.android.mms': 'Messaging',
  'com.android.music': 'Music',
  'com.android.vending': 'Play Store',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.gm': 'Gmail',
  'com.google.android.apps.maps': 'Maps',
  'com.google.android.apps.photos': 'Photos',
  'com.google.android.apps.messaging': 'Messages',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.googlequicksearchbox': 'Google',
  'com.twitter.android': 'X',
  'com.instagram.android': 'Instagram',
  'com.facebook.katana': 'Facebook',
  'com.whatsapp': 'WhatsApp',
  'com.spotify.music': 'Spotify',
  'com.netflix.mediaclient': 'Netflix',
  'com.slack': 'Slack',
  'com.tencent.mm': 'WeChat',
  'com.ss.android.ugc.aweme': 'TikTok',
};

// Segments that carry no identity: never capitalize them into an app label.
const GENERIC_SEGMENTS = new Set([
  'android',
  'google',
  'apps',
  'app',
  'com',
  'org',
  'io',
  'net',
  'dev',
  'mobile',
  'client',
  'partner',
  'platform',
]);

export function labelFromPackage(pkg) {
  const known = WELL_KNOWN_LABELS[String(pkg)];
  if (known) return known;
  const segments = String(pkg)
    .split('.')
    .filter(Boolean)
    .filter((segment) => !GENERIC_SEGMENTS.has(segment.toLowerCase()));
  const segment = segments.at(-1);
  if (!segment) return '';
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

// `input text` receives the value through the on-device shell, so quote it there.
// Host-side, execFile carries the token verbatim: no local interpolation ever happens.
export function quoteForDeviceShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Android's `input text` synthesizes keys through the IME and only covers ASCII;
// CJK or accented text makes it throw on-device. Newline/tab are not sent as
// themselves (they become space keystrokes), so they stay transmittable.
// ADBKeyBoard's broadcast is the escape hatch for everything else
// (https://github.com/senzhk/ADBKeyBoard).
export function isAsciiTransmittable(text) {
  return typeof text === 'string' && /^[\x20-\x7E]*$/.test(text.replace(/[\n\r\t]/g, ' '));
}

// `input text` cannot carry control characters: newline/tab each become their own
// space keystroke while ordinary runs stay in one quoted token. Runs are chunked
// because very long single arguments have failed on some devices.
export function typeSegments(text, { maxChunk = 150 } = {}) {
  if (typeof text !== 'string' || !text.length) throw new Error('Text must be a nonempty string.');
  if (!Number.isSafeInteger(maxChunk) || maxChunk < 1)
    throw new Error('maxChunk must be a positive integer.');
  const segments = [];
  let run = '';
  const flush = () => {
    for (let start = 0; start < run.length; start += maxChunk)
      segments.push(quoteForDeviceShell(run.slice(start, start + maxChunk)));
    run = '';
  };
  for (const char of text) {
    if (['\n', '\r', '\t'].includes(char)) {
      flush();
      segments.push(quoteForDeviceShell(' '));
    } else {
      run += char;
      if (run.length >= maxChunk) flush();
    }
  }
  flush();
  return segments;
}
