// Copies the IBM Plex font files from node_modules into public/fonts, so
// the app serves its own fonts (works offline - no Google Fonts needed at
// a demo). Run as part of `npm run build:css`.
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '../public/fonts');
fs.mkdirSync(out, { recursive: true });
const files = {
  'ibm-plex-sans': ['latin-400-normal', 'latin-400-italic', 'latin-500-normal', 'latin-600-normal', 'latin-700-normal'],
  'ibm-plex-mono': ['latin-400-normal', 'latin-500-normal'],
};
Object.entries(files).forEach(([family, variants]) => {
  variants.forEach((v) => {
    const name = `${family}-${v}.woff2`;
    fs.copyFileSync(path.join(__dirname, `../node_modules/@fontsource/${family}/files/${name}`), path.join(out, name));
  });
});
console.log('Fonts copied to public/fonts');
