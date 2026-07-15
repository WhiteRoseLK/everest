import { loadConfig } from './config.js';
import { runLoop } from './loop.js';

const config = loadConfig();
const cwd = process.cwd();

runLoop(config, cwd).catch((error) => {
  console.error(error);
  process.exit(1);
});
