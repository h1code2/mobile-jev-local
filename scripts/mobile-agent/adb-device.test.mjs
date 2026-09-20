import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeXmlEntities,
  boundsFromString,
  parseXml,
  parseCurrentFocus,
  parseInputShown,
  parseDeviceList,
  quoteForDeviceShell,
  stateFromDump,
  typeSegments,
  uiaNodeFromXml,
  labelFromPackage,
  runAdb,
} from './adb.mjs';
import { AdbDevice, StaleObservationError } from './device.mjs';

// --- adb.mjs: parsing and encoding ----------------------------------------

test('XML entities decode including numeric and hex references', () => {
  assert.equal(decodeXmlEntities('&lt;a&amp;b&gt;'), '<a&b>');
  assert.equal(decodeXmlEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeXmlEntities('plain'), 'plain');
});

test('bounds parse from the [l,t][r,b] uiautomator format and reject junk', () => {
  assert.deepEqual(boundsFromString('[0,100][720,1600]'), {
    left: 0,
    top: 100,
    right: 720,
    bottom: 1600,
  });
  assert.equal(boundsFromString('nonsense'), null);
  assert.equal(boundsFromString(undefined), null);
  assert.equal(boundsFromString('[0,0][720]'), null);
});

test('tolerant XML parser builds a tree with decoded attributes', () => {
  const doc = parseXml(
    '<hierarchy><node class="EditText" text="&quot;hi&quot;" clickable="true"><node bounds="[0,0][10,10]"/></node></hierarchy>',
  );
  const hierarchy = doc.children[0];
  assert.equal(hierarchy.name, 'hierarchy');
  const node = hierarchy.children[0];
  assert.equal(node.attrs.class, 'EditText');
  assert.equal(node.attrs.text, '"hi"');
  assert.equal(node.attrs.clickable, 'true');
  assert.equal(node.children.length, 1);
});

test('uiautomator node converts to the camelCase tree summarizeState expects', () => {
  const node = uiaNodeFromXml({
    name: 'node',
    attrs: {
      class: 'android.widget.EditText',
      text: 'hello',
      'resource-id': 'com.example:id/field',
      'content-desc': '',
      clickable: 'true',
      enabled: 'true',
      focused: 'true',
      password: 'true',
      bounds: '[0,10][100,50]',
    },
    children: [],
  });
  assert.equal(node.className, 'android.widget.EditText');
  assert.equal(node.isEditable, true);
  assert.equal(node.isPassword, true);
  assert.deepEqual(node.boundsInScreen, { left: 0, top: 10, right: 100, bottom: 50 });
  assert.equal('bounds' in node, false);
});

test('stateFromDump produces Mobilerun-shaped raw state and rejects empty output', () => {
  const xml =
    '<?xml version="1.0"?><hierarchy rotation="0"><node text="Settings" class="android.widget.TextView" ' +
    'clickable="true" enabled="true" bounds="[0,100][720,200]"><node text="child" bounds="[0,100][720,200]"/></node></hierarchy>';
  const raw = stateFromDump(xml, { packageName: 'com.android.settings' });
  assert.deepEqual(raw.device_context.screen_bounds, { width: 720, height: 200 });
  assert.equal(raw.phone_state.packageName, 'com.android.settings');
  assert.equal(raw.a11y_tree.children[0].text, 'Settings');
  assert.equal(raw.a11y_tree.children[0].children.length, 1);
  assert.throws(() => stateFromDump('UI hierarchy is empty', {}), /no XML hierarchy/);
});

test('dumpsys parsing extracts the foreground package and keyboard state', () => {
  const windowDump = [
    'WINDOW MANAGER WINDOWS (dumpsys window windows)',
    '  mCurrentFocus=Window{7a3c1d2 u0 com.android.settings/com.android.settings.Settings}',
  ].join('\n');
  assert.equal(parseCurrentFocus(windowDump), 'com.android.settings');
  assert.equal(parseCurrentFocus('mCurrentFocus=Window{abc u0 NotificationShade}'), '');
  assert.equal(parseCurrentFocus('nothing here'), '');
  assert.equal(parseInputShown('  mInputShown=true  mIsInputViewShown=true'), true);
  assert.equal(parseInputShown('  mInputShown=false'), false);
  assert.equal(parseInputShown(''), false);
});

