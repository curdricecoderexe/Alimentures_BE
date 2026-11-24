'use strict';

/**
 * Every customisable background image slot in the storefront.
 * Slots with a `page` are only served to that page (GET /api/appearance?page=…)
 * so the site-wide map every page loads stays small.
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
    key: 'craftSpotlightBg',
    label: 'Slow-bake Craft — Background',
    group: 'Slow-bake Craft section',
    hint: 'Full-width photo behind the frosted “Slow-bake craft” panel (right after the benefit tiles). Landscape works best.',
    ratio: '16 / 9',
  },
  {
    key: 'craftSpotlightImage',
    label: 'Slow-bake Craft — Product photo',
    group: 'Slow-bake Craft section',
    hint: 'The round product photo with the dotted labels. Square image, product centred.',
    ratio: '1 / 1',
  },
  {
    key: 'catalogueBg',
    label: 'Catalogue download — Background',
    group: 'Catalogue download section',
    hint: 'Full-width photo behind “Download our product catalogue” and its glass form. Landscape; keep the right side calm so the form reads well.',
    ratio: '21 / 10',
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
    label: 'Our Commitment — photo',
    group: 'About page',
    hint: 'Round photo beside the “Our commitment” headline on the About page (text is edited in Admin → About Page). Square works best, subject centred.',
    ratio: '1 / 1',
  },
  {
    key: 'hampersHero',
    label: 'Gift Hampers — Top banner',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Full-width banner at the very top of the Gift Hampers page, shown edge to edge with no text over it. Use a wide landscape image (about 12:5) and keep the subject centred — the sides are trimmed on phones.',
    ratio: '12 / 5',
  },
  {
    key: 'hamper-grainlets-quartet',
    label: 'Hamper photo — The Grainlets Quartet',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Photo on the “The Grainlets Quartet” card in the hamper collection. Landscape (4:3), the hamper centred.',
    ratio: '4 / 3',
  },
  {
    key: 'hamper-festive-harvest',
    label: 'Hamper photo — Festive Harvest',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Photo on the “Festive Harvest” card in the hamper collection. Landscape (4:3), the hamper centred.',
    ratio: '4 / 3',
  },
  {
    key: 'hamper-corporate-thank-you',
    label: 'Hamper photo — The Thank-You Box',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Photo on the “The Thank-You Box” card in the hamper collection. Landscape (4:3), the hamper centred.',
    ratio: '4 / 3',
  },
  {
    key: 'hamper-wellness-ritual',
    label: 'Hamper photo — Wellness Ritual',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Photo on the “Wellness Ritual” card in the hamper collection. Landscape (4:3), the hamper centred.',
    ratio: '4 / 3',
  },
  {
    key: 'hamper-little-joys',
    label: 'Hamper photo — Little Joys',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Photo on the “Little Joys” card in the hamper collection. Landscape (4:3), the hamper centred.',
    ratio: '4 / 3',
  },
  {
    key: 'hamper-heritage-collection',
    label: 'Hamper photo — The Heritage Collection',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Photo on the “The Heritage Collection” card in the hamper collection. Landscape (4:3), the hamper centred.',
    ratio: '4 / 3',
  },
  {
    key: 'grainlet-red-millets-mate',
    label: 'Grainlets — Red Millets Mate',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Round photo in “Meet the Grainlets”, also used as the small thumbnail in “Inside the box” lists. Square, product centred.',
    ratio: '1 / 1',
  },
  {
    key: 'grainlet-penta-bite',
    label: 'Grainlets — Penta Bite',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Round photo in “Meet the Grainlets”, also used as the small thumbnail in “Inside the box” lists. Square, product centred.',
    ratio: '1 / 1',
  },
  {
    key: 'grainlet-tri-grain-gain',
    label: 'Grainlets — Tri-Grain Gain',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Round photo in “Meet the Grainlets”, also used as the small thumbnail in “Inside the box” lists. Square, product centred.',
    ratio: '1 / 1',
  },
  {
    key: 'grainlet-classic-coclets',
    label: 'Grainlets — Classic Coclets',
    group: 'Gift hampers page',
    page: 'hampers',
    hint: 'Round photo in “Meet the Grainlets”, also used as the small thumbnail in “Inside the box” lists. Square, product centred.',
    ratio: '1 / 1',
  },
  {
    key: 'lineupImage1',
    label: 'Alchemi’s — Image 1',
    group: 'Alchemi’s (Clean Snack Lineup)',
    hint: 'Main photo beside “Clean Snack Lineup”. Portrait or square works best.',
    ratio: '4 / 5',
  },
  {
    key: 'lineupImage2',
    label: 'Alchemi’s — Image 2',
    group: 'Alchemi’s (Clean Snack Lineup)',
    hint: 'Optional. With two or more images set, the frame crossfades between them.',
    ratio: '4 / 5',
  },
  {
    key: 'lineupImage3',
    label: 'Alchemi’s — Image 3',
    group: 'Alchemi’s (Clean Snack Lineup)',
    hint: 'Optional third slide for the crossfade.',
    ratio: '4 / 5',
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
