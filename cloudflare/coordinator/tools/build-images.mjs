import sharp from 'sharp';
import { stat } from 'node:fs/promises';

// Generates the dashboard's icons from the full-size original in assets/ (which is never served).
// Outputs are committed to public/, as senet does, so a deploy never needs to run sharp; run this by
// hand after changing the artwork: npm run build:images
const SOURCE = 'assets/smith-icon.png';
const OUTPUTS = [
  // The tab icon: browsers ask for a PNG; 64 px stays sharp on high-DPI tab strips.
  { file: 'public/smith-icon.png', size: 64, format: 'png' },
  // The header and sign-in logos are shown at 40-42 CSS px: 84 px covers 2x screens.
  { file: 'public/smith-icon-84.webp', size: 84, format: 'webp' },
];

for (const output of OUTPUTS) {
  const image = sharp(SOURCE).resize(output.size, output.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  await (output.format === 'png'
    ? image.png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
    : image.webp({ quality: 85, alphaQuality: 90, effort: 6 })).toFile(output.file);
  console.log(`${output.file}: ${(await stat(output.file)).size} bytes`);
}
