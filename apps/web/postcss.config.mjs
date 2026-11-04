/**
 * Tailwind, added for the public landing only.
 *
 * The product's screens are hand-written CSS in `app/globals.css`, and six gate tests read that file as
 * text — contrast, the three responsive suites, semantics and the Inbox's thread width. Tailwind is
 * therefore introduced with its reset left out: `globals.css` imports the theme and utility layers and
 * **not** `preflight.css`, so no existing screen changes. The landing uses utilities; everything already
 * shipped keeps the rules those gates measure.
 *
 * The trade is stated rather than hidden: utility classes on the landing are invisible to the gates that
 * parse `globals.css`. Its colours therefore stay tokens declared in that file, so the contrast gate can
 * still compute them, and its narrow-width behaviour is checked in a browser instead.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