test('device list parsing maps states and model names', () => {
  const text = [
    '* daemon started successfully',
    'List of devices attached',
    'R58NA1B2C3D\tdevice product:foo model:Pixel_5 device:bar',
    'emulator-5554\toffline',
    '192.168.1.10:5555\tdevice',
    '',
  ].join('\n');
  const devices = parseDeviceList(text);
  assert.deepEqual(devices, [
    { id: 'R58NA1B2C3D', state: 'ready', name: 'Pixel 5' },
    { id: 'emulator-5554', state: 'offline', name: 'emulator-5554' },
    { id: '192.168.1.10:5555', state: 'ready', name: '192.168.1.10:5555' },
  ]);
});

test('device-shell quoting survives quotes without any host-shell interpolation', () => {
  assert.equal(quoteForDeviceShell("it's"), `'it'\\''s'`);
  assert.equal(quoteForDeviceShell('hello world'), `'hello world'`);
  assert.equal(quoteForDeviceShell('p@$$w0rd; rm -rf /'), `'p@$$w0rd; rm -rf /'`);
});

test('text segments split on length and replace control characters', () => {
  assert.deepEqual(typeSegments('hello'), ["'hello'"]);
  assert.deepEqual(typeSegments('a\nb\tc'), ["'a'", "' '", "'b'", "' '", "'c'"]);
  assert.deepEqual(typeSegments('abcdef', { maxChunk: 2 }), ["'ab'", "'cd'", "'ef'"]);
  assert.throws(() => typeSegments(''), /nonempty/);
  assert.throws(() => typeSegments('x', { maxChunk: 0 }), /positive/);
});

test('package labels get readable names without generic-segment mislabels', () => {
  assert.equal(labelFromPackage('com.android.settings'), 'Settings');
  assert.equal(labelFromPackage('com.google.android.youtube'), 'YouTube');
  assert.equal(labelFromPackage('org.mozilla.firefox'), 'Firefox');
  assert.equal(labelFromPackage('com.twitter.android'), 'X');
  assert.equal(labelFromPackage('single'), 'Single');
  // Generic last segments would actively mislead OPEN_APP matching (a phone app
  // once capitalized into "Android"); they are dropped in favor of earlier parts.
  assert.equal(labelFromPackage('com.example.app.android'), 'Example');
  assert.equal(labelFromPackage('com.android.chrome'), 'Chrome');
});

test('runAdb rejects non-string arguments before touching a shell', async () => {
  await assert.rejects(runAdb(['shell', 'input', 42]), /array of strings/);
});

// --- AdbDevice: full behaviour against an injected fake adb ----------------

function fakeAdb(responses, calls = []) {
  return async (args, options = {}) => {
    calls.push({ args, options });
    const key = args.join(' ');
    for (const [pattern, handler] of responses) {
      if (key.includes(pattern)) {
        const value = typeof handler === 'function' ? handler(args, key) : handler;
        return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      }
    }
    throw new Error(`unexpected adb call: ${key}`);
  };
}

const settingsXml =
  '<?xml version="1.0"?><hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">' +
  '<node text="Dark theme" class="android.widget.TextView" resource-id="android:id/title" ' +
  'clickable="true" enabled="true" bounds="[0,300][1080,420]"/>' +
  '<node class="android.widget.Switch" resource-id="android:id/switch_widget" checkable="true" ' +
  'checked="false" clickable="true" enabled="true" bounds="[900,300][1080,420]"/>' +
  '<node class="android.view.View" resource-id="com.example:id/list" scrollable="true" ' +
  'enabled="true" bounds="[0,420][1080,2400]"/>' +
  '</node></hierarchy>';

const formXml =
  '<?xml version="1.0"?><hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">' +
  '<node class="android.widget.EditText" resource-id="com.example:id/search" text="" ' +
  'focused="true" enabled="true" bounds="[0,100][1080,220]"/>' +
  '</node></hierarchy>';

