/**
 * fakeFirestore.js — a small in-memory stand-in for the Firestore Admin API,
 * covering what the order / payment / reservation code uses: documents,
 * simple queries, transactions, batches and the real FieldValue sentinels
 * (serverTimestamp, increment, delete, arrayUnion, arrayRemove).
 *
 * Not a full emulator — just enough to run the real controllers in tests with
 * no network and no production data.
 */
'use strict';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
let autoId = 0;
const newId = () => `auto${String(++autoId).padStart(6, '0')}`;

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function applyValue(current, value) {
  const kind = value?.constructor?.name;
  if (kind === 'ServerTimestampTransform') return new Date();
  if (kind === 'NumericIncrementTransform') return (Number(current) || 0) + value.operand;
  if (kind === 'ArrayUnionTransform') return [...new Set([...(current || []), ...value.elements])];
  if (kind === 'ArrayRemoveTransform') return (current || []).filter((x) => !value.elements.includes(x));
  return value;
}

/** Apply `data` onto `target`. Dotted keys address nested fields (update semantics). */
function writeFields(target, data, { dotted }) {
  for (const [key, value] of Object.entries(data)) {
    const parts = dotted ? key.split('.') : [key];
    let obj = target;
    for (const p of parts.slice(0, -1)) {
      if (typeof obj[p] !== 'object' || obj[p] === null) obj[p] = {};
      obj = obj[p];
    }
    const leaf = parts[parts.length - 1];
    if (value?.constructor?.name === 'DeleteTransform') { delete obj[leaf]; continue; }
    const isPlain = value && typeof value === 'object' && value.constructor === Object;
    if (isPlain && !dotted) {
      obj[leaf] = typeof obj[leaf] === 'object' && obj[leaf] !== null ? obj[leaf] : {};
      writeFields(obj[leaf], value, { dotted: false });
    } else {
      obj[leaf] = applyValue(obj[leaf], value instanceof Date ? value : clone(value));
    }
  }
}

class DocSnapshot {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._data = data; this.exists = data !== undefined; }
  data() { return clone(this._data); }
  get(field) { return getPath(this._data, field); }
}

class QuerySnapshot {
  constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; }
  forEach(fn) { this.docs.forEach(fn); }
}

class DocRef {
  constructor(store, path) {
    this._store = store;
    this.path = path;
    this.id = path.split('/').pop();
  }
  collection(name) { return new CollectionRef(this._store, `${this.path}/${name}`); }
  async get() { return new DocSnapshot(this, clone(this._store.docs.get(this.path))); }
  async set(data, opts = {}) { this._store.write(this.path, data, opts.merge ? 'merge' : 'set'); }
  async update(data) { this._store.write(this.path, data, 'update'); }
  async create(data) { this._store.write(this.path, data, 'create'); }
  async delete() { this._store.docs.delete(this.path); }
}

class Query {
  constructor(store, collPath, filters = [], order = null, max = Infinity) {
    Object.assign(this, { _store: store, _coll: collPath, _filters: filters, _order: order, _max: max });
  }
  where(field, op, value) { return new Query(this._store, this._coll, [...this._filters, { field, op, value }], this._order, this._max); }
  orderBy(field, dir = 'asc') { return new Query(this._store, this._coll, this._filters, { field, dir }, this._max); }
  limit(n) { return new Query(this._store, this._coll, this._filters, this._order, n); }
  select() { return this; }
  startAfter() { return this; }
  async get() {
    const prefix = `${this._coll}/`;
    let docs = [...this._store.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, d]) => new DocSnapshot(new DocRef(this._store, p), clone(d)));
    const cmp = (a, b) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);
    for (const { field, op, value } of this._filters) {
      docs = docs.filter((s) => {
        const v = getPath(s._data, field);
        switch (op) {
          case '==': return v === value;
          case '!=': return v !== value;
          case '<': return v != null && cmp(v, value) < 0;
          case '<=': return v != null && cmp(v, value) <= 0;
          case '>': return v != null && cmp(v, value) > 0;
          case '>=': return v != null && cmp(v, value) >= 0;
          case 'in': return value.includes(v);
          case 'array-contains': return Array.isArray(v) && v.includes(value);
          default: throw new Error(`fakeFirestore: unsupported op ${op}`);
        }
      });
    }
    if (this._order) {
      const { field, dir } = this._order;
      docs.sort((a, b) => cmp(getPath(a._data, field), getPath(b._data, field)) * (dir === 'desc' ? -1 : 1));
    }
    return new QuerySnapshot(docs.slice(0, this._max));
  }
  count() {
    const query = this;
    return { get: async () => { const { size } = await query.get(); return { data: () => ({ count: size }) }; } };
  }
}

class CollectionRef extends Query {
  constructor(store, path) { super(store, path); this.path = path; this.id = path.split('/').pop(); }
  doc(id) { return new DocRef(this._store, `${this.path}/${id || newId()}`); }
  async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
}

class Transaction {
  constructor(store) { this._store = store; this._writes = []; }
  async get(refOrQuery) { return refOrQuery.get(); }
  set(ref, data, opts = {}) { this._writes.push(() => this._store.write(ref.path, data, opts.merge ? 'merge' : 'set')); return this; }
  update(ref, data) { this._writes.push(() => this._store.write(ref.path, data, 'update')); return this; }
  create(ref, data) { this._writes.push(() => this._store.write(ref.path, data, 'create')); return this; }
  delete(ref) { this._writes.push(() => this._store.docs.delete(ref.path)); return this; }
}

class FakeFirestore {
  constructor() { this.docs = new Map(); }

  write(path, data, mode) {
    const existing = this.docs.get(path);
    if (mode === 'create' && existing !== undefined) {
      const e = new Error('ALREADY_EXISTS: document already exists'); e.code = 6; throw e;
    }
    if (mode === 'update' && existing === undefined) {
      const e = new Error(`NOT_FOUND: no document to update: ${path}`); e.code = 5; throw e;
    }
    const target = mode === 'set' || mode === 'create' ? {} : clone(existing) || {};
    writeFields(target, data, { dotted: mode === 'update' });
    this.docs.set(path, target);
  }

  collection(name) { return new CollectionRef(this, name); }
  doc(path) { return new DocRef(this, path); }
  async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); }

  async runTransaction(fn) {
    const t = new Transaction(this);
    const result = await fn(t);
    for (const w of t._writes) w(); // all-or-nothing: only applied if fn resolved
    return result;
  }

  batch() {
    const ops = [];
    return {
      set: (ref, data, opts = {}) => { ops.push(() => this.write(ref.path, data, opts.merge ? 'merge' : 'set')); },
      update: (ref, data) => { ops.push(() => this.write(ref.path, data, 'update')); },
      delete: (ref) => { ops.push(() => this.docs.delete(ref.path)); },
      commit: async () => { ops.forEach((op) => op()); },
    };
  }

  // test helpers
  seed(path, data) { this.docs.set(path, clone(data)); }
  read(path) { return clone(this.docs.get(path)); }
  list(collection) {
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(`${collection}/`) && p.split('/').length === 2)
      .map(([p, d]) => ({ id: p.split('/')[1], ...clone(d) }));
  }
  reset() { this.docs.clear(); }
}

module.exports = { FakeFirestore };
