import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateUploadLimit, MiB, parseRange, targetSize } from "../clipShrink.desktop/clip.ts";

test("parses hours, minutes, fractional seconds, and open-ended ranges", () => {
    assert.deepEqual(parseRange("00:15:13 - 00:17:22", 1200), { start: 913, end: 1042, duration: 129 });
    assert.deepEqual(parseRange("15:13–15:15", 1200), { start: 913, end: 915, duration: 2 });
    assert.deepEqual(parseRange("1.250 -", 4), { start: 1.25, end: null, duration: 2.75 });
    assert.deepEqual(parseRange("- 4", 4), { start: 0, end: 4, duration: 4 });
    assert.deepEqual(parseRange(" ", 4), { start: 0, end: null, duration: 4 });
});

test("rejects invalid, zero-length, or out-of-bounds trim ranges", () => {
    for (const range of ["1", "-", "a-2", "1--2", "0:60-2:00", "2-2", "3-2", "1-5", "4-", "1e0-2"])
        assert.throws(() => parseRange(range, 4), Error, range);
});

test("uses the live account limit when valid and accounts for server perks", () => {
    assert.equal(estimateUploadLimit(), 20 * MiB);
    assert.equal(estimateUploadLimit(3), 50 * MiB);
    assert.equal(estimateUploadLimit(2), 1024 * MiB);
    assert.equal(estimateUploadLimit(0, 2), 50 * MiB);
    assert.equal(estimateUploadLimit(3, 3), 100 * MiB);
    assert.equal(estimateUploadLimit(2, 2, 500 * MiB), 500 * MiB);
    assert.equal(estimateUploadLimit(3, 0, NaN), 50 * MiB);
});

test("reserves size headroom and never raises the automatic limit", () => {
    assert.equal(targetSize(20 * MiB, 0), Math.floor(19.6 * MiB));
    assert.equal(targetSize(20 * MiB, 50), targetSize(20 * MiB, 0));
    assert.equal(targetSize(50 * MiB, 10), Math.floor(9.8 * MiB));
    for (const cap of [0.5, -1, 1025, NaN, Infinity]) assert.throws(() => targetSize(20 * MiB, cap));
});
