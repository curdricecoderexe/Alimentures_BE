'use strict';

/**
 * Every customisable background image slot in the storefront.
 * `key` is the Firestore doc id under `appearanceAssets` and the field the
 * frontend reads. Anything not in this list is rejected by the API.
 */
const APPEARANCE_SLOTS = [
  {
    key: 'authBg',
    label: 'Auth brand panel',
    group: 'Authentication',
    hint: 'The berry panel behind Login, Register and the password screens.',
    ratio: '4 / 5',
  },
  {
    key: 'featuredBg',
    label: 'Featured Products',
    group: 'Homepage sections',
    hint: 'Backdrop of the “Featured products” section.',
    ratio: '16 / 9',
  },
  {
    key: 'craftingBg',
    label: 'Crafting Grains Into Gold',
    group: 'Homepage sections',
    hint: 'Backdrop of the “0% pledge” section.',
    ratio: '16 / 9',
  },
  {
    key: 'superGrainsBg',
    label: 'Powered by Ancient Super Grains',
    group: 'Homepage sections',
    hint: 'Backdrop of the nutritional-blueprint section.',
    ratio: '16 / 9',
  },
  {
    key: 'commitmentBg',
    label: 'Our Commitment',
    group: 'Homepage sections',
    hint: 'Texture inside the closing dark statement panel.',
    ratio: '16 / 9',
  },
  {
    key: 'catalogAllBg',
    label: 'Catalog — All Products',
    group: 'Catalog categories',
    hint: 'Band behind the “Traditional Nourishment Catalog” heading.',
    ratio: '21 / 9',
  },
  {
    key: 'catalogCookiesBg',
    label: 'Catalog — Cookies',
    group: 'Catalog categories',
    hint: 'Band behind the Cookies row header.',
    ratio: '21 / 9',
  },
  {
    key: 'catalogHealthMixturesBg',
    label: 'Catalog — Health Mixtures',
    group: 'Catalog categories',
    hint: 'Band behind the Health Mixtures row header.',
    ratio: '21 / 9',
  },
  {
    key: 'catalogHoneyBg',
    label: 'Catalog — Honey',
    group: 'Catalog categories',
    hint: 'Band behind the Honey row header.',
    ratio: '21 / 9',
  },
  {
    key: 'catalogJaggeryBg',
    label: 'Catalog — Jaggery',
    group: 'Catalog categories',
    hint: 'Band behind the Jaggery row header.',
    ratio: '21 / 9',
  },
];

const APPEARANCE_KEYS = APPEARANCE_SLOTS.map((s) => s.key);
const APPEARANCE_COLLECTION = 'appearanceAssets';

module.exports = { APPEARANCE_SLOTS, APPEARANCE_KEYS, APPEARANCE_COLLECTION };
