/*
 * ClipShrink, a Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MiB = 1024 ** 2;
export const maxUploadBytes = 1024 * MiB;
export const chunkBytes = 8 * MiB;

function parseTimestamp(timestamp: string): number {
    const parts = timestamp.trim().split(":");
    const seconds = parts.pop()!;
    if (parts.length > 2 || !/^\d+(?:\.\d{1,3})?$/.test(seconds) || parts.some(part => !/^\d+$/.test(part)))
        throw new Error("Use seconds, MM:SS, or HH:MM:SS (for example, 15.5 or 00:15:13).");

    const values = [...parts.map(Number), Number(seconds)];
    if (values.slice(1).some(value => value >= 60))
        throw new Error("Use values below 60 after each colon.");

    return values.reduce((total, value) => total * 60 + value, 0);
}

export function resolveTrim(start: number, end: number | null, duration: number) {
    if (!Number.isFinite(start) || start < 0 || start >= duration)
        throw new Error("The start time must be before the end of the video.");
    end ??= duration;
    if (!Number.isFinite(end) || end > duration || end <= start)
        throw new Error("The end time must be after the start and within the video.");
    return { start, duration: end - start, isTrimmed: start !== 0 || end !== duration };
}

export function parseRange(value: string, duration: number) {
    const parts = value.trim() ? value.split(/[-–—]/) : ["", ""];
    if (parts.length !== 2 || (value.trim() && parts.every(part => !part.trim())))
        throw new Error("Enter a range such as 00:15:13 - 00:15:15, or leave it blank.");

    const start = parts[0].trim() ? parseTimestamp(parts[0]) : 0;
    const end = parts[1].trim() ? parseTimestamp(parts[1]) : null;
    if (end != null && !Number.isFinite(end)) throw new Error("The end time is too large.");
    return { start, end, duration: resolveTrim(start, end, duration).duration };
}

export function estimateUploadLimit(premiumType?: number | null, boostTier?: number, clientAccountLimit?: number) {
    const accountLimit = clientAccountLimit != null && Number.isSafeInteger(clientAccountLimit) && clientAccountLimit >= MiB && clientAccountLimit <= maxUploadBytes
        ? clientAccountLimit
        : (premiumType === 2 ? 1024 : premiumType === 1 || premiumType === 3 ? 50 : 20) * MiB;
    const serverLimit = (boostTier === 3 ? 100 : boostTier === 2 ? 50 : 0) * MiB;
    return Math.max(accountLimit, serverLimit);
}

export function targetSize(limit: number, manualLimitMiB: number) {
    if (!Number.isFinite(manualLimitMiB) || manualLimitMiB < 0 || manualLimitMiB > 1024)
        throw new Error("Set the optional size cap to a value from 0 to 1024 MiB in ClipShrink settings.");
    const cap = manualLimitMiB === 0 ? limit : Math.min(limit, Math.floor(manualLimitMiB * MiB));
    if (cap < MiB) throw new Error("Set the optional size cap to at least 1 MiB, or use 0 for automatic.");
    return Math.floor(cap * 0.98);
}
