// SPDX-License-Identifier: GPL-2.0-or-later
//
// Protocol tests: the reports protocol.js builds must be byte-for-byte the ones
// timrogers/litra-rs v3.3.0 sends (src/lib.rs), since that is what the lights
// are known to accept. Run with `node tools/selftest.mjs` (or `make check`).

import * as P from '../src/litra@soylu.me/protocol.js';

let failed = 0;
function eq(name, got, want) {
    const g = JSON.stringify(Array.from(got ?? []));
    const w = JSON.stringify(Array.from(want));
    if (g === w) {
        console.log(`ok   ${name}`);
    } else {
        failed++;
        console.log(`FAIL ${name}\n     got  ${g}\n     want ${w}`);
    }
}
function throws(name, fn) {
    try {
        fn();
        failed++;
        console.log(`FAIL ${name}: did not throw`);
    } catch {
        console.log(`ok   ${name}`);
    }
}
const pad = head => [...head, ...new Array(20 - head.length).fill(0)];

const glow = P.MODELS.get(0xc900);
const beamLx = P.MODELS.get(0xc903);

eq('glow get on', P.buildReport(glow.feature, P.GET_ON), pad([0x11, 0xff, 0x04, 0x01]));
eq('glow get brightness', P.buildReport(glow.feature, P.GET_BRIGHTNESS), pad([0x11, 0xff, 0x04, 0x31]));
eq('glow get temperature', P.buildReport(glow.feature, P.GET_TEMPERATURE), pad([0x11, 0xff, 0x04, 0x81]));
eq('glow on', P.setOnReport(glow, true), pad([0x11, 0xff, 0x04, 0x1c, 0x01]));
eq('glow off', P.setOnReport(glow, false), pad([0x11, 0xff, 0x04, 0x1c, 0x00]));
eq('glow 250 lm', P.setBrightnessReport(glow, 250), pad([0x11, 0xff, 0x04, 0x4c, 0x00, 0xfa]));
eq('glow 6500 K', P.setTemperatureReport(glow, 6500), pad([0x11, 0xff, 0x04, 0x9c, 0x19, 0x64]));
eq('beam lx 400 lm', P.setBrightnessReport(beamLx, 400), pad([0x11, 0xff, 0x06, 0x4c, 0x01, 0x90]));
eq('beam lx get on', P.buildReport(beamLx.feature, P.GET_ON), pad([0x11, 0xff, 0x06, 0x01]));

throws('glow 251 lm rejected', () => P.setBrightnessReport(glow, 251));
throws('glow 19 lm rejected', () => P.setBrightnessReport(glow, 19));
throws('4050 K rejected', () => P.setTemperatureReport(glow, 4050));
throws('7000 K rejected', () => P.setTemperatureReport(glow, 7000));

const reply = P.parseReport(Uint8Array.from(pad([0x11, 0xff, 0x04, 0x31, 0x00, 0xa7])));
eq('reply kind/feature/fn', [reply.kind === 'reply', reply.feature, reply.fn], [true, 0x04, 0x31]);
eq('reply lumen', [P.readU16(reply.payload)], [167]);
const onReply = P.parseReport(Uint8Array.from(pad([0x11, 0xff, 0x04, 0x01, 0x01])));
eq('reply on', [P.readOn(onReply.payload)], [true]);
const event = P.parseReport(Uint8Array.from(pad([0x11, 0xff, 0x04, 0x10, 0x00, 0x50])));
eq('event kind', [event.kind === 'event'], [true]);
const err = P.parseReport(Uint8Array.from(pad([0x11, 0xff, 0xff, 0x04, 0x31, 0x05])));
eq('error kind/fn/code', [err.kind === 'error', err.feature, err.fn, err.code], [true, 0x04, 0x31, 0x05]);
eq('foreign report ignored', [P.parseReport(Uint8Array.from([0x10, 0xff, 0x04, 0x31, 0]))], [null]);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
