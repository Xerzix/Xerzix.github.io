// Declarative request validation. Every write endpoint validates its input with a schema
// built here; unknown keys are dropped so clients cannot set fields they do not own.
//
//   const schema = v.object({ email: v.string().email(), age: v.int().min(13).optional() });
//   const clean = v.parse(schema, await ctx.body());
import { validation } from './errors.js';

class Schema {
  constructor(kind) {
    this.kind = kind;
    this.checks = [];
    this.isOptional = false;
    this.isNullable = false;
    this.defaultValue = undefined;
  }
  optional() { this.isOptional = true; return this; }
  nullable() { this.isNullable = true; return this; }
  default(v) { this.defaultValue = v; this.isOptional = true; return this; }
  check(fn, message) { this.checks.push({ fn, message }); return this; }
  // Subclasses implement coerce(value) -> value or throw string message.
  run(value, path, errors) {
    const key = path || 'value';
    // Blank text counts as "not provided"; for nullable fields it clears the value.
    if (typeof value === 'string' && value.trim() === '') value = this.isNullable ? null : undefined;
    if (value === null) {
      if (this.isNullable) return null;
      value = undefined;
    }
    if (value === undefined) {
      if (this.defaultValue !== undefined) return typeof this.defaultValue === 'function' ? this.defaultValue() : this.defaultValue;
      if (this.isOptional) return undefined;
      errors[key] = 'This field is required.';
      return undefined;
    }
    let out;
    try {
      out = this.coerce(value, path, errors);
    } catch (message) {
      errors[key] = String(message instanceof Error ? message.message : message);
      return undefined;
    }
    for (const { fn, message } of this.checks) {
      if (!fn(out)) {
        errors[key] = message;
        return undefined;
      }
    }
    return out;
  }
}

class StringSchema extends Schema {
  constructor() { super('string'); this._trim = true; }
  coerce(v) {
    if (typeof v !== 'string') throw 'Must be text.';
    let s = this._trim ? v.trim() : v;
    // Strip ASCII control characters except tab/newline.
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return s;
  }
  raw() { this._trim = false; return this; }
  min(n) { return this.check((s) => s.length >= n, `Must be at least ${n} characters.`); }
  max(n) { return this.check((s) => s.length <= n, `Must be at most ${n} characters.`); }
  email() { return this.check((s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254, 'Enter a valid email address.'); }
  url() {
    return this.check((s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    }, 'Enter a valid http(s) URL.');
  }
  pattern(re, message = 'Invalid format.') { return this.check((s) => re.test(s), message); }
  oneOf(values) { return this.check((s) => values.includes(s), `Must be one of: ${values.join(', ')}.`); }
}

class NumberSchema extends Schema {
  constructor(integer) { super('number'); this.integer = integer; }
  coerce(v) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw 'Must be a number.';
    if (this.integer && !Number.isInteger(n)) throw 'Must be a whole number.';
    return n;
  }
  min(n) { return this.check((x) => x >= n, `Must be ${n} or more.`); }
  max(n) { return this.check((x) => x <= n, `Must be ${n} or less.`); }
}

class BooleanSchema extends Schema {
  constructor() { super('boolean'); }
  coerce(v) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    throw 'Must be true or false.';
  }
}

class EnumSchema extends Schema {
  constructor(values) { super('enum'); this.values = values; }
  coerce(v) {
    if (!this.values.includes(v)) throw `Must be one of: ${this.values.join(', ')}.`;
    return v;
  }
}

class ArraySchema extends Schema {
  constructor(item) { super('array'); this.item = item; this.maxItems = 1000; }
  max(n) { this.maxItems = n; return this; }
  min(n) { return this.check((a) => a.length >= n, `Choose at least ${n}.`); }
  unique() { this._unique = true; return this; }
  coerce(v, path, errors) {
    let arr = v;
    if (typeof v === 'string') arr = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(arr)) throw 'Must be a list.';
    if (arr.length > this.maxItems) throw `At most ${this.maxItems} items.`;
    const out = [];
    arr.forEach((item, i) => {
      const r = this.item.run(item, `${path}[${i}]`, errors);
      if (r !== undefined) out.push(r);
    });
    return this._unique ? [...new Set(out)] : out;
  }
}

class ObjectSchema extends Schema {
  constructor(shape) { super('object'); this.shape = shape; }
  coerce(v, path, errors) {
    if (typeof v !== 'object' || Array.isArray(v)) throw 'Must be an object.';
    const out = {};
    for (const [key, schema] of Object.entries(this.shape)) {
      const r = schema.run(v[key], path ? `${path}.${key}` : key, errors);
      if (r !== undefined) out[key] = r;
    }
    return out;
  }
  /** Makes every field optional (for PATCH bodies). */
  partial() {
    const shape = {};
    for (const [k, s] of Object.entries(this.shape)) {
      const copy = Object.assign(Object.create(Object.getPrototypeOf(s)), s);
      copy.isOptional = true;
      copy.defaultValue = undefined;
      shape[k] = copy;
    }
    return new ObjectSchema(shape);
  }
}

class AnySchema extends Schema {
  constructor() { super('any'); }
  coerce(v) { return v; }
}

export const v = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(false),
  int: () => new NumberSchema(true),
  boolean: () => new BooleanSchema(),
  enum: (values) => new EnumSchema(values),
  array: (item) => new ArraySchema(item),
  object: (shape) => new ObjectSchema(shape),
  any: () => new AnySchema(),
  /** Parses and returns the clean value, or throws HTTP 422 with per-field messages. */
  parse(schema, value) {
    const errors = {};
    const out = schema.run(value, '', errors);
    if (Object.keys(errors).length) throw validation(errors);
    return out;
  },
};

export const patterns = {
  id: /^[a-z0-9][a-z0-9_-]{1,79}$/i,
  pin: /^\d{4}$/,
  lang: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/,
  hexColor: /^#[0-9a-fA-F]{6}$/,
  totp: /^\d{6}$/,
};
