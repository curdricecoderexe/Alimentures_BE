const admin = require('../lib/firebaseAdmin');
const db = require("../config/firebase");
const log = require("../lib/logger");
const { LIMITS } = require("../config/constants");
const { createAuditLog } = require("../services/auditService");
const { requestSiteRebuild } = require("../services/siteRebuild");
const { slugify, buildSlugMap } = require("../lib/slug");
const { validateVariantShipping, normaliseVariantShipping } = require("../services/packageService");

const audit = (req, action, resourceId, previousState, newState) => createAuditLog({
  adminId: req.user?.uid,
  adminEmail: req.user?.email || 'unknown',
  action,
  resourceId,
  previousState: previousState || null,
  newState: newState || null,
  ipAddress: req.ip,
});

// Fields writable via the product create/update APIs (mass-assignment defence).
const WRITABLE_FIELDS = [
  'title', 'name', 'slug', 'sku', 'category', 'description', 'secondaryDescription',
  'price', 'stock', 'variants', 'image', 'secondaryImage', 'images',
  'isFeatured', 'isDraft', 'isPrivate', 'tags', 'nutrition', 'ingredients', 'weight',
  'discountPercent', 'badges', 'origin', 'shelfLife',
  'tertiaryImage', 'cleanPromises', 'cleanBadges', 'nutritionFacts',
  'seoTitle', 'seoDescription', // optional SEO overrides (storefront derives them otherwise)
  'hsn', 'gstRate', // tax data sent to Shiprocket invoices / e-way bills
];

const SKU_RE = /^[A-Za-z0-9._/-]{1,50}$/;
const HSN_RE = /^\d{4,8}$/;
const GST_RATES = [0, 5, 12, 18, 28];

// Fields never exposed on a public (non-staff) product read.
const INTERNAL_FIELDS = ['cost', 'costPrice', 'margin', 'supplier', 'supplierNotes', 'internalNotes', 'notes'];

const isStaff = (req) => ['admin', 'staff'].includes(req.user?.role);

