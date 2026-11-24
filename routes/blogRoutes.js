const express = require('express');
const router = express.Router();
const {
  listPublished,
  getPublishedBySlug,
  listAll,
  createPost,
  updatePost,
  deletePost,
} = require('../controllers/blogController');

const verifyToken = require('../middlewares/verifyToken');
const isStaff = require('../middlewares/isStaff'); // admin or staff
const { validate } = require('../middlewares/validate');
const imageField = require('../middlewares/imageField');

// Keep in sync with BLOG_CATEGORIES in the frontend (src/data/blog.js).
const CATEGORIES = ['Super grains', 'Recipes', 'Heritage', 'Mindful living', 'Gifting'];

const bodyShape = (required) => ({
  body: {
    title: { type: 'string', trim: true, max: 160, required },
    slug: { type: 'string', trim: true, max: 90 },
    excerpt: { type: 'string', trim: true, max: 320, required },
    category: { type: 'enum', values: CATEGORIES, required },
    content: { type: 'string', trim: true, max: 60_000, required },
    // Firestore documents cap at 1 MB, so the inline cover must stay well under it.
    coverImage: { type: 'string', max: 750_000 },
    author: { type: 'string', trim: true, max: 80 },
    featured: { type: 'boolean' },
    status: { type: 'enum', values: ['draft', 'published'] },
    date: { type: 'string', trim: true, pattern: /^\d{4}-\d{2}-\d{2}$/ },
  },
});

// Public reads (published posts only)
router.get('/', listPublished);

// Admin / staff — declared before '/:slug' so 'manage' is never read as a slug
router.get('/manage/all', verifyToken, isStaff, listAll);
router.post('/', verifyToken, isStaff, validate(bodyShape(true)), imageField(['coverImage']), createPost);
router.put('/:id', verifyToken, isStaff, validate(bodyShape(false)), imageField(['coverImage']), updatePost);
router.delete('/:id', verifyToken, isStaff, deletePost);

router.get('/:slug', getPublishedBySlug);

module.exports = router;
