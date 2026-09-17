import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Play history is kept for 12 months (Grilled.md compliance constraints).
crons.daily('prune old plays', { hourUTC: 4, minuteUTC: 0 }, internal.plays.prune, {});

export default crons;
