import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { curlRequest, decodeJson } from './http.mjs';
import { prepareInputVerification } from './input-verification.mjs';
import {
  KEYCODE,
  PNG_MAGIC,
  isAsciiTransmittable,
  labelFromPackage,
  parseCurrentFocus,
  parseDeviceList,
  parseInputShown,
  parseResumedActivity,
  quoteForDeviceShell,
  runAdb,
  stateFromDump,
  typeSegments,
} from './adb.mjs';

export const GLOBAL_ACTIONS = { back: 1, home: 2, recent: 3 };
export const KEYS = { back: 4, tab: 61, enter: 66, delete: 67, forward_delete: 112 };

export function createDevice(options = {}) {
  const transport = (process.env.DEVICE_TRANSPORT || 'mobilerun').trim().toLowerCase();
  if (transport === 'adb') return new AdbDevice(options);
  if (transport === 'mobilerun') return new MobilerunDevice(options);
  throw new Error(`Unsupported DEVICE_TRANSPORT "${transport}"; use adb or mobilerun.`);
}

export class StaleObservationError extends Error {}

function targetMeaning(observation, id) {
  const target = observation.elements.find((element) => element.id === id);
  if (!target) return null;
  const meaning = Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'bounds'));
  return JSON.stringify({
    ...meaning,
    content: observation.elements
      .filter((e) => e.id.startsWith(id + '.'))
      .map(({ id, text, label, resourceId, editable, enabled, checked, selected }) => ({
        id,
        text,
        label,
        resourceId,
        editable,
        enabled,
        checked,
        selected,
      })),
  });
}