const pickWritable = (body) => {
  const out = {};
  for (const k of WRITABLE_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return out;
};

// ─── public serialisation ─────────────────────────────────────────────────────
// Photos are stored inline (base64) on the product doc. Public responses carry a
// short, cacheable URL to GET /products/:id/image/:slot instead, which keeps the
// catalogue JSON tiny (it was ~1.4 MB with the images embedded).
const IMAGE_SLOTS = { main: 'image', alt: 'secondaryImage', nutrition: 'tertiaryImage' };
const PUBLIC_STOCK_CAP = 10; // enough for "Only N left" + qty limits; hides real inventory

const tsMillis = (t) => (t?.toMillis ? t.toMillis() : t?._seconds ? t._seconds * 1000 : (t ? new Date(t).getTime() || 0 : 0));
const toIso = (t) => { const ms = tsMillis(t); return ms ? new Date(ms).toISOString() : null; };

/** Public origin for image URLs: API_PUBLIC_URL in production, else this request's own origin. */
const publicBase = (req) => (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** URL for one stored product photo (unchanged if it is already a URL). */
function publicImageUrl(base, id, product, slot) {
  const src = product[IMAGE_SLOTS[slot]];
  if (typeof src !== 'string' || !src) return src || '';
  if (!src.startsWith('data:')) return src;
  return `${base}/api/products/${encodeURIComponent(id)}/image/${slot}?v=${tsMillis(product.updatedAt) || 0}`;
}

const publicProduct = (obj, base) => {
  const copy = { ...obj };
  for (const f of INTERNAL_FIELDS) delete copy[f];
  delete copy.isDraft;
  delete copy.isPrivate;
  if (base) for (const slot of Object.keys(IMAGE_SLOTS)) {
    if (copy[IMAGE_SLOTS[slot]]) copy[IMAGE_SLOTS[slot]] = publicImageUrl(base, obj.id, obj, slot);
  }
  if (copy.stock !== undefined) copy.stock = Math.min(Number(copy.stock) || 0, PUBLIC_STOCK_CAP);
  if (Array.isArray(copy.variants)) {
    copy.variants = copy.variants.map((v) => ({ ...v, stock: Math.min(Number(v.stock) || 0, PUBLIC_STOCK_CAP) }));
  }
  if (copy.createdAt) copy.createdAt = toIso(copy.createdAt);
  if (copy.updatedAt) copy.updatedAt = toIso(copy.updatedAt);
  return withSlug(copy); // previousSlugs stays public: the storefront build 301s them
};

// Product lists (cards) only need the main image; the details page reads the
// other photos from GET /products/:id.
const LIST_ONLY_OMIT = ['secondaryImage', 'tertiaryImage', 'images'];
const publicListProduct = (obj, base) => {
  const copy = publicProduct(obj, base);
  for (const f of LIST_ONLY_OMIT) delete copy[f];
  return copy;
};

// --- In-Memory Search Cache ---
let productCache = [];
let cacheTimestamp = 0;
let slugMap = new Map(); // product id -> canonical URL slug, rebuilt with the cache

/** Attach the canonical URL slug (see lib/slug.js) to a product object. */
const withSlug = (p) => ({ ...p, slug: slugMap.get(p.id) || slugify(p.slug || p.title || p.name) || p.id });
// Short TTL: cached products carry stock ("Sold out"), which orders change
// without invalidating the cache.
const CACHE_TTL = 60 * 1000;

const SEARCH_CACHE_LIMIT = 2000; // beyond this the catalogue needs a real search service

const refreshCache = async () => {
  try {
    const snapshot = await db.collection("products")
      .orderBy("createdAt", "desc")
      .limit(SEARCH_CACHE_LIMIT)
      .get();
    // Cache products; visibility is filtered per-request in searchProducts.
    productCache = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    slugMap = buildSlugMap(productCache);
    cacheTimestamp = Date.now();
  } catch (err) {
    log.error("product.cache_refresh_failed", { err });
  }
};

/** For other controllers (categories): the cached catalogue, refreshed if stale. */
exports.getCachedProducts = async () => {
  if (Date.now() - cacheTimestamp > CACHE_TTL || productCache.length === 0) await refreshCache();
  return productCache;
};

/** Force the next read to hit Firestore (e.g. after a bulk category rename). */
exports.invalidateProductCache = () => { cacheTimestamp = 0; };

/** For the search controller etc.: attach `slug` to an outgoing product. */
exports.withSlug = (p) => withSlug(p);

// Levenshtein distance for typo tolerance
const levenshtein = (a, b) => {
  const matrix = Array(a.length + 1).fill().map(() => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
};

exports.searchProducts = async (req, res) => {
  try {
    const base = publicBase(req);
    if (Date.now() - cacheTimestamp > CACHE_TTL || productCache.length === 0) {
      await refreshCache();
    }

    const { 
      q = "", 
      category = "", 
      minPrice, 
      maxPrice, 
      inStockOnly, 
      sort = "relevance", 
      page = 1, 
      limit = 12 
    } = req.query;

    const staff = isStaff(req);
    let results = productCache.filter(p => staff || (p.isDraft !== true && p.isPrivate !== true));

    // 1. Normalize Query & Text Search (length-capped to bound fuzzy-match CPU)
    const query = String(q).slice(0, 80).trim().toLowerCase().replace(/\s+/g, ' ');
    
    if (query) {
      // Calculate scores for ranking
      results = results.map(p => {
        const title = (p.title || p.name || "").toLowerCase();
        const cat = (p.category || "").toLowerCase();
        let score = 0;

        // Exact match
        if (title === query) score += 100;
        // Prefix match
        else if (title.startsWith(query)) score += 50;
        // Includes match
        else if (title.includes(query)) score += 20;
        // Category match
        else if (cat === query) score += 15;
        // Typo tolerance (fuzzy)
        else {
          const words = title.split(" ");
          for (let word of words) {
            if (Math.abs(word.length - query.length) <= 2) {
              const dist = levenshtein(word, query);
              if (dist <= 1 && word.length > 3) score += 10;
              else if (dist <= 2 && word.length > 5) score += 5;
            }
          }
        }
        return { ...p, _score: score };
      }).filter(p => p._score > 0);
    } else {
      results = results.map(p => ({ ...p, _score: 1 })); // Default score
    }

    // 2. Filters
    if (category && category !== 'All') {
      const wanted = String(category).trim().toLowerCase();
      results = results.filter(p => (p.category || '').trim().toLowerCase() === wanted);
    }

    if (minPrice !== undefined && !isNaN(minPrice) && minPrice >= 0) {
      results = results.filter(p => (p.price || 0) >= Number(minPrice));
    }

    if (maxPrice !== undefined && !isNaN(maxPrice) && maxPrice >= 0) {
      results = results.filter(p => (p.price || 0) <= Number(maxPrice));
    }

    if (inStockOnly === 'true') {
      results = results.filter(p => {
        const stock = p.stock !== undefined ? p.stock : (p.variants ? p.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0) : 0);
        return stock > 0;
      });
    }

    // 3. Sorting
    results.sort((a, b) => {
      if (sort === 'relevance' && query) {
        return b._score - a._score;
      }
      if (sort === 'price_low_high') return (a.price || 0) - (b.price || 0);
      if (sort === 'price_high_low') return (b.price || 0) - (a.price || 0);
      if (sort === 'newest') return (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0);
      if (sort === 'name') return (a.title || a.name || "").localeCompare(b.title || b.name || "");
      // Default: relevance/score then newest
      if (b._score !== a._score) return b._score - a._score;
      return (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0);
    });

    // 4. Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10)));
    const startIndex = (pageNum - 1) * limitNum;
    const paginated = results.slice(startIndex, startIndex + limitNum);

    // Track Analytics (only if page=1 and query exists)
    if (query && pageNum === 1) {
      db.collection('search_analytics').add({
        query,
        resultCount: results.length,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      }).catch(err => console.error("Search analytics failed:", err));
    }

    // Remove internal score; strip internal fields for non-staff callers
    const finalData = paginated.map(p => {
      const copy = { ...p };
      delete copy._score;
      return staff ? withSlug(copy) : publicListProduct(copy, base);
    });

    return res.status(200).json({
      success: true,
      count: finalData.length,
      totalCount: results.length,
      hasMore: startIndex + limitNum < results.length,
      page: pageNum,
      data: finalData
    });
  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ success: false, error: "Search failed" });
  }
};

