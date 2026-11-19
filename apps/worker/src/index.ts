/**
 * Normalization worker entry point. BullMQ consumers are registered once
 * webhook deliveries are stored durably.
 */
export function describeWorker(): string {
  return "signaltrail-worker: idle (no queues registered)";
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  console.log(describeWorker());
}
