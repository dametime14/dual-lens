import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller.mjs';
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
try {
  const controller = new Controller(process.argv[2] || join(homedir(), 'Library/Application Support/Dual Lens'), emit);
  const lines = createInterface({input:process.stdin, terminal:false});
  lines.on('line', async line => {
    try { await controller.dispatch(JSON.parse(line)); }
    catch (error) { emit({type:'error', message:error.message}); }
  });
  const stop = () => { controller.active?.abort.abort(); controller.checkAbort?.abort(); setTimeout(() => process.exit(0), 1500).unref(); };
  lines.on('close', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch (error) { emit({type:'error', message:error.message}); process.exitCode = 1; }