function adbFixture({
  apps = 'package:com.android.settings\npackage:org.mozilla.firefox',
  dump = settingsXml,
} = {}) {
  const calls = [];
  const responses = new Map([
    ['devices -l', 'R5TEST0001\tdevice product:p model:Pixel_8 device:q'],
    ['pm list packages', apps],
    ['dumpsys window', 'mCurrentFocus=Window{abc u0 com.android.settings/.Settings}'],
    ['dumpsys input_method', 'mInputShown=false'],
    ['rm -f', ''],
    ['uiautomator dump', 'UI hierchary dumped to: /sdcard/window_dump.xml'],
    ['cat /sdcard/window_dump.xml', dump],
    [
      'screencap',
      Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('rest-of-png')]),
    ],
    ['input ', ''], // Device mutations succeed with no output.
    ['monkey -p', ''],
  ]);
  return {
    device: new AdbDevice({ deviceId: 'R5TEST0001', run: fakeAdb(responses, calls) }),
    calls,
    responses,
  };
}

test('local observe returns the same schema as the cloud device', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  const observation = await device.observe();
  assert.equal(observation.deviceId, 'R5TEST0001');
  assert.equal(observation.phone.packageName, 'com.android.settings');
  assert.equal(observation.screen.width, 1080);
  assert.equal(observation.screen.height, 2400);
  const darkTheme = observation.elements.find((e) => e.text === 'Dark theme');
  assert.ok(darkTheme?.clickable);
  assert.ok(observation.elements.some((e) => e.checkable && e.checked === false));
  // Exactly one uiautomator dump and one dumpsys pair per observe.
  assert.equal(calls.filter((c) => c.args.join(' ').includes('uiautomator dump')).length, 1);
  assert.ok(calls.some((c) => c.args.join(' ').includes('dumpsys input_method')));
});

test('dump hierarchy retries animated screens and reads the file back over exec-out', async () => {
  const calls = [];
  let dumpAttempts = 0;
  const device = new AdbDevice({
    deviceId: 'R5TEST0001',
    run: async (args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key.includes('uiautomator dump')) {
        dumpAttempts++;
        // First attempt fails like an animated screen; the second succeeds.
        return Buffer.from(
          dumpAttempts === 1
            ? 'ERROR: could not get idle state.'
            : 'UI hierchary dumped to: /sdcard/window_dump.xml',
        );
      }
      if (key.includes('cat /sdcard/window_dump.xml')) return Buffer.from(settingsXml);
      if (key.includes('dumpsys window'))
        return Buffer.from('mCurrentFocus=Window{abc u0 com.android.settings/.Settings}');
      if (key.includes('dumpsys input_method')) return Buffer.from('mInputShown=false');
      if (key.includes('devices')) return Buffer.from('R5TEST0001\tdevice');
      return Buffer.from('');
    },
  });
  await device.assertReady();
  const observation = await device.observe();
  assert.equal(observation.phone.packageName, 'com.android.settings');
  assert.equal(dumpAttempts, 2, 'retried once after the idle-state failure');
  assert.ok(observation.elements.length >= 2);
});

test('dump hierarchy gives up with a stale-screen error when no XML ever arrives', async () => {
  const device = new AdbDevice({
    deviceId: 'R5TEST0001',
    run: async (args) => {
      const key = args.join(' ');
      if (key.includes('uiautomator dump')) return Buffer.from('ERROR: could not get idle state.');
      if (key.includes('devices')) return Buffer.from('R5TEST0001\tdevice');
      return Buffer.from('');
    },
  });
  await device.assertReady();
  await assert.rejects(device.observe(), StaleObservationError);
});

test('assertReady auto-picks a single ready device and rejects several', async () => {
  const solo = new AdbDevice({ run: fakeAdb(new Map([['devices -l', 'ABC\tdevice']])) });
  const info = await solo.assertReady();
  assert.equal(info.id, 'ABC');
  assert.equal(info.state, 'ready');
  const crowd = new AdbDevice({
    run: fakeAdb(new Map([['devices -l', 'ABC\tdevice\nDEF\tdevice']])),
  });
  await assert.rejects(crowd.assertReady(), /Multiple devices/);
  const wrong = new AdbDevice({
    deviceId: 'NOPE',
    run: fakeAdb(new Map([['devices -l', 'ABC\tdevice']])),
  });
  await assert.rejects(wrong.assertReady(), /not connected/);
  const unauthorized = new AdbDevice({
    deviceId: 'ABC',
    run: fakeAdb(new Map([['devices -l', 'ABC\tunauthorized']])),
  });
  await assert.rejects(unauthorized.assertReady(), /unauthorized/);
  const none = new AdbDevice({
    run: fakeAdb(new Map([['devices -l', 'List of devices attached\n']])),
  });
  await assert.rejects(none.assertReady(), /No ready adb device/);
});

