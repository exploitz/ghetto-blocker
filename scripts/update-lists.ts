import { rm } from 'node:fs/promises';
import { config } from '../src/config';

/** Drop the cached engines so the next start re-downloads fresh filter lists. */
await rm(config.enginePath, { force: true });
await rm(config.privacyEnginePath, { force: true });
console.log(`Removed ${config.enginePath} and ${config.privacyEnginePath}. Next 'npm start' will re-download filter lists.`);
