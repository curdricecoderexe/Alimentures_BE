/**
 * blogController.js — The Grain Journal (storefront blog).
 *
 * Posts live in the `blog_posts` collection and are written by admin and staff.
 * Body copy is stored as lightweight markup in `content` (see FE
 * src/lib/blogContent.js for the format); React renders it as text, so no HTML
 * is ever stored or injected.
 *
 * Permissions: admin can edit/delete any post; staff can create posts and
 * edit/delete only the posts they created.
 *
 * Dates are stored as ISO strings so they sort and serialise without
 * Firestore Timestamp handling. Queries avoid composite indexes: the journal is
 * small, so filtering/sorting happens in memory.
 */
'use strict';

const memoCache = require('../lib/memoCache');
const db = require('../config/firebase');
const { slugify } = require('../lib/slug');

const COLLECTION = 'blog_posts';
const WORDS_PER_MIN = 200;

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

const readMinsFor = (content = '') => {
  const words = String(content).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MIN));
};

const byNewest = (a, b) =>
  String(b.date || '').localeCompare(String(a.date || '')) ||
  String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/** List-view shape: everything except the (potentially long) body. */
const summary = ({ content, ...rest }) => rest;

// Published posts power /blog and every article page. Cached in memory and
// cleared on any write, so readers cost one Firestore query per 10 minutes.
const PUBLIC_LIMIT = 200;
const publishedCache = memoCache({ ttlMs: 10 * 60 * 1000 });
const publishedPosts = () => publishedCache.get('published', async () => {
  const snap = await db.collection(COLLECTION).where('status', '==', 'published').limit(PUBLIC_LIMIT).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNewest);
});

async function allPosts() {
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** A slug no other post uses (`base`, then `base-2`, `base-3`, ...). */
function uniqueSlug(base, posts, selfId) {
  const taken = new Set(posts.filter((p) => p.id !== selfId).map((p) => p.slug));
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

const canModify = (user, post) =>
  user.role === 'admin' || (post.createdBy && post.createdBy.uid === user.uid);

/** Only one featured post at a time: clear the flag on every other post. */
async function clearOtherFeatured(posts, keepId) {
  const others = posts.filter((p) => p.featured && p.id !== keepId);
  if (!others.length) return;
  const batch = db.batch();
  for (const p of others) batch.update(db.collection(COLLECTION).doc(p.id), { featured: false });
  await batch.commit();
  publishedCache.clear();
}

// ── Public ──────────────────────────────────────────────────────────────────

exports.listPublished = async (req, res) => {
  try {
    const posts = (await publishedPosts()).map(summary);
    return res.status(200).json({ success: true, data: posts });
  } catch (err) {
    console.error('LIST BLOG POSTS ERROR:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch articles' });
  }
};

exports.getPublishedBySlug = async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const post = (await publishedPosts()).find((p) => p.slug === slug) || null;
    if (!post) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }
    return res.status(200).json({ success: true, data: post });
  } catch (err) {
    console.error('GET BLOG POST ERROR:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch article' });
  }
};

// ── Admin / staff ───────────────────────────────────────────────────────────

exports.listAll = async (req, res) => {
  try {
    const posts = (await allPosts()).sort(byNewest);
    return res.status(200).json({ success: true, data: posts });
  } catch (err) {
    console.error('LIST ALL BLOG POSTS ERROR:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch articles' });
  }
};

exports.createPost = async (req, res) => {
  try {
    const b = req.body;
    const posts = await allPosts();
    const base = slugify(b.slug || b.title);
    if (!base) return res.status(400).json({ success: false, error: 'title must contain letters or numbers' });

    const stamp = nowIso();
    const post = {
      slug: uniqueSlug(base, posts),
      title: b.title,
      excerpt: b.excerpt,
      category: b.category,
      content: b.content,
      coverImage: b.coverImage || '',
      author: b.author || req.user.name || 'Team Alimenture',
      featured: Boolean(b.featured),
      status: b.status || 'draft',
      date: b.date || today(),
      readMins: readMinsFor(b.content),
      createdBy: { uid: req.user.uid, name: req.user.name || req.user.email || '', role: req.user.role },
      createdAt: stamp,
      updatedAt: stamp,
    };

    const ref = await db.collection(COLLECTION).add(post);
    publishedCache.clear();
    if (post.featured) await clearOtherFeatured(posts, ref.id);
    return res.status(201).json({ success: true, data: { id: ref.id, ...post } });
  } catch (err) {
    console.error('CREATE BLOG POST ERROR:', err);
    return res.status(500).json({ success: false, error: 'Failed to create article' });
  }
};

exports.updatePost = async (req, res) => {
  try {
    const { id } = req.params;
    const ref = db.collection(COLLECTION).doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ success: false, error: 'Article not found' });
    const current = { id, ...existing.data() };
    if (!canModify(req.user, current)) return res.status(403).json({ success: false, error: 'Forbidden' });

    const b = req.body;
    const updates = {};
    for (const k of ['title', 'excerpt', 'category', 'content', 'author', 'status', 'date']) {
      if (b[k] !== undefined) updates[k] = b[k];
    }
    if (b.coverImage !== undefined) updates.coverImage = b.coverImage;
    if (b.featured !== undefined) updates.featured = Boolean(b.featured);
    if (updates.content !== undefined) updates.readMins = readMinsFor(updates.content);

    const posts = await allPosts();
    if (b.slug !== undefined || updates.title !== undefined) {
      const base = slugify(b.slug || current.slug || updates.title);
      if (base && base !== current.slug) updates.slug = uniqueSlug(base, posts, id);
    }
    updates.updatedAt = nowIso();

    await ref.update(updates);
    publishedCache.clear();
    if (updates.featured) await clearOtherFeatured(posts, id);
    return res.status(200).json({ success: true, data: { ...current, ...updates } });
  } catch (err) {
    console.error('UPDATE BLOG POST ERROR:', err);
    return res.status(500).json({ success: false, error: 'Failed to update article' });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const ref = db.collection(COLLECTION).doc(req.params.id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ success: false, error: 'Article not found' });
    if (!canModify(req.user, existing.data())) return res.status(403).json({ success: false, error: 'Forbidden' });
    await ref.delete();
    publishedCache.clear();
    return res.status(200).json({ success: true, message: 'Article deleted' });
  } catch (err) {
    console.error('DELETE BLOG POST ERROR:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete article' });
  }
};

exports._internal = { readMinsFor, uniqueSlug, canModify };
