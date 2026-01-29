#!/usr/bin/env node

export {};

const args = process.argv.slice(2);

if (args.includes('--server')) {
  await import('./server.js');
} else {
  const { install } = await import('./install.js');
  await install();
}