const validateProduct = (data, isUpdate = false) => {
  const fields = ['title', 'category', 'description'];
  
  for (let field of fields) {
    if (!isUpdate && !data[field]) return `${field} is required`;
  }

  // Check Base Price/Stock
  if (data.stock !== undefined && Number(data.stock) < 0) return "Stock cannot be negative";
  if (data.price !== undefined && Number(data.price) < 0) return "Price cannot be negative";

  if (data.hsn != null && data.hsn !== '' && !HSN_RE.test(String(data.hsn).trim())) return "HSN code must be 4–8 digits";
  if (data.gstRate != null && data.gstRate !== '' && !GST_RATES.includes(Number(data.gstRate))) {
    return `GST rate must be one of ${GST_RATES.join(', ')}%`;
  }

  // Check Variants
  if (data.variants && Array.isArray(data.variants)) {
    const skus = new Set();
    for (let variant of data.variants) {
      if (variant.sku != null && variant.sku !== '') {
        const sku = String(variant.sku).trim();
        if (!SKU_RE.test(sku)) return `SKU for ${variant.weight} may only use letters, digits and . _ / - (max 50)`;
        if (skus.has(sku.toUpperCase())) return `SKU "${sku}" is used by two variants`;
        skus.add(sku.toUpperCase());
      }
      if (variant.price !== undefined && Number(variant.price) < 0) return `Variant price for ${variant.weight} cannot be negative`;
      if (variant.stock !== undefined && Number(variant.stock) < 0) return `Variant stock for ${variant.weight} cannot be negative`;
      if (variant.mrp != null && variant.mrp !== '' && !(Number(variant.mrp) > Number(variant.price || 0))) {
        return `MRP for ${variant.weight} must be higher than its selling price`;
      }
      const shipErr = validateVariantShipping(variant);
      if (shipErr) return shipErr;
    }
  }

  if (!isUpdate && (!data.variants || !Array.isArray(data.variants) || data.variants.length === 0)) {
    if (data.price === undefined) return "Price or Variants required";
  }

  return null;
};
const sanitizeData = (data) => {
  const sanitized = { ...data };
  if (sanitized.title) sanitized.title = sanitized.title.trim();
  if (sanitized.category) sanitized.category = sanitized.category.trim();
  if (sanitized.description) sanitized.description = sanitized.description.trim();
  // Packed weight / L×B×H per variant drive the Shiprocket parcel (packageService).
  if (Array.isArray(sanitized.variants)) {
    sanitized.variants = sanitized.variants.map((v) => {
      const out = normaliseVariantShipping(v);
      const sku = typeof v.sku === 'string' ? v.sku.trim() : '';
      if (sku) out.sku = sku; else delete out.sku;
      return out;
    });
  }
  if (sanitized.hsn !== undefined) sanitized.hsn = sanitized.hsn === '' || sanitized.hsn == null ? '' : String(sanitized.hsn).trim();
  if (sanitized.gstRate !== undefined) sanitized.gstRate = sanitized.gstRate === '' || sanitized.gstRate == null ? null : Number(sanitized.gstRate);
  return sanitized;
};
exports.createProduct = async (req, res) => {
  try {
    const error = validateProduct(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const cleanData = sanitizeData(pickWritable(req.body));

    const productData = {
      ...cleanData,
      isFeatured: Boolean(cleanData.isFeatured),
      isDraft: Boolean(cleanData.isDraft),
      isPrivate: Boolean(cleanData.isPrivate),
      price: cleanData.price ? Number(cleanData.price) : 0,
      stock: cleanData.stock !== undefined ? Number(cleanData.stock) : 0,
      variants: Array.isArray(cleanData.variants) ? cleanData.variants : [],
      image: cleanData.image || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const doc = await db.collection("products").add(productData);
    cacheTimestamp = 0; // invalidate search cache
    requestSiteRebuild('product created');
    audit(req, 'CREATE_PRODUCT', doc.id, null, { title: productData.title || productData.name });

    return res.status(201).json({ success: true, id: doc.id });
  } catch (err) {
    log.error("product.create_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
exports.getProducts = async (req, res) => {
  try {
    const base = publicBase(req);
    const staff = isStaff(req);
    const limit = Math.min(LIMITS.LIST_LIMIT_MAX, Math.max(1, Number(req.query.limit) || 10));
    const { lastId } = req.query;

    // Non-staff callers may request more from Firestore since drafts/private are
    // filtered out afterwards; over-fetch a little then trim.
    // Public first page: serve from the in-memory catalogue cache instead of a
    // multi-MB Firestore read on every storefront visit.
    if (!staff && !lastId) {
      if (Date.now() - cacheTimestamp > CACHE_TTL || productCache.length === 0) await refreshCache();
      const products = productCache
        .filter(p => p.isDraft !== true && p.isPrivate !== true)
        .slice(0, limit)
        .map((p) => publicListProduct(p, base));
      return res.status(200).json({
        success: true,
        count: products.length,
        lastId: products.length > 0 ? products[products.length - 1].id : null,
        data: products
      });
    }

    const fetchLimit = staff ? limit : Math.min(LIMITS.LIST_LIMIT_MAX, limit * 2);
    let query = db.collection("products").orderBy("createdAt", "desc").limit(fetchLimit);

    if (lastId) {
      const lastDoc = await db.collection("products").doc(lastId).get();
      if (lastDoc.exists) query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    let products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (!staff) {
      products = products
        .filter(p => p.isDraft !== true && p.isPrivate !== true)
        .slice(0, limit)
        .map((p) => publicListProduct(p, base));
    } else {
      products = products.map(withSlug);
    }

    return res.status(200).json({
      success: true,
      count: products.length,
      lastId: products.length > 0 ? products[products.length - 1].id : null,
      data: products
    });
  } catch (err) {
    log.error("product.list_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Failed to fetch products" });
  }
};

exports.getLowStockProducts = async (req, res) => {
  try {
    // Bounded scan — a catalogue larger than this needs a maintained
    // `totalStock` field + an inequality query instead.
    const snapshot = await db.collection("products")
      .select("title", "name", "stock", "variants", "image")
      .limit(1000)
      .get();
    const lowStock = [];
    
    snapshot.forEach(doc => {
      const p = doc.data();
      const totalStock = p.stock !== undefined ? p.stock : (p.variants ? p.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0) : 0);
      const lowVariants = (p.variants || []).filter(v => Number(v.stock) < 10);
      
      if (totalStock < 10 || lowVariants.length > 0) {
        lowStock.push({
          id: doc.id,
          title: p.title || p.name || 'Unknown Product',
          stock: totalStock,
          isVariantLow: lowVariants.length > 0 && totalStock >= 10,
          lowVariantCount: lowVariants.length,
          image: p.image
        });
      }
    });

    // Sort by most critical
    lowStock.sort((a, b) => a.stock - b.stock);

    return res.status(200).json({
      success: true,
      data: lowStock.slice(0, 10) // Return top 10 most critical
    });
  } catch (err) {
    console.error("Failed to fetch low stock:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch low stock" });
  }
};
/**
 * Resolve a product URL key — a Firestore id, the current slug, or a slug the
 * product had before a rename — to its document.
 */
const findProductDoc = async (key) => {
  if (Date.now() - cacheTimestamp > CACHE_TTL || productCache.length === 0) await refreshCache();
  const k = String(key);
  let id = null;
  for (const [pid, slug] of slugMap) if (slug === k) { id = pid; break; }
  if (!id) id = productCache.find((p) => Array.isArray(p.previousSlugs) && p.previousSlugs.includes(k))?.id || null;
  const doc = await db.collection("products").doc(id || k).get();
  return doc.exists ? doc : null;
};

exports.getProductById = async (req, res) => {
  try {
    const doc = await findProductDoc(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: "Product not found" });

    const data = withSlug({ id: doc.id, ...doc.data() });

    if (!isStaff(req)) {
      if (data.isDraft === true || data.isPrivate === true) {
        return res.status(404).json({ success: false, error: "Product not found" });
      }
      return res.status(200).json({ success: true, data: publicProduct(data, publicBase(req)) });
    }

    return res.status(200).json({ success: true, data });
  } catch (err) {
    log.error("product.get_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const error = validateProduct(req.body, true);
    if (error) return res.status(400).json({ success: false, error });

    const updates = sanitizeData(pickWritable(req.body));
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    if (updates.price !== undefined) updates.price = Number(updates.price);
    if (updates.stock !== undefined) updates.stock = Number(updates.stock);
    if (updates.isFeatured !== undefined) updates.isFeatured = Boolean(updates.isFeatured);
    if (updates.isDraft !== undefined) updates.isDraft = Boolean(updates.isDraft);
    if (updates.isPrivate !== undefined) updates.isPrivate = Boolean(updates.isPrivate);

    const docRef = db.collection("products").doc(id);
    const existing = await docRef.get();

    if (!existing.exists) return res.status(404).json({ success: false, error: "Product not found" });

    const before = existing.data();
    // A rename changes the URL slug — keep the old one so its links still resolve.
    if (Date.now() - cacheTimestamp > CACHE_TTL || productCache.length === 0) await refreshCache();
    const oldSlug = slugMap.get(id) || slugify(before.slug || before.title || before.name);
    const newBase = slugify(updates.slug || before.slug || updates.title || before.title || updates.name || before.name);
    const sameSlug = oldSlug === newBase || oldSlug === `${newBase}-${String(id).slice(0, 6).toLowerCase()}`;
    if (oldSlug && newBase && !sameSlug) {
      updates.previousSlugs = admin.firestore.FieldValue.arrayUnion(oldSlug);
    }
    await docRef.update(updates);
    cacheTimestamp = 0; // Invalidate cache
    requestSiteRebuild('product updated');
    audit(req, 'UPDATE_PRODUCT', id,
      { price: before.price, stock: before.stock, isDraft: before.isDraft, isPrivate: before.isPrivate },
      { price: updates.price, stock: updates.stock, isDraft: updates.isDraft, isPrivate: updates.isPrivate });
    return res.status(200).json({ success: true, message: "Product updated" });
  } catch (err) {
    log.error("product.update_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Update failed" });
  }
};
exports.deleteProduct = async (req, res) => {
  try {
    const docRef = db.collection("products").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ success: false, error: "Not found" });

    await docRef.delete();
    cacheTimestamp = 0; // Invalidate cache
    requestSiteRebuild('product deleted');
    audit(req, 'DELETE_PRODUCT', req.params.id, { title: doc.data().title || doc.data().name }, null);
    return res.status(200).json({ success: true, message: "Product deleted" });
  } catch (err) {
    log.error("product.delete_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Delete failed" });
  }
};

