import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Play history (website plays and app play events) is kept for 12 months (Grilled.md compliance constraints).
// Wear reads cumulative entitlements.wearStats, so pruning never lowers it.
crons.daily('prune old plays', { hourUTC: 4, minuteUTC: 0 }, internal.plays.prune, {});

// DROP-7: releases go live at `dropAt` (server time), checked every minute.
crons.interval('flip due drops', { minutes: 1 }, internal.app.flipDueDrops, {});

// LEND-7: lends past their deadline move to their terminal state (every call also enforces it on read), and the
// borrower's 24 hour reminder is recorded (LEND-11).
crons.interval('settle due lends', { minutes: 15 }, internal.lends.settleDue, {});

export default crons;