test('a failed local observation never navigates the device', async () => {
  const { device, calls, responses } = adbFixture();
  responses.set('uiautomator dump', 'ERROR: could not get idle state');
  await assert.rejects(device.observe(), StaleObservationError);
  assert.equal(
    calls.some((call) => call.args.join(' ').includes('input keyevent 4')),
    false,
  );
});

test('listApps returns sorted packages with fallback labels', async () => {
  const { device } = adbFixture();
  const apps = await device.listApps();
  assert.deepEqual(apps, [
    { packageName: 'com.android.settings', label: 'Settings' },
    { packageName: 'org.mozilla.firefox', label: 'Firefox' },
  ]);
});

test('tap-element resolves the observed center and dispatches exact input args', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  const expected = await device.observe();
  calls.length = 0;
  await device.act({ type: 'tap-element', elementId: 'ui.0.0' }, { expected });
  const tap = calls.find((c) => c.args.includes('tap'));
  assert.ok(tap, 'expected an input tap call');
  assert.deepEqual(tap.args.slice(-2), ['540', '360']); // Center of [0,300][1080,420].
  assert.deepEqual(tap.args.slice(0, 4), ['-s', 'R5TEST0001', 'shell', 'input']);
});

test('stale or wrong-device expectations never reach input', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  const expected = await device.observe();
  await assert.rejects(
    device.act(
      { type: 'tap-element', elementId: 'ui.0.0' },
      { expected: { ...expected, observedAt: 0 } },
    ),
    StaleObservationError,
  );
  await assert.rejects(
    device.act(
      { type: 'tap-element', elementId: 'ui.0.0' },
      { expected: { ...expected, deviceId: 'other' } },
    ),
    /different device|Screen changed/,
  );
  assert.equal(
    calls.some((c) => c.args.join(' ').includes('input tap')),
    false,
  );
});

test('type clears first, then sends quoted shell tokens per segment', async () => {
  const { device, calls } = adbFixture({ dump: formXml });
  await device.assertReady();
  const expected = await device.observe();
  assert.equal(expected.phone.isEditable, true, 'focused EditText yields an editable context');
  calls.length = 0;
  await device.act({ type: 'type', text: "R'2-D2\n", clear: true }, { expected });
  const shell = calls.filter((c) => c.args.join(' ').includes('input'));
  assert.ok(
    shell.some((c) => c.args.join(' ').includes('keycombination')),
    'select-all first',
  );
  assert.ok(
    shell.some((c) => c.args.join(' ').includes('keyevent 67')),
    'then delete',
  );
  const text = shell.filter((c) => c.args.at(-2) === 'text');
  assert.deepEqual(
    text.map((c) => c.args.at(-1)),
    ["'R'\\''2-D2'", "' '"], // Quote-escaped chunk, then the newline replacement.
  );
});

test('typing without a focused editable field is rejected before any input', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  await assert.rejects(device.act({ type: 'type', text: 'hi' }), /Focus an editable field/);
  assert.equal(
    calls.some((c) => c.args.join(' ').includes('input text')),
    false,
  );
});

