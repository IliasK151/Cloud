import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Is this module the script node was started with? Compares file paths, not URLs, so it holds
// on Windows too (C:\…\scripts\x.js against file:///C:/…/scripts/x.js).
export const isMain = (metaUrl, argv1 = process.argv[1]) => !!argv1 && path.resolve(argv1) === fileURLToPath(metaUrl);
