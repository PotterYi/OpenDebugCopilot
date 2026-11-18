import { parentPort, workerData } from 'node:worker_threads';
import { scanFiles } from './source-scan.mjs';

try {
  const result = await scanFiles(workerData);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error?.message ?? String(error) });
}
