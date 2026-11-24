import { stalePrices } from './pricing';

const stale = stalePrices();
if (stale.length) {
  console.log(`${stale.length} price entries are older than 30 days. Re-check them at their source:`);
  for (const s of stale) console.log('  - ' + s);
  process.exitCode = 1;
} else console.log('All price entries were checked in the last 30 days.');
