// SPDX-License-Identifier: GPL-2.0-or-later

/* Litra HID++ codec. No GNOME imports, so tools/selftest.mjs runs it in node.
 *
 * Messages are 20-byte HID++ 2.0 long reports: [0x11, 0xff, feature, function,
 * payload...]. The byte values follow timrogers/litra-rs. A software id of 0
 * (low nibble of `function`) marks a notification, e.g. a button press.
 */

export const VENDOR_ID = 0x046d;
export const USAGE_PAGE = 0xff43;
export const REPORT_ID = 0x11;
export const REPORT_SIZE = 20;

const DEVICE_INDEX = 0xff;
const ERROR_FEATURE = 0xff;     // feature byte of an HID++ error reply

export const MIN_KELVIN = 2700;
export const MAX_KELVIN = 6500;
export const KELVIN_STEP = 100;

export const GET_ON = 0x01;
export const SET_ON = 0x1c;
export const GET_BRIGHTNESS = 0x31;
export const SET_BRIGHTNESS = 0x4c;
export const GET_TEMPERATURE = 0x81;
export const SET_TEMPERATURE = 0x9c;

const GLOW = {name: 'Litra Glow', feature: 0x04, minLumen: 20, maxLumen: 250};
const BEAM = {name: 'Litra Beam', feature: 0x04, minLumen: 30, maxLumen: 400};
const BEAM_LX = {name: 'Litra Beam LX', feature: 0x06, minLumen: 30, maxLumen: 400};

/** USB product id → model. Keep in sync with udev/60-litra.rules. */
export const MODELS = new Map([
    [0xc900, GLOW],
    [0xc901, BEAM],
    [0xb901, BEAM],
    [0xc903, BEAM_LX],
]);

/** A request report, zero-padded to 20 bytes. */
export function buildReport(feature, fn, payload = []) {
    const report = new Uint8Array(REPORT_SIZE);
    report.set([REPORT_ID, DEVICE_INDEX, feature, fn, ...payload]);
    return report;
}

function u16(value) {
    return [(value >> 8) & 0xff, value & 0xff];
}

export function setOnReport(model, on) {
    return buildReport(model.feature, SET_ON, [on ? 1 : 0]);
}

export function setBrightnessReport(model, lumen) {
    if (!Number.isInteger(lumen) || lumen < model.minLumen || lumen > model.maxLumen)
        throw new RangeError(`brightness ${lumen} lm is outside ${model.minLumen}–${model.maxLumen}`);
    return buildReport(model.feature, SET_BRIGHTNESS, u16(lumen));
}

export function setTemperatureReport(model, kelvin) {
    if (!Number.isInteger(kelvin) || kelvin < MIN_KELVIN || kelvin > MAX_KELVIN ||
        kelvin % KELVIN_STEP !== 0)
        throw new RangeError(`temperature ${kelvin} K is not a multiple of ${KELVIN_STEP} in ${MIN_KELVIN}–${MAX_KELVIN}`);
    return buildReport(model.feature, SET_TEMPERATURE, u16(kelvin));
}

/* Classify an incoming report: {kind: 'reply'|'event', feature, fn, payload},
 * {kind: 'error', feature, fn, code}, or null if it is not an HID++ long report. */
export function parseReport(data) {
    if (data.length < 5 || data[0] !== REPORT_ID || data[1] !== DEVICE_INDEX)
        return null;

    if (data[2] === ERROR_FEATURE)
        return {kind: 'error', feature: data[3], fn: data[4], code: data[5] ?? 0};

    return {
        kind: (data[3] & 0x0f) === 0 ? 'event' : 'reply',
        feature: data[2],
        fn: data[3],
        payload: data.subarray(4),
    };
}

/** Big-endian u16 at the start of a payload (lumen, kelvin). */
export function readU16(payload) {
    return (payload[0] << 8) | payload[1];
}

/** On/off flag at the start of a payload. */
export function readOn(payload) {
    return payload[0] === 1;
}
