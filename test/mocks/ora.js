// Mock for ora
class OraMock {
  constructor(options = {}) {
    this.text = typeof options === 'string' ? options : options.text || '';
    this.isSpinning = false;
  }

  start(text) {
    if (text) this.text = text;
    this.isSpinning = true;
    return this;
  }

  stop() {
    this.isSpinning = false;
    return this;
  }

  succeed(text) {
    if (text) this.text = text;
    this.isSpinning = false;
    return this;
  }

  fail(text) {
    if (text) this.text = text;
    this.isSpinning = false;
    return this;
  }

  warn(text) {
    if (text) this.text = text;
    this.isSpinning = false;
    return this;
  }

  info(text) {
    if (text) this.text = text;
    this.isSpinning = false;
    return this;
  }

  clear() {
    return this;
  }
}

module.exports = (options) => new OraMock(options);
module.exports.default = module.exports;