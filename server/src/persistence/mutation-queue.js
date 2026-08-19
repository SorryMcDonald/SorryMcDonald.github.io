const queues = new WeakMap();

export class StoreMutationQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(mutation) {
    const execution = this.tail.catch(() => {}).then(mutation);
    this.tail = execution;
    execution.finally(() => {
      if (this.tail === execution) this.tail = Promise.resolve();
    }).catch(() => {});
    return execution;
  }
}

export function mutationQueueFor(store) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) return new StoreMutationQueue();
  let queue = queues.get(store);
  if (!queue) {
    queue = new StoreMutationQueue();
    queues.set(store, queue);
  }
  return queue;
}