export function assertFresh(current, expected, action, maxAgeMs = 30_000) {
  if (
    !expected ||
    current.deviceId !== expected.deviceId ||
    !Number.isFinite(expected.observedAt) ||
    Date.now() - expected.observedAt > maxAgeMs ||
    expected.observedAt > Date.now() ||
    current.phone.packageName !== expected.phone?.packageName ||
    JSON.stringify(current.screen) !== JSON.stringify(expected.screen)
  ) {
    throw new StaleObservationError(
      'Screen changed or observation expired; observe and decide again.',
    );
  }
  let fresh;
  if (action.type === 'tap-element') {
    fresh =
      targetMeaning(expected, action.elementId) !== null &&
      targetMeaning(current, action.elementId) === targetMeaning(expected, action.elementId);
  } else if (['type', 'clear', 'key'].includes(action.type) && expected.phone.inputElementId) {
    const id = expected.phone.inputElementId;
    fresh =
      current.phone.isEditable &&
      current.phone.inputElementId === id &&
      targetMeaning(current, id) === targetMeaning(expected, id);
  } else if (action.type === 'global' && action.name === 'home') {
    fresh = true; // HOME is independent of in-app content such as clocks and animations.
  } else if (action.type === 'global') {
    const navigationMeaning = (state) =>
      JSON.stringify({
        phone: state.phone,
        controls: state.elements
          .filter((e) => e.clickable || e.editable)
          .map((e) => targetMeaning(state, e.id)),
        headings: state.elements
          .filter((e) => e.resourceId?.endsWith(':id/title') || e.label)
          .map((e) => [e.id, e.text, e.label]),
      });
    fresh = navigationMeaning(current) === navigationMeaning(expected);
  } else if (action.type === 'swipe' && action.regionId) {
    const before = expected.elements.find((e) => e.id === action.regionId);
    const after = current.elements.find((e) => e.id === action.regionId);
    fresh = before && after?.enabled && after.scrollable && before.resourceId === after.resourceId;
  } else {
    fresh = current.fingerprint === expected.fingerprint;
  }
  if (!fresh)
    throw new StaleObservationError(
      'Screen changed or observation expired; observe and decide again.',
    );
}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}.`);
}

export function summarizeState(raw, deviceId) {
  const screen = raw?.device_context?.screen_bounds;
  if (
    !screen ||
    !Number.isSafeInteger(screen.width) ||
    !Number.isSafeInteger(screen.height) ||
    screen.width < 1 ||
    screen.height < 1 ||
    !raw.phone_state ||
    !raw.a11y_tree
  ) {
    throw new Error('UI state is missing its tree, phone state, or valid screen bounds.');
  }
  const elements = [];
  const visit = (node, path) => {
    if (!node || typeof node !== 'object') return;
    const b = node.boundsInScreen;
    const bounds =
      b &&
      Object.values({ left: b.left, top: b.top, right: b.right, bottom: b.bottom }).every(
        Number.isFinite,
      )
        ? {
            left: Math.max(0, b.left),
            top: Math.max(0, b.top),
            right: Math.min(screen.width, b.right),
            bottom: Math.min(screen.height, b.bottom),
          }
        : null;
    if (
      node.isVisibleToUser !== false &&
      bounds &&
      bounds.right > bounds.left &&
      bounds.bottom > bounds.top
    ) {
      const password = node.isPassword === true;
      const text = password ? '[password]' : node.text || '';
      const label = password ? '' : node.contentDescription || '';
      const editable =
        node.isEditable === true ||
        [
          'android.widget.EditText',
          'android.widget.AutoCompleteTextView',
          'android.widget.MultiAutoCompleteTextView',
        ].includes(node.className);
      if (text || label || node.isClickable || editable || node.isScrollable) {
        elements.push({
          id: path,
          text,
          label,
          resourceId: node.resourceId || '',
          hint: node.hint || '',
          bounds,
          clickable: node.isClickable === true,
          editable,
          scrollable: node.isScrollable === true,
          enabled: node.isEnabled !== false,
          focused: node.isFocused === true,
          password,
          checkable: node.isCheckable === true,
          checked: node.isChecked === true,
          selected: node.isSelected === true,
        });
      }
    }
    if (Array.isArray(node.children))
      node.children.forEach((child, i) => visit(child, `${path}.${i}`));
  };
  visit(raw.a11y_tree, 'ui');
  const inputs = elements.filter((e) => e.editable && e.enabled);
  const focusedInputs = inputs.filter((e) => e.focused);
  const input =
    focusedInputs.length === 1
      ? focusedInputs[0]
      : raw.phone_state.keyboardVisible && inputs.length === 1
        ? inputs[0]
        : undefined;
  const phone = {
    packageName: raw.phone_state.packageName || '',
    currentApp: raw.phone_state.currentApp || '',
    isEditable: raw.phone_state.isEditable === true || Boolean(input),
    inputElementId: input?.id,
    focusEvidence: raw.phone_state.isEditable
      ? 'reported'
      : input?.focused
        ? 'focused-node'
        : input
          ? 'single-input-with-keyboard'
          : 'none',
    keyboardVisible: raw.phone_state.keyboardVisible === true,
    focusedElement: {
      resourceId: raw.phone_state.focusedElement?.resourceId || '',
      className: raw.phone_state.focusedElement?.className || '',
    },
  };
  const content = { deviceId, phone, screen, elements };
  return {
    ...content,
    fingerprint: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    observedAt: Date.now(),
  };
}

export class MobilerunDevice {
  constructor({
    apiKey = process.env.MOBILERUN_API_KEY || process.env.MOBILERUN_CLOUD_API_KEY,
    deviceId = process.env.MOBILERUN_DEVICE_ID,
    baseUrl = process.env.MOBILERUN_BASE_URL || 'https://api.mobilerun.ai/v1',
    textCompletionMode = process.env.MOBILERUN_TEXT_COMPLETION_MODE || 'accepted',
    request = curlRequest,
  } = {}) {
    this.apiKey = apiKey;
    this.deviceId = deviceId;
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('MOBILERUN_BASE_URL must be an HTTPS API base URL.');
    this.baseUrl = url.href.replace(/\/$/, '');
    this.request = request;
    if (!['accepted', 'committed'].includes(textCompletionMode))
      throw new Error('Text completion mode must be accepted or committed.');
    this.textCompletionMode = textCompletionMode;
    this.readyAt = -Infinity;
    this.installedApps = [];
  }

  async api(path, method = 'GET', body, binary = false) {
    const bytes = await this.request({
      url: `${this.baseUrl}${path}`,
      apiKey: this.apiKey,
      method,
      body,
    });
    return binary ? bytes : decodeJson(bytes);
  }

  path(suffix = '') {
    if (!this.deviceId)
      throw new Error('Set MOBILERUN_DEVICE_ID or pass --device. Use devices to list IDs.');
    return `/devices/${encodeURIComponent(this.deviceId)}${suffix}`;
  }

  async listDevices() {
    const devices = [];
    for (let page = 1; page <= 1000; page++) {
      const result = await this.api(`/devices?page=${page}&pageSize=100`);
      if (!Array.isArray(result?.items)) throw new Error('Invalid device list response.');
      devices.push(...result.items.map(({ id, name, state }) => ({ id, name, state })));
      if (result.items.length < 100) return devices;
    }
    throw new Error('Device pagination exceeded 1000 pages.');
  }

  async listApps() {
    const result = await this.api(this.path('/apps?includeSystemApps=true'));
    if (!Array.isArray(result)) throw new Error('Invalid installed-app response.');
    this.installedApps = result
      .filter((app) => typeof app.packageName === 'string' && typeof app.label === 'string')
      .map(({ packageName, label }) => ({ packageName, label }));
    return this.installedApps;
  }

  async assertReady() {
    const device = await this.api(this.path());
    if (device?.state !== 'ready')
      throw new Error(`Device is ${device?.state || 'unknown'}; it must be ready.`);
    this.readyAt = performance.now();
    return { id: device.id, name: device.name, state: device.state };
  }

  async observe() {
    // Keep noninteractive text: it is evidence for goal completion and control labels.
    return summarizeState(await this.api(this.path('/ui-state?filter=false')), this.deviceId);
  }

  async screenshot() {
    const bytes = await this.api(this.path('/screenshot?hideOverlay=true'), 'GET', undefined, true);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('Screenshot response is not a PNG.');
    return bytes;
  }

  async act(action, { expected, maxAgeMs = 30_000 } = {}) {
    if (!action || typeof action !== 'object') throw new Error('An action object is required.');
    if (performance.now() - this.readyAt > 30_000) await this.assertReady();
    if (action.type === 'open-app') {
      if (!this.installedApps.some((app) => app.packageName === action.packageName))
        throw new Error('The app was not observed in the installed-app list.');
      if (expected && expected.deviceId !== this.deviceId)
        throw new Error('Observation belongs to a different device.');
      await this.api(this.path(`/apps/${encodeURIComponent(action.packageName)}`), 'PUT', {});
      return;
    }
    const current = await this.observe();
    if (expected) assertFresh(current, expected, action, maxAgeMs);
    const point = (x, y) => {
      integer(x, 'x');
      integer(y, 'y');
      if (x >= current.screen.width || y >= current.screen.height)
        throw new Error('Coordinates are outside the screen.');
    };
    let suffix,
      method = 'POST',
      body,
      inputVerification;
    switch (action.type) {
      case 'tap':
        point(action.x, action.y);
        suffix = '/tap';
        body = { x: action.x, y: action.y };
        break;
      case 'tap-element': {
        if (!expected) throw new Error('Element taps require their original observation.');
        const node = current.elements.find((entry) => entry.id === action.elementId);
        if (!node?.enabled || !(node.clickable || node.editable))
          throw new Error('Element is not actionable.');
        const { left, top, right, bottom } = node.bounds;
        suffix = '/tap';
        body = { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
        break;
      }
      case 'swipe':
        point(action.startX, action.startY);
        point(action.endX, action.endY);
        integer(action.duration ?? 300, 'duration', 10);
        suffix = '/swipe';
        body = {
          startX: action.startX,
          startY: action.startY,
          endX: action.endX,
          endY: action.endY,
          duration: action.duration ?? 300,
        };
        if (action.regionId && expected) {
          const before = expected.elements.find((e) => e.id === action.regionId).bounds;
          const after = current.elements.find((e) => e.id === action.regionId).bounds;
          // Resolve the same relative gesture in current geometry (e.g. a collapsing toolbar).
          const project = (value, oldStart, oldEnd, newStart, newEnd) => {
            const fraction = (value - oldStart) / (oldEnd - oldStart);
            if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
              throw new Error('Swipe leaves its observed region.');
            return Math.floor(newStart + fraction * (newEnd - newStart));
          };
          body.startX = project(action.startX, before.left, before.right, after.left, after.right);
          body.endX = project(action.endX, before.left, before.right, after.left, after.right);
          body.startY = project(action.startY, before.top, before.bottom, after.top, after.bottom);
          body.endY = project(action.endY, before.top, before.bottom, after.top, after.bottom);
          point(body.startX, body.startY);
          point(body.endX, body.endY);
        }
        break;
      case 'type':
        if (!current.phone.isEditable) throw new Error('Focus an editable field before typing.');
        if (
          typeof action.text !== 'string' ||
          (action.clear !== undefined && typeof action.clear !== 'boolean')
        )
          throw new Error('Text must be a string and clear must be boolean.');
        suffix = '/keyboard';
        inputVerification =
          this.textCompletionMode === 'accepted' ? prepareInputVerification(current, action) : null;
        body = {
          text: action.text,
          clear: action.clear ?? false,
          completionMode: inputVerification ? 'accepted' : 'committed',
        };
        break;
      case 'clear':
        if (!current.phone.isEditable) throw new Error('Focus an editable field before clearing.');
        suffix = '/keyboard';
        method = 'DELETE';
        break;
      case 'key':
        if (!Object.hasOwn(KEYS, action.key)) throw new Error('Unsupported keyboard key.');
        suffix = '/keyboard';
        method = 'PUT';
        body = { key: KEYS[action.key] };
        break;
      case 'global':
        if (!Object.hasOwn(GLOBAL_ACTIONS, action.name))
          throw new Error('Unsupported global action.');
        suffix = '/global';
        body = { action: GLOBAL_ACTIONS[action.name] };
        break;
      default:
        throw new Error('Unsupported action type.');
    }
    await this.api(this.path(suffix), method, body);
    return inputVerification ? { inputVerification } : undefined;
  }
}

// ---------------------------------------------------------------------------
// Local adb transport: same contract as MobilerunDevice, no cloud dependency.
// Decision loop, candidate discovery, and validation are unchanged; only the
// transport differs (uiautomator dump / input / screencap instead of REST).
// ---------------------------------------------------------------------------
// Mobilerun's GLOBAL_ACTIONS values (1/2/3) are cloud API enums; adb needs the
// real Android keycodes instead.
const ADB_GLOBAL_ACTIONS = { back: KEYCODE.back, home: KEYCODE.home, recent: KEYCODE.recent };

export class AdbDevice {
  constructor({
    deviceId = process.env.ANDROID_SERIAL || process.env.MOBILERUN_DEVICE_ID,
    textCompletionMode = process.env.MOBILERUN_TEXT_COMPLETION_MODE || 'accepted',
    run = runAdb,
  } = {}) {
    this.deviceId = deviceId || undefined;
    this.run = run;
    if (!['accepted', 'committed'].includes(textCompletionMode))
      throw new Error('Text completion mode must be accepted or committed.');
    this.textCompletionMode = textCompletionMode;
    this.readyAt = -Infinity;
    this.installedApps = [];
    this.baseUrl = 'adb:local';
  }

  // One execFile per call: arguments never pass through a host shell. `adb shell`
  // joins the words and the on-device shell parses them, which is where quoting
  // matters (see quoteForDeviceShell).
  adb(suffix, { binary = false, timeoutMs = 20_000 } = {}) {
    const args = this.deviceId ? ['-s', this.deviceId, ...suffix] : [...suffix];
    return this.run(args, { binary, timeoutMs });
  }

  async shell(suffix, { timeoutMs } = {}) {
    const bytes = await this.adb(['shell', ...suffix], { timeoutMs });
    return bytes.toString('utf8');
  }

  async listDevices() {
    const output = await this.adb(['devices', '-l']);
    return parseDeviceList(output.toString('utf8'));
  }

  async assertReady() {
    const devices = await this.listDevices();
    if (this.deviceId) {
      const found = devices.find((device) => device.id === this.deviceId);
      if (!found) throw new Error(`Device ${this.deviceId} is not connected via adb.`);
      if (found.state !== 'ready')
        throw new Error(
          `Device is ${found.state}; authorize USB debugging or wait for boot to finish.`,
        );
    } else {
      const ready = devices.filter((device) => device.state === 'ready');
      if (ready.length > 1)
        throw new Error(
          `Multiple devices are connected (${ready.map((d) => d.id).join(', ')}); set ANDROID_SERIAL.`,
        );
      if (ready.length === 1) this.deviceId = ready[0].id;
      else throw new Error('No ready adb device is connected. Connect and authorize one device.');
    }
    this.readyAt = performance.now();
    const name = devices.find((d) => d.id === this.deviceId)?.name || this.deviceId || 'device';
    return { id: this.deviceId || 'local', name, state: 'ready' };
  }

  async listApps() {
    const output = await this.shell(['pm', 'list', 'packages'], { timeoutMs: 30_000 });
    this.installedApps = output
      .split('\n')
      .map((line) =>
        line
          .replace(/^package:/, '')
          .replace(/\r$/, '')
          .trim(),
      )
      .filter((pkg) => /^(\w+\.)+\w+$/.test(pkg))
      .map((packageName) => ({ packageName, label: labelFromPackage(packageName) }))
      .sort((a, b) => a.packageName.localeCompare(b.packageName));
    return this.installedApps;
  }

  async currentPackage() {
    // One `dumpsys window` call covers both focus and (on many builds) keyboard
    // state; input_method covers the rest. `window windows` does not exist on
    // some builds (Pixel 3 / Android 12 returns empty).
    const [focus, activity, inputMethod] = await Promise.all([
      this.shell(['dumpsys', 'window'], { timeoutMs: 15_000 }).catch(() => ''),
      this.shell(['dumpsys', 'activity', 'activities'], { timeoutMs: 15_000 }).catch(() => ''),
      this.shell(['dumpsys', 'input_method'], { timeoutMs: 15_000 }).catch(() => ''),
    ]);
    return {
      packageName: parseCurrentFocus(focus) || parseResumedActivity(activity),
      keyboardVisible: parseInputShown(inputMethod) || parseInputShown(focus),
    };
  }

  // `uiautomator dump /dev/tty` drops its XML on some devices (no controlling
  // terminal), so use the standard file round trip. Retries absorb transient
  // "could not get idle state" failures on animated screens; the final failure
  // surfaces as stale so the agent re-observes instead of aborting the run.
  async dumpHierarchy({ attempts = 2 } = {}) {
    const path = '/sdcard/window_dump.xml';
    let lastNotice = 'no dump attempt was made';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.shell(['rm', '-f', path]).catch(() => {});
      const notice = await this.shell(['uiautomator', 'dump']).catch((error) => error.message);
      lastNotice = String(notice);
      if (/dumped to/i.test(lastNotice)) {
        const xml = (
          await this.adb(['exec-out', 'cat', path], { timeoutMs: 15_000 }).catch(() =>
            Buffer.alloc(0),
          )
        ).toString('utf8');
        if (xml.includes('<hierarchy')) return xml;
        lastNotice = 'dump file had no hierarchy';
      }
      if (attempt < attempts) await delay(250);
    }
    throw new StaleObservationError(
      `uiautomator could not read the screen (${lastNotice.slice(0, 120)}); the screen may be animated. Observe again.`,
    );
  }

  async observe() {
    // Observation is strictly read-only. A failed hierarchy dump must never
    // navigate away from a screen or discard user state.
    return this.readObservation();
  }

  async readObservation() {
    const [dump, context, facts] = await Promise.all([
      this.dumpHierarchy(),
      this.currentPackage(),
      this.deviceFacts(),
    ]);
    const observation = summarizeState(
      stateFromDump(dump, {
        packageName: context.packageName,
        keyboardVisible: context.keyboardVisible,
      }),
      this.deviceId || 'local',
    );
    return { ...observation, facts };
  }

  // Device-reported ground truth. Some screens render
  // this information with never-idling animations that make uiautomator dumps
  // impossible; facts let goals about such values complete from device reports
  // instead of an unreadable rendering of the same data. The policy prompt
  // receives them with every observation.
  async deviceFacts() {
    if (this.facts && performance.now() - this.factsAt < 30_000) return this.facts;
    const output = await this.shell(
      [
        'getprop',
        'ro.build.version.release',
        'ro.build.version.sdk',
        'ro.build.version.security_patch',
        'ro.build.type',
      ],
      { timeoutMs: 10_000 },
    ).catch(() => '');
    const [release, sdk, securityPatch, type] = output
      .split('\n')
      .map((line) => line.replace(/\r$/, '').trim());
    this.facts = {
      androidVersion: release || undefined,
      apiLevel: Number(sdk) || undefined,
      securityPatch: securityPatch || undefined,
      buildType: type || undefined,
      source: 'device-reported (getprop)',
    };
    this.factsAt = performance.now();
    return this.facts;
  }

  async screenshot() {
    const bytes = await this.adb(['exec-out', 'screencap', '-p'], { binary: true });
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC))
      throw new Error('Screenshot response is not a PNG.');
    return bytes;
  }

  // Observe immediately before every dispatch, mirroring Mobilerun's server-side
  // pre-action observation, so stale decisions are rejected before any input.
  async act(action, { expected, maxAgeMs = 30_000 } = {}) {
    if (!action || typeof action !== 'object') throw new Error('An action object is required.');
    if (performance.now() - this.readyAt > 30_000) await this.assertReady();
    if (action.type === 'open-app') {
      if (!this.installedApps.some((app) => app.packageName === action.packageName))
        throw new Error('The app was not observed in the installed-app list.');
      if (expected && expected.deviceId !== this.deviceId)
        throw new Error('Observation belongs to a different device.');
      await this.shell([
        'monkey',
        '-p',
        action.packageName,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ]);
      return;
    }
    const current = await this.observe();
    if (expected) assertFresh(current, expected, action, maxAgeMs);
    const point = (x, y) => {
      integer(x, 'x');
      integer(y, 'y');
      if (x >= current.screen.width || y >= current.screen.height)
        throw new Error('Coordinates are outside the screen.');
    };
    let inputVerification;
    switch (action.type) {
      case 'tap': {
        point(action.x, action.y);
        await this.shell(['input', 'tap', String(action.x), String(action.y)]);
        break;
      }
      case 'tap-element': {
        if (!expected) throw new Error('Element taps require their original observation.');
        const node = current.elements.find((entry) => entry.id === action.elementId);
        if (!node?.enabled || !(node.clickable || node.editable))
          throw new Error('Element is not actionable.');
        const { left, top, right, bottom } = node.bounds;
        const x = Math.floor((left + right) / 2),
          y = Math.floor((top + bottom) / 2);
        point(x, y);
        await this.shell(['input', 'tap', String(x), String(y)]);
        break;
      }
      case 'swipe':
        point(action.startX, action.startY);
        point(action.endX, action.endY);
        integer(action.duration ?? 300, 'duration', 10);
        if (action.regionId && expected) {
          const before = expected.elements.find((e) => e.id === action.regionId).bounds;
          const after = current.elements.find((e) => e.id === action.regionId).bounds;
          // Resolve the same relative gesture in current geometry (e.g. a collapsing toolbar).
          const project = (value, oldStart, oldEnd, newStart, newEnd) => {
            const fraction = (value - oldStart) / (oldEnd - oldStart);
            if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
              throw new Error('Swipe leaves its observed region.');
            return Math.floor(newStart + fraction * (newEnd - newStart));
          };
          action = {
            ...action,
            startX: project(action.startX, before.left, before.right, after.left, after.right),
            endX: project(action.endX, before.left, before.right, after.left, after.right),
            startY: project(action.startY, before.top, before.bottom, after.top, after.bottom),
            endY: project(action.endY, before.top, before.bottom, after.top, after.bottom),
          };
          point(action.startX, action.startY);
          point(action.endX, action.endY);
        }
        await this.shell([
          'input',
          'swipe',
          String(action.startX),
          String(action.startY),
          String(action.endX),
          String(action.endY),
          String(action.duration ?? 300),
        ]);
        break;
      case 'type': {
        if (!current.phone.isEditable) throw new Error('Focus an editable field before typing.');
        if (
          typeof action.text !== 'string' ||
          !action.text.length ||
          (action.clear !== undefined && typeof action.clear !== 'boolean')
        )
          throw new Error('Text must be a nonempty string and clear must be boolean.');
        inputVerification =
          this.textCompletionMode === 'accepted' ? prepareInputVerification(current, action) : null;
        const adbKeyboard = await this.ensureAdbKeyboard(!isAsciiTransmittable(action.text));
        if (action.clear) await this.clearFocusedField(adbKeyboard);
        if (adbKeyboard) {
          await this.broadcastAdbKeyboard('ADB_INPUT_TEXT', action.text);
        } else {
          for (const segment of typeSegments(action.text))
            await this.shell(['input', 'text', segment]);
        }
        break;
      }
      case 'clear': {
        if (!current.phone.isEditable) throw new Error('Focus an editable field before clearing.');
        await this.clearFocusedField(await this.ensureAdbKeyboard(true));
        break;
      }
      case 'key': {
        if (!Object.hasOwn(KEYS, action.key)) throw new Error('Unsupported keyboard key.');
        await this.pressKey(action.key);
        break;
      }
      case 'global': {
        if (!Object.hasOwn(ADB_GLOBAL_ACTIONS, action.name))
          throw new Error('Unsupported global action.');
        await this.shell(['input', 'keyevent', String(ADB_GLOBAL_ACTIONS[action.name])]);
        break;
      }
      default:
        throw new Error('Unsupported action type.');
    }
    return inputVerification ? { inputVerification } : undefined;
  }

  async pressKey(key) {
    // KEYS already holds Android keycodes; one keyevent per named key.
    return this.shell(['input', 'keyevent', String(KEYS[key])]);
  }

  // Decide the input channel once per action. ADBKeyBoard must be active for
  // non-ASCII text; ASCII rides `input text` unless ADBKeyBoard is already the
  // active IME, because its key events land as letters (select-all once typed
  // a literal "a" instead of clearing a field). Once installed, the agent
  // enables and selects it on demand.
  async ensureAdbKeyboard(required) {
    const ime = 'com.android.adbkeyboard/.AdbIME';
    let enabled = await this.shell(['ime', 'list', '-s'], { timeoutMs: 10_000 }).catch(() => '');
    if (!/adbkeyboard/i.test(enabled)) {
      if (!required) return false;
      const installed = await this.shell(['pm', 'path', 'com.android.adbkeyboard'], {
        timeoutMs: 10_000,
      }).catch(() => '');
      if (!installed.trim())
        throw new Error(
          'Text contains non-ASCII characters, but ADBKeyBoard is not installed. Install ADBKeyboard.apk, then retry.',
        );
      await this.shell(['ime', 'enable', ime]);
      enabled = await this.shell(['ime', 'list', '-s'], { timeoutMs: 10_000 });
      if (!/adbkeyboard/i.test(enabled))
        throw new Error(
          'ADBKeyBoard could not be enabled. Enable it in Android Settings, then retry.',
        );
    }
    const active = await this.shell(['settings', 'get', 'secure', 'default_input_method'], {
      timeoutMs: 10_000,
    }).catch(() => '');
    if (/adbkeyboard/i.test(active)) return true;
    if (required) {
      await this.shell(['ime', 'set', ime]);
      return true;
    }
    return false;
  }

  async broadcastAdbKeyboard(action, message) {
    await this.shell([
      'am',
      'broadcast',
      '-a',
      action,
      '--es',
      'msg',
      quoteForDeviceShell(message),
    ]);
  }

  // Cloud 'clear' empties the whole field: select-all then delete on the ASCII
  // path, ADBKeyBoard's ADB_CLEAR_TEXT broadcast when its IME is active (its key
  // synthesis proved unreliable for editing commands). Falls back to MOVE_END
  // plus backspaces when keycombination is unavailable.
  async clearFocusedField(adbKeyboard = false) {
    if (adbKeyboard) {
      await this.broadcastAdbKeyboard('ADB_CLEAR_TEXT', '');
      return;
    }
    try {
      await this.shell(['input', 'keycombination', String(KEYCODE.ctrlLeft), String(KEYCODE.a)]);
      await this.shell(['input', 'keyevent', String(KEYCODE.del)]);
    } catch {
      await this.shell(['input', 'keyevent', String(KEYCODE.moveEnd)]);
      const observed = await this.observe();
      const input = observed.elements.find((e) => e.id === observed.phone.inputElementId);
      const length = Math.max((input?.text || '').length, 40);
      for (let i = 0; i < length; i++) await this.shell(['input', 'keyevent', String(KEYCODE.del)]);
    }
  }
}
