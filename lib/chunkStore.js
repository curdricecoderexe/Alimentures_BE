'use strict';

/**
 * chunkStore — keep a binary file (PDF, video…) in Firestore without object
 * storage. The bytes are split into sub-1 MB docs `${version}_${i}` under one
 * collection; the caller keeps { version, chunkCount } in its own meta doc.
 * The most recently read file is cached in memory.
 */

const crypto = require('crypto');
const db = require('../config/firebase');

const CHUNK_BYTES = 900 * 1024;
const CHUNKS_PER_BATCH = 8; // keep each commit well under Firestore's 10 MB request cap

module.exports = function chunkStore(collection) {
  const ref = (version, i) => db.collection(collection).doc(`${version}_${i}`);
  let cache = { version: null, buf: null };
  let loading = null;

  /** Write every chunk; returns the new { version, chunkCount }. */
  async function write(buf) {
    const version = crypto.randomBytes(8).toString('hex');
    const chunkCount = Math.ceil(buf.length / CHUNK_BYTES);
    for (let start = 0; start < chunkCount; start += CHUNKS_PER_BATCH) {
      const batch = db.batch();
      for (let i = start; i < Math.min(chunkCount, start + CHUNKS_PER_BATCH); i++) {
        batch.set(ref(version, i), { version, index: i, data: buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
      }
      await batch.commit();
    }
    cache = { version, buf };
    return { version, chunkCount };
  }

  /** Reassemble a stored file (shared in-flight load per version). */
  async function read(version, chunkCount) {
    if (cache.version === version && cache.buf) return cache.buf;
    if (loading && loading.version === version) return loading.promise;
    const promise = (async () => {
      const snaps = await db.getAll(...Array.from({ length: chunkCount }, (_, i) => ref(version, i)));
      const parts = snaps.map((s) => {
        if (!s.exists) throw new Error(`missing chunk ${s.id}`);
        return Buffer.from(s.data().data);
      });
      cache = { version, buf: Buffer.concat(parts) };
      return cache.buf;
    })();
    loading = { version, promise };
    try {
      return await promise;
    } finally {
      loading = null;
    }
  }

  async function remove(version, chunkCount) {
    if (cache.version === version) cache = { version: null, buf: null };
    for (let start = 0; start < chunkCount; start += 400) {
      const batch = db.batch();
      for (let i = start; i < Math.min(chunkCount, start + 400); i++) batch.delete(ref(version, i));
      await batch.commit();
    }
  }

  return { write, read, remove };
};
