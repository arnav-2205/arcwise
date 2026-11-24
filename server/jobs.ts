// In-process job queue with progress events. BullMQ on Redis can replace this behind the same API.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

type Job = () => Promise<void>;
const queue: Job[] = [];
let running = 0;
const CONCURRENCY = Number(process.env.ARCWISE_CONCURRENCY ?? 2);

export function enqueue(job: Job) {
  queue.push(job);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    running++;
    job().catch(e => console.error('[job]', e)).finally(() => { running--; pump(); });
  }
}

export const emitUpdate = (id: string) => bus.emit(`update:${id}`);
