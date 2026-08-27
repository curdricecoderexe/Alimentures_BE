const express = require('express');
const router = express.Router();
const heroSlideController = require('../controllers/heroSlideController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { validate } = require('../middlewares/validate');
const imageField = require('../middlewares/imageField');

const bodyShape = (required) => ({
  body: {
    src: { type: 'string', max: 5_000_000, required },
    title: { type: 'string', trim: true, max: 200 },
    subtitle: { type: 'string', trim: true, max: 300 },
    ctaText: { type: 'string', trim: true, max: 60 },
    ctaLink: { type: 'string', trim: true, max: 300 },
    order: { type: 'integer', min: 0, max: 999 },
  },
});

router.get('/', heroSlideController.getSlides);
router.post('/', verifyToken, isAdmin, validate(bodyShape(true)), imageField(['src']), heroSlideController.createSlide);
router.put('/:id', verifyToken, isAdmin, validate(bodyShape(false)), imageField(['src']), heroSlideController.updateSlide);
router.delete('/:id', verifyToken, isAdmin, heroSlideController.deleteSlide);

module.exports = router;
