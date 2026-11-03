import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from './service.mjs';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/**
 * Start the shared WebUI HTTP service (used by `serve` and Electron).
 *
 * @param {{ root?: string, host?: string, port?: number, runsDir?: string, configDir?: string }} [options]
 */
export async function startWeb({ root = ROOT, host = '127.0.0.1', port = 7080, runsDir, configDir } = {}) {
  const service = createService({ root, runsDir, configDir });
  const handle = await startServer({ service, uiDir: path.join(root, 'src/ui'), host, port });
  return { ...handle, service };
}
