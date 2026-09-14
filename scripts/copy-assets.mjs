import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const assets = [['src/store/schema.sql', 'dist/store/schema.sql']];
for (const [from, to] of assets) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