test('non-ASCII input enables and selects an installed ADBKeyBoard', async () => {
  const { device, calls, responses } = adbFixture({ dump: formXml });
  let enabled = false;
  responses.set('ime list -s', () => (enabled ? 'com.android.adbkeyboard/.AdbIME\n' : ''));
  responses.set('pm path com.android.adbkeyboard', 'package:/data/app/ADBKeyboard.apk');
  responses.set('ime enable com.android.adbkeyboard/.AdbIME', () => {
    enabled = true;
    return 'Input method enabled';
  });
  responses.set('settings get secure default_input_method', 'com.android.inputmethod/.LatinIME');
  responses.set('ime set com.android.adbkeyboard/.AdbIME', 'Input method selected');
  responses.set('am broadcast', 'Broadcast completed');
  await device.assertReady();
  await device.act({ type: 'type', text: '北京时间', clear: false });
  assert.ok(
    calls.some((call) =>
      call.args.join(' ').includes('ime enable com.android.adbkeyboard/.AdbIME'),
    ),
  );
  assert.ok(
    calls.some((call) => call.args.join(' ').includes('ime set com.android.adbkeyboard/.AdbIME')),
  );
  assert.ok(calls.some((call) => call.args.join(' ').includes('ADB_INPUT_TEXT')));
});

test('global navigation, keys, and swipe map to input keyevent/swipe', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  const expected = await device.observe();
  calls.length = 0;
  await device.act({ type: 'global', name: 'back' }, { expected });
  await device.act({ type: 'global', name: 'home' }, { expected });
  await device.act({ type: 'key', key: 'enter' }, { expected });
  await device.act({ type: 'swipe', startX: 100, startY: 500, endX: 100, endY: 200 }, { expected });
  const joined = calls.map((c) => c.args.join(' '));
  assert.ok(
    joined.some((c) => c.includes('keyevent 4')),
    'back keyevent',
  );
  assert.ok(
    joined.some((c) => c.includes('keyevent 3')),
    'home keyevent',
  );
  assert.ok(
    joined.some((c) => c.includes('keyevent 66')),
    'enter keyevent',
  );
  const swipe = joined.find((c) => c.includes('input swipe'));
  assert.ok(swipe?.endsWith('100 500 100 200 300'), 'swipe carries coordinates and duration');
});

test('swipe projection resolves the gesture inside a moved scroll region', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  const expected = await device.observe();
  const region = expected.elements.find((e) => e.resourceId === 'com.example:id/list');
  assert.ok(region?.scrollable, 'fixture exposes the scrollable list');
  calls.length = 0;
  await device.act(
    {
      type: 'swipe',
      startX: 540,
      startY: 2000,
      endX: 540,
      endY: 600,
      duration: 250,
      regionId: region.id,
    },
    { expected },
  );
  const swipe = calls.map((c) => c.args.join(' ')).find((c) => c.includes('input swipe'));
  assert.ok(swipe?.includes('540 2000 540 600 250'), 'projected swipe dispatched');
});

test('open-app requires the app to have been listed first', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  await device.listApps();
  calls.length = 0;
  await device.act({ type: 'open-app', packageName: 'com.android.settings' });
  assert.ok(calls.some((c) => c.args.join(' ').includes('monkey -p com.android.settings')));
  await assert.rejects(
    device.act({ type: 'open-app', packageName: 'com.uninstalled.app' }),
    /not observed/,
  );
});

test('screenshot validates the PNG signature and binary transport', async () => {
  const { device } = adbFixture();
  await device.assertReady();
  const png = await device.screenshot();
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const broken = new AdbDevice({
    deviceId: 'R5TEST0001',
    run: fakeAdb(
      new Map([
        ['devices -l', 'R5TEST0001\tdevice'],
        ['screencap', '<html>404</html>'],
      ]),
    ),
  });
  await broken.assertReady();
  await assert.rejects(broken.screenshot(), /not a PNG/);
});

test('readiness caches for 30 seconds; direct commands still observe before dispatch', async () => {
  const { device, calls } = adbFixture();
  await device.assertReady();
  calls.length = 0;
  await device.act({ type: 'global', name: 'back' }, {});
  const joined = calls.map((c) => c.args.join(' '));
  assert.equal(joined.filter((c) => c.includes('devices -l')).length, 0, 'no repeated readiness');
  assert.ok(
    joined.some((c) => c.includes('uiautomator dump')),
    'observe before dispatch',
  );
});

test('summarized local state works with assertFresh from the shared decision loop', async () => {
  const { device } = adbFixture();
  await device.assertReady();
  const expected = await device.observe();
  assert.doesNotReject(device.act({ type: 'tap-element', elementId: 'ui.0.0' }, { expected }));
});
