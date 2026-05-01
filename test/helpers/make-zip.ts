import yazl from 'yazl';

export function makeZip(files: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) {
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      zip.addBuffer(buf, name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c) => chunks.push(c as Buffer));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}
