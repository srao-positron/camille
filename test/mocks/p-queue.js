// Mock for p-queue
module.exports = class PQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || Infinity;
    this.queue = [];
    this.running = 0;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }

  get size() {
    return this.queue.length;
  }

  clear() {
    this.queue = [];
  }

  async onEmpty() {
    if (this.queue.length === 0) return;
    return new Promise(resolve => {
      const check = () => {
        if (this.queue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  async onIdle() {
    if (this.queue.length === 0 && this.running === 0) return;
    return new Promise(resolve => {
      const check = () => {
        if (this.queue.length === 0 && this.running === 0) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }
};

module.exports.default = module.exports;