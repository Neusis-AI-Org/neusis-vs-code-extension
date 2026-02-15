/**
 * Generate app-icon.png from app-icon.svg
 * Usage: bun run scripts/generate-png.ts
 *
 * Requires @resvg/resvg-js: bun add -d @resvg/resvg-js
 * Or open scripts/generate-app-icon.html in a browser and download from there.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

async function main() {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const svgPath = join(import.meta.dir, '..', 'assets', 'app-icon.svg');
    const svgData = readFileSync(svgPath, 'utf-8');

    const resvg = new Resvg(svgData, {
      fitTo: { mode: 'width', value: 512 },
    });

    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    const outPath = join(import.meta.dir, '..', 'assets', 'app-icon.png');
    writeFileSync(outPath, pngBuffer);
    console.log(`Generated ${outPath} (${pngBuffer.length} bytes)`);
  } catch (e: any) {
    if (e.code === 'MODULE_NOT_FOUND' || e.message?.includes('Cannot find')) {
      console.log('');
      console.log('@resvg/resvg-js not installed. To generate the PNG:');
      console.log('');
      console.log('  Option 1: bun add -d @resvg/resvg-js && bun run scripts/generate-png.ts');
      console.log('  Option 2: Open scripts/generate-app-icon.html in a browser and click Download');
      console.log('');
    } else {
      throw e;
    }
  }
}

main();
