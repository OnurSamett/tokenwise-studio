// ICO supports PNG-compressed images (Vista+). Input is resized by build-windows.sh.
import fs from 'node:fs';
const [input, output] = process.argv.slice(2);
const png = fs.readFileSync(input);
if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Expected PNG');
const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
if (!width || !height || width > 256 || height > 256) throw new Error('ICO PNG must be at most 256 × 256');
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header[6] = width === 256 ? 0 : width; header[7] = height === 256 ? 0 : height;
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
fs.writeFileSync(output, Buffer.concat([header, png]));