/**
 * PATCH /products/:id/stock  (staff) — Body: { adjustment, weight? }
 * Transactional. A product with more than one variant REQUIRES `weight` to
 * say which pack size is being adjusted — silently guessing one would corrupt
 * the others. `stock` (the aggregate total every list/dashboard reads) is
 * always kept in sync with the variants array.
 */
exports.updateProductStock = async (req, res) => {
  try {
    const { id } = req.params;
    const adjustment = Number(req.body.adjustment);
    const weight = typeof req.body.weight === 'string' ? req.body.weight : null;

    if (!Number.isFinite(adjustment) || adjustment === 0) {
      return res.status(400).json({ success: false, error: "A non-zero adjustment quantity is required" });
    }

    const docRef = db.collection("products").doc(id);

    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(docRef);
      if (!doc.exists) throw new Error("NOT_FOUND");
      const data = doc.data();
      const variants = Array.isArray(data.variants) ? data.variants.map((v) => ({ ...v })) : [];

      if (variants.length > 0) {
        if (!weight && variants.length > 1) throw new Error("WEIGHT_REQUIRED");
        const idx = weight ? variants.findIndex((v) => v.weight === weight) : 0;
        if (idx === -1) throw new Error("VARIANT_NOT_FOUND");
        const next = Number(variants[idx].stock || 0) + adjustment;
        if (next < 0) throw new Error("NEGATIVE");
        variants[idx].stock = next;
        t.update(docRef, {
          variants,
          stock: admin.firestore.FieldValue.increment(adjustment),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { newStock: next, variant: variants[idx].weight };
      }

      const next = Number(data.stock || 0) + adjustment;
      if (next < 0) throw new Error("NEGATIVE");
      t.update(docRef, { stock: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { newStock: next };
    });

    cacheTimestamp = 0;
    audit(req, 'ADJUST_STOCK', id, null, { adjustment, ...result });
    return res.status(200).json({ success: true, message: "Stock updated successfully", ...result });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Product not found" });
    if (err.message === "VARIANT_NOT_FOUND") return res.status(400).json({ success: false, error: "Variant not found" });
    if (err.message === "WEIGHT_REQUIRED") return res.status(400).json({ success: false, error: "This product has multiple pack sizes — choose one to adjust" });
    if (err.message === "NEGATIVE") return res.status(400).json({ success: false, error: "Stock cannot go negative" });
    log.error("product.stock_update_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Failed to update stock" });
  }
};

// GET /products/:id/image/:slot  (public) — one product photo as a real image
// file, decoded from the stored base64. URLs carry ?v=<updatedAt>, so a given
// URL never changes content and can be cached for a year.
const imageCache = new Map(); // `${id}:${slot}:${v}` -> { type, buf }
const IMAGE_CACHE_MAX = 200;

exports.getProductImage = async (req, res) => {
  try {
    const { id, slot } = req.params;
    const field = IMAGE_SLOTS[slot];
    if (!field || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(404).end();

    if (Date.now() - cacheTimestamp > CACHE_TTL || productCache.length === 0) await refreshCache();
    let product = productCache.find((p) => p.id === id);
    if (!product) {
      const doc = await db.collection("products").doc(id).get();
      product = doc.exists ? { id: doc.id, ...doc.data() } : null;
    }
    if (!product || product.isDraft === true || product.isPrivate === true) return res.status(404).end();

    const src = product[field];
    if (typeof src !== 'string' || !src) return res.status(404).end();
    if (!src.startsWith('data:')) return res.redirect(302, src);

    const version = String(tsMillis(product.updatedAt) || 0);
    const key = `${id}:${slot}:${version}`;
    let hit = imageCache.get(key);
    if (!hit) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(src);
      if (!m) return res.status(404).end();
      hit = { type: m[1].toLowerCase(), buf: Buffer.from(m[2], 'base64') };
      if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
      imageCache.set(key, hit);
    }

    const etag = `"${key}"`;
    const immutable = req.query.v === version;
    res.set({
      'Content-Type': hit.type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      ETag: etag,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.send(hit.buf);
  } catch (err) {
    log.error("product.image_failed", { requestId: req.id, err });
    return res.status(500).end();
  }
};

exports.publicImageUrl = publicImageUrl;
exports.publicBase = publicBase;
exports.PUBLIC_STOCK_CAP = PUBLIC_STOCK_CAP;

